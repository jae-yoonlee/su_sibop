"""8단계: 꼬리질문 1개 만들기 (이 PC 안에서만, 규칙 + AI 혼합)

메인 질문 3개마다 꼬리질문 1개를 붙인다. 답변 음성은 이 PC의 faster-whisper로 받아 쓰고,
그 글과 메인 질문의 근거 문장(자소서)만으로 꼬리질문을 만든다. 아무것도 밖으로 보내지 않는다.

1) 규칙이 답변의 문제를 '모두' 찾는다 (같은 답변이면 항상 같은 결과 → 검출 정확도를 평가할 수 있음)
   숫자가 자소서와 다름 / 자소서의 숫자를 말하지 않음 / 결과 수치 없음 / 본인 역할 없음 /
   '우리·팀' 위주라 본인 비중이 불분명 / 모호한 표현(사전 단어)
2) 숫자가 자소서와 다르거나 자소서 숫자를 말하지 않았으면 그 사실 확인 질문을 그대로 쓴다 (AI가 주제를 바꾸면 안 됨).
   그 밖에는 EXAONE(Ollama)이 찾은 문제 중 하나를 고르거나(또는 더 중요한 다른 점을 골라) 꼬리질문을 쓴다.
   반드시 답변 속 문장을 그대로 인용하게 하고 코드로 검사한다
   (인용이 답변에 있음, 60자 이내, 존댓말 물음, 답변·자소서에 없는 숫자를 만들지 않음).
3) 시간 안에 못 하거나 검사에 떨어지면 1)의 첫 번째 문제를 정해진 문장 틀로 묻는다 (항상 성공).

휴식 10초 안에 끝내야 하므로 답변 받아쓰기는 답변 도중 쉼마다 조금씩 해 둬야 한다 (coach_engine 쪽 일).
"""
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from question_gen import MODELS, _norm, ask_ollama, ollama_available

TIME_BUDGET = 6.0   # AI에 쓸 최대 시간(초). 휴식 10초에서 받아쓰기 마무리 몫을 뺌
MAX_LEN = 60
ANSWER_CHARS = 800
FACT_CHECKS = {"mismatch", "missing_fact"}  # 자소서 사실 확인은 규칙 질문을 그대로 씀  # AI에 넣는 답변 길이 상한 (2분 답변 ≈ 600~800자)

UNITS = r"(%|퍼센트|프로|개월|년|월|주|일|명|배|건|개|원|시간|분)"
NUM_UNIT = re.compile(r"(\d+(?:[.,]\d+)?)\s*" + UNITS)
UNIT_ALIAS = {"퍼센트": "%", "프로": "%"}
VAGUE = ["열심히", "최선을", "많이 배웠", "노력했", "노력하", "다양한", "여러 가지", "성실하", "잘 해결", "좋은 경험"]
SELF = re.compile(r"(제가|저는|저도|제가요|직접|맡아|맡았|담당)")
TEAM = re.compile(r"(우리|저희|팀이|팀원들이|다 같이|함께)")
RESULT_WORDS = re.compile(r"\d|절반|두\s?배|세\s?배")

TEMPLATES = {
    "mismatch": "자기소개서에는 {doc}라고 쓰셨는데 방금 {said}라고 하셨습니다. 어느 쪽이 맞나요?",
    "missing_fact": "자기소개서에 적은 {doc}에 대해 조금 더 구체적으로 설명해 주시겠어요?",
    "no_result": "그 결과를 숫자로 말씀해 주신다면 어느 정도였나요?",
    "no_role": "그 일에서 본인이 직접 맡은 부분은 무엇이었나요?",
    "team_heavy": "팀 전체 성과 중 본인이 기여한 비중은 어느 정도였나요?",
    "vague": "'{quote}'라고 하셨는데, 구체적으로 어떤 행동을 하셨나요?",
    "generic": "방금 답변에서 가장 어려웠던 점과 그것을 어떻게 해결했는지 말씀해 주세요.",
}
LABELS = {
    "mismatch": "숫자가 자기소개서와 다름",
    "missing_fact": "자기소개서에 적은 숫자를 말하지 않음",
    "no_result": "결과를 숫자로 말하지 않음",
    "no_role": "본인이 한 일을 말하지 않음",
    "team_heavy": "'우리·팀' 위주라 본인 기여 비중이 불분명",
    "vague": "모호한 표현",
}

PROMPT = """너는 한국 기업의 면접관이다. 지원자 답변을 보고 꼬리질문 1개를 만들어라.

메인 질문: {main}
자기소개서 근거 문장: {evidence}
지원자 답변: \"\"\"{answer}\"\"\"

코드가 찾은 답변의 약점:
{findings}

규칙
- 위 약점 중 가장 중요한 하나를 골라 "pick"에 번호를 쓴다. 더 중요한 다른 점이 있으면 "pick"에 0을 쓴다.
- "quote"에는 질문의 근거가 된 답변 속 표현을 한 글자도 바꾸지 말고 그대로 복사한다.
- 질문은 존댓말 한 문장, 60자 이내. 숫자와 사실을 지어내지 않는다.

출력: JSON 하나만. {{"pick": 1, "quote": "...", "question": "..."}}
"""


