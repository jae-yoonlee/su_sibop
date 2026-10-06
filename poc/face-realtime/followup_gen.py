"""8단계: 꼬리질문 1개 만들기 (이 PC 안에서만)

메인 질문 3개마다 꼬리질문 1개를 붙인다. 답변 음성은 이 PC의 faster-whisper로 받아 쓰고,
그 글과 메인 질문의 근거 문장(자소서)만으로 꼬리질문을 만든다. 아무것도 밖으로 보내지 않는다.

1) 무엇을 물을지는 코드 규칙이 정한다 (같은 답변이면 항상 같은 이유 → 평가 가능)
   우선순위: 자소서와 숫자가 다름 > 자소서의 숫자를 말하지 않음 > 결과 수치 없음 > 본인 역할 없음 > 모호한 표현 > 일반
2) 이유마다 정해진 문장 틀로 바로 질문을 만든다 (0.01초, 항상 성공)
3) EXAONE(Ollama)이 켜져 있으면 그 질문을 자연스럽게 다듬게 한다. 시간 안에 못 하거나
   검사(60자 이내, 존댓말 물음, 새 숫자를 지어내지 않음)를 통과하지 못하면 2)의 질문을 그대로 쓴다.

휴식 10초 안에 끝내야 하므로 답변 받아쓰기는 답변 도중 쉼마다 조금씩 해 둬야 한다 (coach_engine 쪽 일).
"""
import json
import re
import time

from question_gen import MODELS, _norm, ask_ollama, ollama_available

TIME_BUDGET = 6.0   # 다듬기에 쓸 최대 시간(초). 휴식 10초에서 받아쓰기 마무리 몫을 뺌
MAX_LEN = 60

UNITS = r"(%|퍼센트|프로|개월|년|월|주|일|명|배|건|개|원|시간|분)"
NUM_UNIT = re.compile(r"(\d+(?:[.,]\d+)?)\s*" + UNITS)
UNIT_ALIAS = {"퍼센트": "%", "프로": "%"}
VAGUE = ["열심히", "최선을", "많이 배웠", "노력했", "노력하", "다양한", "여러 가지", "성실하", "잘 해결", "좋은 경험"]
ROLE = re.compile(r"(제가|저는|저도|제\s|직접|맡아|맡았|담당)")
RESULT_WORDS = re.compile(r"\d|절반|두\s?배|세\s?배")

TEMPLATES = {
    "mismatch": "자기소개서에는 {doc}라고 쓰셨는데 방금 {said}라고 하셨습니다. 어느 쪽이 맞나요?",
    "missing_fact": "자기소개서에 적은 {doc}에 대해 조금 더 구체적으로 설명해 주시겠어요?",
    "no_result": "그 결과를 숫자로 말씀해 주신다면 어느 정도였나요?",
    "no_role": "그 일에서 본인이 직접 맡은 부분은 무엇이었나요?",
    "vague": "'{quote}'라고 하셨는데, 구체적으로 어떤 행동을 하셨나요?",
    "generic": "방금 답변에서 가장 어려웠던 점과 그것을 어떻게 해결했는지 말씀해 주세요.",
}

REWRITE_PROMPT = """너는 한국 기업의 면접관이다. 아래 꼬리질문을 같은 뜻으로, 존댓말 한 문장, 60자 이내로 자연스럽게 다듬어라.
숫자와 사실은 바꾸거나 새로 만들지 마라. 출력은 JSON 하나만: {{"question": "..."}}

메인 질문: {main}
지원자 답변 일부: {quote}
꼬리질문: {draft}
"""


def facts(text):
    """'12%', '6개월' 같은 숫자+단위 목록. 단위별 숫자 집합으로 돌려준다."""
    out = {}
    for num, unit in NUM_UNIT.findall(text or ""):
        unit = UNIT_ALIAS.get(unit, unit)
        out.setdefault(unit, set()).add(num.replace(",", ""))
    return out


