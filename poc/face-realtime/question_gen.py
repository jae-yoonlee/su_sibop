"""7단계: 자기소개서로 맞춤 면접 질문 3개 만들기 (Gemini 또는 EXAONE)

- 질문 종류는 고정: ① 자소서 경험 확인 ② 직무 역량 ③ 어려웠던 상황.
  ①은 답변에 날짜·역할·숫자가 나오게 해서 나중에 자소서 대조가 작동하게 한다.
- 질문마다 '근거 문장'을 자소서에서 그대로 복사해 오게 하고, 자소서에 없으면 그 결과를 버리고 다시 만든다.
  AI가 자소서에 없는 경험을 지어내는 것을 코드로 막는 장치이고, 근거 문장은 나중에 내용 대조의 기준이 된다.
- 자소서를 넣지 않았거나 API 키가 없거나 계속 실패하면 기본 질문으로 진행한다. 이때는 아무것도 밖으로 보내지 않는다.
- 만드는 AI는 두 가지 중 고른다 (backend).
  - "gemini": Google 서버로 자소서가 전송된다. 화면에 반드시 알린다 (sends_outside).
  - "exaone": 이 PC의 Ollama에서 EXAONE 3.5를 돌린다. 자소서가 밖으로 나가지 않는다.
    준비: Ollama 설치 후 `ollama pull exaone3.5:7.8b`
"""
import json
import os
import re
import urllib.request
from pathlib import Path

MODELS = {
    "gemini": "gemini-3.5-flash-lite",  # step1에서 10회 모두 성공, 평균 2초대 (RESULTS.md)
    "exaone": "exaone3.5:7.8b",         # 메모리가 부족하면 exaone3.5:2.4b
}
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
OLLAMA_TIMEOUT = 180                    # 노트북 CPU에서는 느릴 수 있음 (연습 전에 한 번만 부름)
RETRIES = 2
TYPES = ("경험", "직무", "상황")

DEFAULT_QUESTIONS = [
    {"type": "경험", "question": "가장 기억에 남는 프로젝트에서 맡은 역할과 기간을 구체적으로 말해 주세요.", "evidence": None},
    {"type": "직무", "question": "지원한 직무에서 가장 중요한 역량은 무엇이고, 그 역량을 보여 준 경험을 말해 주세요.", "evidence": None},
    {"type": "상황", "question": "팀원과 의견이 달랐던 적이 있다면 어떻게 해결했는지 말해 주세요.", "evidence": None},
]

PROMPT = """너는 한국 기업의 채용 면접관이다. 아래 자기소개서를 읽고 면접 질문 3개를 만들어라.

규칙
- 질문 종류는 순서대로 "경험", "직무", "상황" 각 1개.
  - 경험: 자기소개서에 적힌 경험 하나를 골라, 맡은 역할·기간·결과 수치를 구체적으로 말하게 하는 질문.
  - 직무: 지원 직무({job})에 필요한 역량을 자기소개서의 경험과 연결해 묻는 질문.
  - 상황: 자기소개서의 경험에서 생길 법한 갈등이나 실패 상황을 묻는 질문.
- 각 질문의 "evidence"에는 질문의 근거가 된 문장을 자기소개서에서 한 글자도 바꾸지 말고 그대로 복사한다.
- 자기소개서에 없는 경험을 지어내지 않는다.
- 질문은 존댓말 한 문장, 60자 이내.

출력: JSON 배열만. 예) [{{"type": "경험", "question": "...", "evidence": "..."}}, ...]

자기소개서
\"\"\"
{resume}
\"\"\"
"""


