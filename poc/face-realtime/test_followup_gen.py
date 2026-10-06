"""8단계 테스트: 꼬리질문 (규칙 + AI 혼합). Ollama를 부르지 않는다. 실행: pytest -q"""
import json
import time

import followup_gen as fg

MAIN = {"type": "경험", "question": "물류 프로젝트에서 맡은 일을 말해 주세요.",
        "evidence": "6개월 동안 팀장을 맡아 배송 지연률을 12% 줄였습니다."}
ANSWER = "저희 팀이 함께 6개월 동안 지연률을 20% 줄였습니다. 우리가 열심히 노력했습니다."
SOFT = "저희 팀이 함께 6개월 동안 지연률을 12% 줄였습니다. 우리가 열심히 노력했습니다."  # 숫자는 맞음


def fake(reply, delay=0.0):
    def ask_fn(client, model, prompt):
        time.sleep(delay)
        if isinstance(reply, Exception):
            raise reply
        return reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
    return ask_fn


def names(main, answer):
    return [n for n, _ in fg.find_issues(main, answer)]


# ── 규칙: 문제를 모두 찾는다 ──
def test_finds_all_issues_in_priority_order():
    assert names(MAIN, ANSWER) == ["mismatch", "no_role", "vague"]


def test_percent_word_counts_as_percent():
    assert "mismatch" not in names(MAIN, "제가 6개월 동안 지연률을 12퍼센트 줄였습니다.")


def test_missing_fact_from_resume():
    issues = fg.find_issues(MAIN, "제가 팀장으로 지연률을 12% 줄였습니다.")
    assert issues[0] == ("missing_fact", {"doc": "6개월"})


def test_no_result_number():
    main = dict(MAIN, evidence="팀장을 맡아 배송 문제를 해결했습니다.")
    assert names(main, "제가 팀장으로 문제를 해결했습니다.") == ["no_result"]


def test_team_heavy_when_self_is_rare():
    main = dict(MAIN, type="직무", evidence="분석 역량이 있습니다.")
    assert names(main, "제가 참여했고 우리 팀이 분석했고 저희가 함께 발표했습니다.") == ["team_heavy"]


def test_same_input_same_issues():
    assert fg.find_issues(MAIN, ANSWER) == fg.find_issues(MAIN, ANSWER)


# ── 정해진 문장 (AI 없이) ──
def test_fact_issue_is_always_chosen():
    out = fg.generate_followup(MAIN, ANSWER, use_llm=False)
    assert out["source"] == "template" and out["reason"] == "mismatch"
    assert "12%" in out["question"] and "20%" in out["question"]
    assert out["issues"] == ["mismatch", "no_role", "vague"]


def test_no_issue_gives_generic():
    main = dict(MAIN, type="직무", evidence="분석 역량이 있습니다.")
    out = fg.generate_followup(main, "제가 직접 분석해서 보고서를 썼습니다.", use_llm=False)
    assert out["reason"] == "generic"


# ── AI가 고름 ──
def pick_label(label, quote, question):
    """프롬프트에서 label의 번호를 찾아 고르는 가짜 AI (목록 순서가 섞여도 동작)"""
    def ask(client, model, prompt):
        n = next(int(l.split(".")[0]) for l in prompt.splitlines() if l.endswith(". " + label) or l[2:].lstrip(". ") == label)
        return json.dumps({"pick": n, "quote": quote, "question": question}, ensure_ascii=False)
    return ask


def test_ai_picks_issue_with_quote():
    ask = pick_label("모호한 표현", "열심히 노력했습니다", "열심히 했다는 건 구체적으로 어떤 행동이었나요?")
    out = fg.generate_followup(MAIN, SOFT, ask_fn=ask)
    assert out["source"] == "exaone" and out["reason"] == "vague"


def test_ai_may_pick_other_point():
    ask = fake({"pick": 0, "quote": "지연률을 12% 줄였습니다", "question": "지연률은 어떻게 측정하셨나요?"})
    out = fg.generate_followup(MAIN, SOFT, ask_fn=ask)
    assert out["source"] == "exaone" and out["reason"] == "ai_other"


def test_prompt_lists_rule_findings():
    seen = {}

    def ask(client, model, prompt):
        seen["p"] = prompt
        return "{}"
    fg.generate_followup(MAIN, SOFT, ask_fn=ask)
    assert "본인이 한 일을 말하지 않음" in seen["p"] and "모호한 표현" in seen["p"]


