// 채용공고 → 필요역량 정리 (Gemini). 보내는 것은 채용공고와 규칙이 찾은 단어뿐, 자소서는 보내지 않는다.
import type { Hit, Required } from "./competency";

export const GEMINI_MODEL = "gemini-3.5-flash-lite"; // poc/face-realtime/question_gen.py와 같은 모델
const URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
const TIMEOUT_MS = 20000;

const PROMPT = (posting: string, hits: Hit[]) => `너는 한국 기업의 채용 담당자다. 아래 채용공고에서 지원자에게 필요한 역량을 3~5개로 정리하라.

규칙
- "name": 역량 이름, 10자 이내 (예: 협업, 데이터 분석, 고객 응대).
- "reason": 그 역량의 근거가 된 채용공고 문장을 한 글자도 바꾸지 말고 그대로 복사.
- "words": 지원자의 자기소개서에서 이 역량을 보여 줄 만한 단어 4~8개 (명사나 어간, 예: "협업", "팀원", "조율").
- 공고에 없는 역량을 지어내지 않는다.
- 참고: 규칙으로 먼저 찾은 단어 ${JSON.stringify(hits.map((h) => ({ 역량: h.name, 단어: h.words })))}

채용공고
"""
${posting.slice(0, 6000)}
"""`;

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING" },
      reason: { type: "STRING" },
      words: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["name", "reason", "words"],
  },
};

export async function summarizeRequired(key: string, posting: string, hits: Hit[]): Promise<Required[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT(posting, hits) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      const msg = res.status === 400 || res.status === 403 ? "키가 맞지 않아요" : res.status === 429 ? "무료 사용량을 다 썼어요" : `오류 ${res.status}`;
      throw new Error(msg);
    }
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return parseRequired(text);
  } finally {
    clearTimeout(timer);
  }
}

export function parseRequired(text: string): Required[] {
  const items = JSON.parse(text);
  if (!Array.isArray(items) || !items.length) throw new Error("역량 목록이 비어 있어요");
  return items.slice(0, 5).map((it) => ({
    name: String(it.name ?? "").trim().slice(0, 20),
    reason: String(it.reason ?? "").trim(),
    words: (Array.isArray(it.words) ? it.words : []).map((w: unknown) => String(w).trim()).filter(Boolean).slice(0, 8),
  })).filter((r) => r.name && r.words.length);
}