def facts(text):
    """'12%', '6개월' 같은 숫자+단위. 단위별 숫자 집합으로 돌려준다."""
    out = {}
    for num, unit in NUM_UNIT.findall(text or ""):
        unit = UNIT_ALIAS.get(unit, unit)
        out.setdefault(unit, set()).add(num.replace(",", ""))
    return out


def _sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.?!다요죠])\s+", _norm(text)) if s.strip()]


def find_issues(main, answer):
    """답변의 문제를 우선순위 순서로 모두 돌려준다: [(이름, 문장 틀 값 dict)]"""
    answer = _norm(answer)
    doc, said = facts(main.get("evidence")), facts(answer)
    issues = []
    for unit, nums in doc.items():
        if unit in said and not (nums & said[unit]):
            issues.append(("mismatch", {"doc": sorted(nums)[0] + unit, "said": sorted(said[unit])[0] + unit}))
    for unit, nums in doc.items():
        if unit not in said:
            issues.append(("missing_fact", {"doc": sorted(nums)[0] + unit}))
    if main.get("type") == "경험" and answer and not RESULT_WORDS.search(answer):
        issues.append(("no_result", {}))
    n_self, n_team = len(SELF.findall(answer)), len(TEAM.findall(answer))
    if answer and n_self == 0:
        issues.append(("no_role", {}))
    elif n_team >= 2 and n_team >= 2 * n_self:
        issues.append(("team_heavy", {}))
    for s in _sentences(answer):
        word = next((v for v in VAGUE if v in s), None)
        if word:
            issues.append(("vague", {"quote": s if len(s) <= 25 else word}))
            break
    return issues


def template_question(issues):
    name, slots = issues[0] if issues else ("generic", {})
    return name, TEMPLATES[name].format(**slots)


def check_ai(data, issues, main, answer):
    """AI 응답 검사. 통과하면 (이유 이름, 질문), 아니면 ValueError."""
    if not isinstance(data, dict):
        raise ValueError("형식이 다름")
    q, quote = _norm(data.get("question")), _norm(data.get("quote"))
    try:
        pick = int(data.get("pick"))
    except (TypeError, ValueError):
        raise ValueError("pick이 숫자가 아님")
    if not 0 <= pick <= len(issues):
        raise ValueError(f"없는 번호: {pick}")
    if not quote or quote not in _norm(answer):
        raise ValueError(f"답변에 없는 인용: {quote[:20]}")
    if not q or len(q) > MAX_LEN:
        raise ValueError("빈 질문이거나 너무 김")
    if not re.search(r"(까|요|세요)\?*$|\?$", q):
        raise ValueError("존댓말 물음이 아님")
    allowed = set(re.findall(r"\d+", f"{main.get('evidence') or ''} {answer}"))
    new = set(re.findall(r"\d+", q)) - allowed
    if new:
        raise ValueError(f"없던 숫자를 만듦: {new}")
    return (issues[pick - 1][0] if pick else "ai_other"), q


def _call(ask_fn, model, prompt, budget):
    pool = ThreadPoolExecutor(max_workers=1)
    fut = pool.submit(ask_fn, None, model, prompt)
    try:
        return fut.result(timeout=budget)
    except FutureTimeout:
        raise TimeoutError(f"{budget}초 초과")
    finally:
        pool.shutdown(wait=False)  # 늦은 응답은 버림


def generate_followup(main, answer, use_llm=True, ask_fn=None, model=None, budget=TIME_BUDGET):
    """반환: {"question", "reason", "issues": [규칙이 찾은 이름들], "source": "exaone"|"template", "error"}"""
    issues = find_issues(main, answer)
    reason, q = template_question(issues)
    out = {"question": q, "reason": reason, "issues": [n for n, _ in issues], "source": "template", "error": None}
    if not use_llm or not _norm(answer) or reason in FACT_CHECKS:
        return out
    if ask_fn is None:
        if not ollama_available():
            out["error"] = "Ollama가 꺼져 있어 정해진 문장으로 진행합니다"
            return out
        ask_fn = ask_ollama
    listed = "\n".join(f"{i}. {LABELS[n]}" for i, (n, _) in enumerate(issues, 1)) or "(없음)"
    prompt = PROMPT.format(main=main.get("question", ""), evidence=main.get("evidence") or "(없음)",
                           answer=_norm(answer)[:ANSWER_CHARS], findings=listed)
    try:
        data = json.loads(_call(ask_fn, model or MODELS["exaone"], prompt, budget))
        reason, q = check_ai(data, issues, main, answer)
        out.update(question=q, reason=reason, source="exaone")
    except Exception as e:  # 시간 초과, 형식 오류, 검사 실패 → 정해진 문장
        out["error"] = str(e)
    return out


if __name__ == "__main__":  # 속도 재기: python followup_gen.py "답변 글"
    import sys
    main_q = {"type": "경험", "question": "프로젝트에서 맡은 역할을 말해 주세요.",
              "evidence": "6개월 동안 팀장을 맡아 지연률을 12% 줄였습니다."}
    t0 = time.perf_counter()
    print(json.dumps(generate_followup(main_q, " ".join(sys.argv[1:]) or "저희 팀이 열심히 노력했습니다."),
                     ensure_ascii=False, indent=2))
    print(f"{time.perf_counter() - t0:.1f}초")
