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
3) 시간 안에 못 하거나 검사에 떨어지면 찾은 문제 하나를 정해진 문장 틀로 묻는다 (항상 성공).

매번 달라지게 (같은 자소서로 다시 연습해도 다른 꼬리질문)
- 찾은 문제 여러 개 중 하나를 무작위로 고르고, 문장 틀도 이유마다 3가지 중 무작위로 고른다.
- 같은 자소서로 전에 했던 꼬리질문(history)은 피한다. 다른 선택지가 없을 때만 다시 쓴다.
- AI에는 문제 목록 순서를 섞고 살펴볼 관점(역할 비중·직접 한 행동 등 6가지 중 하나)을 무작위로 주고, 전에 한 질문을 '반복 금지'로 알려 주고, 온도 0.9로 부른다.
- 규칙의 문제 '검출'은 그대로 결정적이라 정확도 평가에는 영향이 없다. 무작위 seed는 결과에 남겨 재현할 수 있다.

휴식 10초 안에 끝내야 하므로 답변 받아쓰기는 답변 도중 쉼마다 조금씩 해 둬야 한다 (coach_engine 쪽 일).
"""
import hashlib
import json
import random
import re
import time
import urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from question_gen import MODELS, OLLAMA_URL, _norm, ollama_available

TIME_BUDGET = 6.0   # AI에 쓸 최대 시간(초). 휴식 10초에서 받아쓰기 마무리 몫을 뺌
MAX_LEN = 60
ANSWER_CHARS = 800  # AI에 넣는 답변 길이 상한 (2분 답변 ≈ 600~800자)
FACT_CHECKS = {"mismatch", "missing_fact"}  # 자소서 사실 확인은 규칙 질문을 그대로 씀
ANGLES = ["팀 안에서 본인 역할의 비중", "본인이 직접 한 행동", "결과의 크기와 그것을 확인한 방법",
          "그렇게 판단한 이유", "가장 어려웠던 점", "다시 한다면 다르게 할 점"]  # AI에 무작위로 하나 줌
TEMPERATURE = 0.9   # 매번 다른 질문이 나오게
HISTORY_FILE = Path(__file__).parent / "results" / "followup_history.json"
HISTORY_KEEP = 30   # 자소서마다 기억할 최근 꼬리질문 수

UNITS = r"(%|퍼센트|프로|개월|년|월|주|일|명|배|건|개|원|시간|분)"
NUM_UNIT = re.compile(r"(\d+(?:[.,]\d+)?)\s*" + UNITS)
UNIT_ALIAS = {"퍼센트": "%", "프로": "%"}
VAGUE = ["열심히", "최선을", "많이 배웠", "노력했", "노력하", "다양한", "여러 가지", "성실하", "잘 해결", "좋은 경험"]
SELF = re.compile(r"(제가|저는|저도|제가요|직접|맡아|맡았|담당)")
TEAM = re.compile(r"(우리|저희|팀이|팀원들이|다 같이|함께)")
RESULT_WORDS = re.compile(r"\d|절반|두\s?배|세\s?배")

TEMPLATES = {  # 이유마다 문장 틀 3가지 (무작위로 고름)
    "mismatch": [
        "자기소개서에는 {doc_라고} 쓰셨는데 방금 {said_라고} 하셨습니다. 어느 쪽이 맞나요?",
        "방금 {said_라고} 하셨는데 자기소개서에는 {doc_로} 되어 있습니다. 설명해 주시겠어요?",
        "{doc_와} {said} 중 어느 숫자가 정확한지, 차이가 생긴 이유는 무엇인가요?",
    ],
    "missing_fact": [
        "자기소개서에 적은 {doc}에 대해 조금 더 구체적으로 설명해 주시겠어요?",
        "자기소개서에는 {doc_라고} 되어 있는데, 그 숫자는 어떻게 나온 건가요?",
        "답변에서 {doc} 이야기가 빠졌는데, 그 부분을 말씀해 주시겠어요?",
    ],
    "no_result": [
        "그 결과를 숫자로 말씀해 주신다면 어느 정도였나요?",
        "그 일로 무엇이 얼마나 달라졌는지 수치로 말씀해 주시겠어요?",
        "성과를 확인할 수 있는 숫자가 있다면 무엇인가요?",
    ],
    "no_role": [
        "그 일에서 본인이 직접 맡은 부분은 무엇이었나요?",
        "팀이 아니라 본인이 직접 한 행동 하나만 말씀해 주시겠어요?",
        "그 과정에서 본인이 내린 결정은 무엇이었나요?",
    ],
    "team_heavy": [
        "팀 전체 성과 중 본인이 기여한 비중은 어느 정도였나요?",
        "본인이 없었다면 그 결과는 어떻게 달라졌을까요?",
        "팀원들과 비교해 본인만 맡았던 일은 무엇인가요?",
    ],
    "vague": [
        "'{quote}'라고 하셨는데, 구체적으로 어떤 행동을 하셨나요?",
        "'{quote}'{quote_를_josa} 보여 주는 구체적인 사례 하나를 말씀해 주시겠어요?",
        "'{quote}'라는 말을 숫자나 행동으로 바꿔 말씀해 주시겠어요?",
    ],
    "generic": [
        "방금 답변에서 가장 어려웠던 점과 그것을 어떻게 해결했는지 말씀해 주세요.",
        "그 경험을 다시 한다면 무엇을 다르게 하시겠어요?",
        "그 일에서 가장 크게 배운 점을 한 가지 사례로 말씀해 주세요.",
    ],
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

이번에 먼저 살펴볼 관점: {angle}

이전 연습에서 이미 한 꼬리질문 (같거나 비슷하게 묻지 마라):
{previous}

규칙
- 위 약점 중 하나를 골라 "pick"에 번호를 쓴다. 더 중요한 다른 점이 있으면 "pick"에 0을 쓴다.
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


# 숫자 뒤 조사: 받침에 맞춰 고름 ("6개월이라고", "12%라고")
JOSA = {"라고": ("이라고", "라고"), "로": ("으로", "로"), "와": ("과", "와"), "를": ("을", "를"), "는": ("은", "는")}
DIGIT_FINAL = {"0": "ㅇ", "1": "ㄹ", "2": "", "3": "ㅁ", "4": "", "5": "", "6": "ㄱ", "7": "ㄹ", "8": "ㄹ", "9": ""}


def _final(word):
    """마지막 글자의 받침 종류: ''(없음), 'ㄹ', 그 밖은 '있음'"""
    c = (word or " ")[-1]
    if c == "%":
        return ""                                # 퍼센트
    if c in DIGIT_FINAL:
        return DIGIT_FINAL[c]
    if "가" <= c <= "힣":
        f = (ord(c) - 0xAC00) % 28
        return "" if f == 0 else "ㄹ" if f == 8 else "있음"
    return ""


def josa(word, kind):
    with_final, without = JOSA[kind]
    f = _final(word)
    if kind == "로" and f == "ㄹ":
        return without
    return with_final if f else without


def _with_josa(slots):
    out = dict(slots)
    for k, v in slots.items():
        for kind in JOSA:
            out[f"{k}_{kind}"] = v + josa(v, kind)
            out[f"{k}_{kind}_josa"] = josa(v, kind)
    return out


def _key(name, slots):
    return name + json.dumps(slots, ensure_ascii=False, sort_keys=True)


def choose_issue(issues, rng, asked_keys=()):
    """사실 확인(숫자)이 있으면 그중에서, 없으면 나머지 중에서 무작위. 전에 물은 것은 다른 게 있으면 피함."""
    if not issues:
        return "generic", {}
    facts_ = [i for i in issues if i[0] in FACT_CHECKS]
    pool = facts_ or issues
    fresh = [i for i in pool if _key(*i) not in asked_keys]
    return rng.choice(fresh or pool)


def template_question(issue, rng, asked=()):
    name, slots = issue
    full = _with_josa(slots)
    texts = [t.format(**full) for t in TEMPLATES[name]]
    fresh = [t for t in texts if t not in asked]
    return rng.choice(fresh or texts)


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


def ask_ollama_varied(seed):
    """온도를 높이고 seed를 바꿔 매번 다른 답이 나오게 Ollama를 부르는 함수"""
    def ask(client, model, prompt):
        body = json.dumps({"model": model, "prompt": prompt, "format": "json", "stream": False,
                           "options": {"temperature": TEMPERATURE, "seed": seed}}).encode()
        req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=TIME_BUDGET + 1) as r:
            return json.loads(r.read())["response"]
    return ask


# ── 같은 자소서로 전에 한 꼬리질문 기록 ──
def _resume_id(resume):
    return hashlib.sha256(_norm(resume).encode()).hexdigest()[:16]


def load_history(resume, path=HISTORY_FILE):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")).get(_resume_id(resume), [])
    except (OSError, ValueError):
        return []


def save_history(resume, out, path=HISTORY_FILE):
    """generate_followup 결과를 기록. 자소서 원문은 저장하지 않고 해시만 쓴다."""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    rows = data.setdefault(_resume_id(resume), [])
    rows.append({"question": out["question"], "key": out.get("key")})
    data[_resume_id(resume)] = rows[-HISTORY_KEEP:]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _call(ask_fn, model, prompt, budget):
    pool = ThreadPoolExecutor(max_workers=1)
    fut = pool.submit(ask_fn, None, model, prompt)
    try:
        return fut.result(timeout=budget)
    except FutureTimeout:
        raise TimeoutError(f"{budget}초 초과")
    finally:
        pool.shutdown(wait=False)  # 늦은 응답은 버림


def generate_followup(main, answer, use_llm=True, ask_fn=None, model=None, budget=TIME_BUDGET,
                      history=(), seed=None):
    """history: 같은 자소서로 전에 한 꼬리질문 기록 (load_history 결과).
    반환: {"question", "reason", "issues": [규칙이 찾은 이름들], "source": "exaone"|"template",
           "error", "seed", "key"}"""
    seed = random.randrange(2**31) if seed is None else seed
    rng = random.Random(seed)
    asked_q = {h.get("question") for h in history}
    asked_keys = {h.get("key") for h in history}
    issues = find_issues(main, answer)
    issue = choose_issue(issues, rng, asked_keys)
    out = {"question": template_question(issue, rng, asked_q), "reason": issue[0],
           "issues": [n for n, _ in issues], "source": "template", "error": None,
           "seed": seed, "key": _key(*issue)}
    if not use_llm or not _norm(answer) or issue[0] in FACT_CHECKS:
        return out
    if ask_fn is None:
        if not ollama_available():
            out["error"] = "Ollama가 꺼져 있어 정해진 문장으로 진행합니다"
            return out
        ask_fn = ask_ollama_varied(seed)
    shown = issues[:]
    rng.shuffle(shown)                           # 순서를 섞어 AI가 매번 첫 번째만 고르지 않게
    listed = "\n".join(f"{i}. {LABELS[n]}" for i, (n, _) in enumerate(shown, 1)) or "(없음)"
    previous = "\n".join(f"- {q}" for q in list(asked_q)[-5:] if q) or "(없음)"
    prompt = PROMPT.format(main=main.get("question", ""), evidence=main.get("evidence") or "(없음)",
                           answer=_norm(answer)[:ANSWER_CHARS], findings=listed, previous=previous,
                           angle=rng.choice(ANGLES))
    try:
        data = json.loads(_call(ask_fn, model or MODELS["exaone"], prompt, budget))
        reason, q = check_ai(data, shown, main, answer)
        if q in asked_q:
            raise ValueError("전에 한 질문과 같음")
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
