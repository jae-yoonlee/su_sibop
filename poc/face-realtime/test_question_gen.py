"""7단계 테스트: 맞춤 질문 생성. Gemini를 부르지 않는다. 실행: pytest -q"""
import json

import question_gen as qg

RESUME = """저는 2024년 3월부터 6개월 동안 물류 데이터 분석 프로젝트의 팀장을 맡았습니다.
배송 지연 원인을 분석해 지연률을 12% 줄였습니다.
팀원과 분석 방법을 두고 의견이 달라 일정이 2주 늦어진 적도 있습니다."""

GOOD = [
    {"type": "경험", "question": "물류 프로젝트에서 팀장으로 맡은 일을 구체적으로 말해 주세요.",
     "evidence": "저는 2024년 3월부터 6개월 동안 물류 데이터 분석 프로젝트의 팀장을 맡았습니다."},
    {"type": "직무", "question": "지연률을 줄인 분석 역량을 직무에 어떻게 쓰실 건가요?",
     "evidence": "배송 지연 원인을 분석해 지연률을 12% 줄였습니다."},
    {"type": "상황", "question": "일정이 늦어졌을 때 어떻게 대응하셨나요?",
     "evidence": "팀원과 분석 방법을 두고 의견이 달라 일정이 2주 늦어진 적도 있습니다."},
]


def fake(replies):
    """순서대로 응답(문자열) 또는 예외를 돌려주는 가짜 ask 함수"""
    calls = []

    def ask_fn(client, model, prompt):
        calls.append(prompt)
        r = replies[min(len(calls), len(replies)) - 1]
        if isinstance(r, Exception):
            raise r
        return r
    return ask_fn, calls


def test_no_resume_uses_defaults_and_sends_nothing():
    ask_fn, calls = fake([json.dumps(GOOD)])
    out = qg.generate_questions("", client=object(), ask_fn=ask_fn)
    assert out["source"] == "default" and not out["sends_outside"]
    assert len(out["questions"]) == 3 and calls == []


def test_good_reply_is_used():
    ask_fn, calls = fake([json.dumps(GOOD, ensure_ascii=False)])
    out = qg.generate_questions(RESUME, "데이터 분석", client=object(), ask_fn=ask_fn)
    assert out["source"] == "gemini" and out["sends_outside"]
    assert [q["type"] for q in out["questions"]] == ["경험", "직무", "상황"]
    assert "데이터 분석" in calls[0] and RESUME in calls[0]


def test_invented_evidence_is_rejected_then_retried():
    bad = [dict(q) for q in GOOD]
    bad[0]["evidence"] = "저는 해외 인턴을 1년 했습니다."          # 자소서에 없는 경험
    ask_fn, calls = fake([json.dumps(bad), json.dumps(GOOD)])
    out = qg.generate_questions(RESUME, client=object(), ask_fn=ask_fn)
    assert out["source"] == "gemini" and len(calls) == 2


def test_evidence_matches_despite_line_breaks():
    resume = RESUME.replace("배송 지연 원인을", "배송 지연\n원인을")
    assert qg.parse_questions(json.dumps(GOOD), resume)[1]["evidence"]


def test_wrong_count_or_order_rejected():
    for bad in (GOOD[:2], [GOOD[1], GOOD[0], GOOD[2]]):
        try:
            qg.parse_questions(json.dumps(bad), RESUME)
            assert False, "통과하면 안 됨"
        except ValueError:
            pass


def test_keeps_failing_falls_back_to_defaults():
    ask_fn, calls = fake([RuntimeError("503 서버 혼잡")])
    out = qg.generate_questions(RESUME, client=object(), ask_fn=ask_fn)
    assert out["source"] == "default" and "503" in out["error"]
    assert out["sends_outside"]                    # 시도는 했으니 밖으로 나간 것은 맞음
    assert len(calls) == 1 + qg.RETRIES


def test_no_api_key_uses_defaults(monkeypatch):
    monkeypatch.setattr(qg, "make_client", lambda: None)
    out = qg.generate_questions(RESUME)
    assert out["source"] == "default" and not out["sends_outside"] and "GEMINI_API_KEY" in out["error"]


def test_exaone_backend_stays_local():
    ask_fn, _ = fake([json.dumps(GOOD)])
    out = qg.generate_questions(RESUME, backend="exaone", ask_fn=ask_fn)
    assert out["source"] == "exaone" and not out["sends_outside"]


def test_exaone_without_ollama_uses_defaults(monkeypatch):
    monkeypatch.setattr(qg, "ollama_available", lambda: False)
    out = qg.generate_questions(RESUME, backend="exaone")
    assert out["source"] == "default" and "Ollama" in out["error"]
