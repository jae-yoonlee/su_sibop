"""8단계 테스트: 꼬리질문. Ollama를 부르지 않는다. 실행: pytest -q"""
import json

import followup_gen as fg

MAIN = {"type": "경험", "question": "물류 프로젝트에서 맡은 일을 말해 주세요.",
        "evidence": "6개월 동안 팀장을 맡아 배송 지연률을 12% 줄였습니다."}


def fake(reply, delay=0.0):
    def ask_fn(client, model, prompt):
        if isinstance(reply, Exception):
            raise reply
        return reply
    return ask_fn


def test_number_mismatch_comes_first():
    reason, q = fg.draft_question(MAIN, "제가 6개월 동안 팀장으로 지연률을 20% 줄였습니다. 열심히 했습니다.")
    assert reason == "mismatch" and "12%" in q and "20%" in q


def test_percent_word_counts_as_percent():
    reason, _ = fg.draft_question(MAIN, "제가 6개월 동안 지연률을 12퍼센트 줄였습니다.")
    assert reason not in ("mismatch", "missing_fact")


def test_missing_fact_from_resume():
    reason, q = fg.draft_question(MAIN, "제가 팀장으로 지연률을 12% 줄였습니다.")
    assert reason == "missing_fact" and "6개월" in q


def test_no_result_number():
    main = dict(MAIN, evidence="팀장을 맡아 배송 문제를 해결했습니다.")
    assert fg.pick_reason(main, "제가 팀장으로 문제를 해결했습니다.")[0] == "no_result"


def test_no_role():
    main = dict(MAIN, type="직무", evidence="분석 역량이 있습니다.")
    assert fg.pick_reason(main, "데이터를 분석해서 개선했습니다.")[0] == "no_role"


def test_vague_quotes_answer():
    main = dict(MAIN, type="직무", evidence="분석 역량이 있습니다.")
    reason, q = fg.draft_question(main, "제가 정말 열심히 했습니다. 그래서 끝냈습니다.")
    assert reason == "vague" and "제가 정말 열심히 했습니다." in q


def test_same_input_same_question():
    a = "제가 팀장으로 열심히 했습니다."
    assert fg.draft_question(MAIN, a) == fg.draft_question(MAIN, a)


def test_template_only_never_calls_llm():
    out = fg.generate_followup(MAIN, "제가 했습니다.", use_llm=False)
    assert out["source"] == "template" and out["question"]


def test_good_rewrite_is_used():
    ask = fake(json.dumps({"question": "자소서의 6개월이라는 기간을 좀 더 설명해 주시겠어요?"}, ensure_ascii=False))
    out = fg.generate_followup(MAIN, "제가 팀장으로 지연률을 12% 줄였습니다.", ask_fn=ask)
    assert out["source"] == "exaone" and out["reason"] == "missing_fact"


def test_rewrite_with_invented_number_is_rejected():
    ask = fake(json.dumps({"question": "3개월 만에 어떻게 줄이셨나요?"}, ensure_ascii=False))
    out = fg.generate_followup(MAIN, "제가 팀장으로 지연률을 12% 줄였습니다.", ask_fn=ask)
    assert out["source"] == "template" and "숫자" in out["error"]


def test_rewrite_too_long_or_not_question_is_rejected():
    for bad in ("가" * 61 + "요?", "6개월 동안 팀장이었습니다."):
        out = fg.generate_followup(MAIN, "제가 12% 줄였습니다.", ask_fn=fake(json.dumps({"question": bad})))
        assert out["source"] == "template"


def test_llm_error_falls_back_to_template():
    out = fg.generate_followup(MAIN, "제가 했습니다.", ask_fn=fake(RuntimeError("연결 끊김")))
    assert out["source"] == "template" and "연결" in out["error"]


def test_ollama_off_falls_back(monkeypatch):
    monkeypatch.setattr(fg, "ollama_available", lambda: False)
    out = fg.generate_followup(MAIN, "제가 했습니다.")
    assert out["source"] == "template" and "Ollama" in out["error"]


def test_over_budget_falls_back(monkeypatch):
    clock = iter([0.0, 10.0])
    monkeypatch.setattr(fg.time, "perf_counter", lambda: next(clock))
    ask = fake(json.dumps({"question": "기간을 더 설명해 주시겠어요?"}, ensure_ascii=False))
    out = fg.generate_followup(MAIN, "제가 12% 줄였습니다.", ask_fn=ask, budget=6.0)
    assert out["source"] == "template" and "초과" in out["error"]