def _norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def parse_questions(text, resume):
    """Gemini 응답을 검사해 질문 3개 목록을 돌려준다. 규칙에 어긋나면 ValueError."""
    try:
        items = json.loads(text)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"JSON이 아님: {e}")
    if not isinstance(items, list) or len(items) != 3:
        raise ValueError("질문이 3개가 아님")
    body = _norm(resume)
    out = []
    for want, item in zip(TYPES, items):
        if not isinstance(item, dict):
            raise ValueError("항목 형식이 다름")
        q, evidence = _norm(item.get("question")), _norm(item.get("evidence"))
        if item.get("type") != want:
            raise ValueError(f"질문 순서가 다름: {item.get('type')} (기대 {want})")
        if not q:
            raise ValueError("빈 질문")
        if not evidence or evidence not in body:
            raise ValueError(f"근거 문장이 자기소개서에 없음: {evidence[:30]}")
        out.append({"type": want, "question": q, "evidence": evidence})
    return out


def make_client():
    """.env의 GEMINI_API_KEY로 클라이언트를 만든다. 키가 없으면 None."""
    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).parent / ".env")
    except ImportError:
        pass
    key = os.getenv("GEMINI_API_KEY")
    if not key or key == "your_api_key_here":
        return None
    from google import genai
    return genai.Client(api_key=key)


def ollama_available():
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2):
            return True
    except OSError:
        return False


def ask_ollama(client, model, prompt):
    """Ollama(이 PC)에 질문. client는 쓰지 않는다."""
    body = json.dumps({"model": model, "prompt": prompt, "format": "json", "stream": False,
                       "options": {"temperature": 0.3}}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as r:
        text = json.loads(r.read())["response"]
    data = json.loads(text)
    if isinstance(data, dict):  # format=json이면 배열 대신 {"questions": [...]}로 감싸서 줄 때가 있음
        data = next((v for v in data.values() if isinstance(v, list)), data)
    return json.dumps(data, ensure_ascii=False)


def ask(client, model, prompt):
    from google.genai import types
    res = client.models.generate_content(
        model=model,
        contents=[prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )
    return res.text


def generate_questions(resume, job="", backend="gemini", client=None, model=None, ask_fn=None):
    """반환: {"questions": [...3개], "source": backend|"default", "sends_outside": bool, "error": str|None}"""
    resume = (resume or "").strip()
    if not resume:
        return {"questions": DEFAULT_QUESTIONS, "source": "default", "sends_outside": False,
                "error": None}
    model = model or MODELS[backend]
    outside = backend == "gemini"
    if ask_fn is None:
        if backend == "gemini":
            client = client if client is not None else make_client()
            if client is None:
                return {"questions": DEFAULT_QUESTIONS, "source": "default", "sends_outside": False,
                        "error": "GEMINI_API_KEY가 없어 기본 질문으로 진행합니다"}
            ask_fn = ask
        else:
            if not ollama_available():
                return {"questions": DEFAULT_QUESTIONS, "source": "default", "sends_outside": False,
                        "error": "Ollama가 켜져 있지 않아 기본 질문으로 진행합니다"}
            ask_fn = ask_ollama
    prompt = PROMPT.format(resume=resume, job=job.strip() or "지원 직무")
    error = None
    for _ in range(1 + RETRIES):
        try:
            return {"questions": parse_questions(ask_fn(client, model, prompt), resume),
                    "source": backend, "sends_outside": outside, "error": None}
        except Exception as e:  # 형식 오류, 근거 문장 없음, 네트워크·서버 오류(503 등)
            error = str(e)
    return {"questions": DEFAULT_QUESTIONS, "source": "default", "sends_outside": outside,
            "error": f"맞춤 질문을 만들지 못해 기본 질문으로 진행합니다 ({error})"}


if __name__ == "__main__":  # 속도 재기: python question_gen.py 자소서.txt --backend exaone
    import argparse
    import time
    ap = argparse.ArgumentParser()
    ap.add_argument("resume_file")
    ap.add_argument("--job", default="")
    ap.add_argument("--backend", choices=list(MODELS), default="gemini")
    a = ap.parse_args()
    t0 = time.perf_counter()
    out = generate_questions(Path(a.resume_file).read_text(encoding="utf-8"), a.job, a.backend)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"{time.perf_counter() - t0:.1f}초")