def test_ai_rejected_cases_fall_back_to_template():
    bad = [
        {"pick": 1, "quote": "저는 혼자 다 했습니다", "question": "정말 혼자 하셨나요?"},       # 답변에 없는 인용
        {"pick": 9, "quote": "저희 팀이 함께", "question": "본인 역할은요?"},                  # 없는 번호
        {"pick": 1, "quote": "저희 팀이 함께", "question": "3개월 만에 어떻게 줄이셨나요?"},   # 없던 숫자
        {"pick": 1, "quote": "저희 팀이 함께", "question": "가" * 61 + "요?"},                 # 너무 김
        {"pick": 1, "quote": "저희 팀이 함께", "question": "팀장이었습니다."},                 # 물음 아님
        "JSON 아님",
    ]
    for reply in bad:
        out = fg.generate_followup(MAIN, SOFT, ask_fn=fake(reply))
        assert out["source"] == "template" and out["reason"] in ("no_role", "vague"), reply


def test_slow_ai_falls_back_within_budget():
    t0 = time.perf_counter()
    out = fg.generate_followup(MAIN, SOFT, ask_fn=fake({"pick": 1}, delay=1.0), budget=0.2)
    assert out["source"] == "template" and "초과" in out["error"]
    assert time.perf_counter() - t0 < 0.8


def test_ollama_off_falls_back(monkeypatch):
    monkeypatch.setattr(fg, "ollama_available", lambda: False)
    out = fg.generate_followup(MAIN, SOFT)
    assert out["source"] == "template" and "Ollama" in out["error"]


def test_empty_answer_skips_ai():
    out = fg.generate_followup(MAIN, "", ask_fn=fake(RuntimeError("부르면 안 됨")))
    assert out["source"] == "template" and out["error"] is None


def test_fact_mismatch_never_goes_to_ai():
    out = fg.generate_followup(MAIN, ANSWER, ask_fn=fake(RuntimeError("부르면 안 됨")))
    assert out["source"] == "template" and out["reason"] == "mismatch" and out["error"] is None


# ── 매번 달라지게 ──
def test_questions_vary_across_runs():
    qs = {fg.generate_followup(MAIN, SOFT, use_llm=False)["question"] for _ in range(30)}
    assert len(qs) >= 3


def test_same_seed_reproduces():
    a = fg.generate_followup(MAIN, SOFT, use_llm=False, seed=7)
    b = fg.generate_followup(MAIN, SOFT, use_llm=False, seed=7)
    assert a == b and a["seed"] == 7


def test_history_avoids_previous_issue():
    prev = fg.generate_followup(MAIN, SOFT, use_llm=False, seed=1)
    for s in range(20):
        out = fg.generate_followup(MAIN, SOFT, use_llm=False, seed=s, history=[prev])
        assert out["key"] != prev["key"]                 # 문제가 2개라 다른 쪽을 물음


def test_history_avoids_previous_wording_when_only_one_issue():
    prev = fg.generate_followup(MAIN, ANSWER, use_llm=False, seed=1)   # 사실 확인 1개뿐
    for s in range(20):
        out = fg.generate_followup(MAIN, ANSWER, use_llm=False, seed=s, history=[prev])
        assert out["reason"] == "mismatch" and out["question"] != prev["question"]


def test_ai_repeating_previous_question_is_rejected():
    q = "열심히 했다는 건 구체적으로 어떤 행동이었나요?"
    ask = pick_label("모호한 표현", "열심히 노력했습니다", q)
    out = fg.generate_followup(MAIN, SOFT, ask_fn=ask, history=[{"question": q, "key": "x"}])
    assert out["source"] == "template" and "전에" in out["error"]


def test_history_roundtrip_without_storing_resume(tmp_path):
    path = tmp_path / "h.json"
    resume = "비밀 자소서 내용입니다."
    out = fg.generate_followup(MAIN, SOFT, use_llm=False)
    fg.save_history(resume, out, path)
    assert fg.load_history(resume, path)[0]["question"] == out["question"]
    assert fg.load_history("다른 자소서", path) == []
    assert "비밀" not in path.read_text(encoding="utf-8")