def _sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.?!다요죠])\s+", _norm(text)) if s.strip()]


def pick_reason(main, answer):
    """반환: (이유, 문장 틀에 넣을 값 dict). 같은 입력이면 항상 같은 결과."""
    answer = _norm(answer)
    doc = facts(main.get("evidence"))
    said = facts(answer)
    for unit, nums in doc.items():               # 1. 같은 단위인데 숫자가 다름
        if unit in said and not (nums & said[unit]):
            d, s = sorted(nums)[0] + unit, sorted(said[unit])[0] + unit
            return "mismatch", {"doc": d, "said": s}
    for unit, nums in doc.items():               # 2. 자소서의 숫자를 아예 말하지 않음
        if unit not in said:
            return "missing_fact", {"doc": sorted(nums)[0] + unit}
    if main.get("type") == "경험" and not RESULT_WORDS.search(answer):
        return "no_result", {}                   # 3. 경험 질문인데 결과 수치가 없음
    if answer and not ROLE.search(answer):
        return "no_role", {}                     # 4. 본인 이야기가 없음
    for s in _sentences(answer):                 # 5. 모호한 표현
        if any(v in s for v in VAGUE):
            return "vague", {"quote": s if len(s) <= 25 else next(v for v in VAGUE if v in s)}
    return "generic", {}


def draft_question(main, answer):
    reason, slots = pick_reason(main, answer)
    return reason, TEMPLATES[reason].format(**slots)


def check_rewrite(text, draft, main, answer):
    """다듬은 질문 검사. 통과 못 하면 ValueError."""
    q = _norm(text)
    if not q or len(q) > MAX_LEN:
        raise ValueError("빈 질문이거나 너무 김")
    if not re.search(r"(까|요|세요)\?*$|\?$", q):
        raise ValueError("존댓말 물음이 아님")
    allowed = set(re.findall(r"\d+", f"{draft} {main.get('evidence') or ''} {answer}"))
    new = set(re.findall(r"\d+", q)) - allowed
    if new:
        raise ValueError(f"없던 숫자를 만듦: {new}")
    return q


def generate_followup(main, answer, use_llm=True, ask_fn=None, model=None, budget=TIME_BUDGET):
    """반환: {"question", "reason", "source": "exaone"|"template", "error"}"""
    reason, draft = draft_question(main, answer)
    out = {"question": draft, "reason": reason, "source": "template", "error": None}
    if not use_llm:
        return out
    if ask_fn is None:
        if not ollama_available():
            out["error"] = "Ollama가 꺼져 있어 기본 문장으로 진행합니다"
            return out
        ask_fn = ask_ollama
    quote = _norm(answer)[:200]
    prompt = REWRITE_PROMPT.format(main=main.get("question", ""), quote=quote, draft=draft)
    t0 = time.perf_counter()
    try:
        text = ask_fn(None, model or MODELS["exaone"], prompt)
        if time.perf_counter() - t0 > budget:
            raise TimeoutError(f"{budget}초 초과")
        data = json.loads(text)
        q = data.get("question") if isinstance(data, dict) else None
        out.update(question=check_rewrite(q, draft, main, answer), source="exaone")
    except Exception as e:  # 시간 초과, 형식 오류, 검사 실패 → 정해진 문장 사용
        out["error"] = str(e)
    return out


if __name__ == "__main__":  # 속도 재기: python followup_gen.py "답변 글"
    import sys
    main_q = {"type": "경험", "question": "프로젝트에서 맡은 역할을 말해 주세요.",
              "evidence": "6개월 동안 팀장을 맡아 지연률을 12% 줄였습니다."}
    t0 = time.perf_counter()
    print(json.dumps(generate_followup(main_q, " ".join(sys.argv[1:]) or "열심히 노력했습니다."),
                     ensure_ascii=False, indent=2))
    print(f"{time.perf_counter() - t0:.1f}초")
