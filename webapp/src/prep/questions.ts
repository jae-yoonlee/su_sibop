// 면접 질문 3개: 브라우저 안 AI용 프롬프트, 결과 검사, AI가 안 될 때 규칙 질문.
// 질문 종류와 '근거 문장은 자소서에서 그대로 복사' 규칙은 poc/face-realtime/question_gen.py와 같음.
import { sentences, type Coverage } from "./competency";

export const TYPES = ["경험", "직무", "상황"] as const;
export interface Question {
  type: string;
  question: string;
  evidence: string; // 자소서 근거 문장 (없으면 "")
  source: "ai" | "rule";
}

export const DEFAULT_QUESTIONS: Question[] = [
  { type: "경험", question: "가장 기억에 남는 프로젝트에서 맡은 역할과 기간을 구체적으로 말해 주세요.", evidence: "", source: "rule" },
  { type: "직무", question: "지원한 직무에서 가장 중요한 역량은 무엇이고, 그 역량을 보여 준 경험을 말해 주세요.", evidence: "", source: "rule" },
  { type: "상황", question: "팀원과 의견이 달랐던 적이 있다면 어떻게 해결했는지 말해 주세요.", evidence: "", source: "rule" },
];

export function questionPrompt(resume: string, coverage: Coverage[]) {
  const req = coverage.map((c) => `- ${c.name}: 자소서에 ${c.found.length ? `있음 (${c.found.slice(0, 3).join(", ")})` : "근거 없음"}`).join("\n");
  return `너는 한국 기업의 채용 면접관이다. 아래 자기소개서를 읽고 면접 질문 3개를 만들어라.

회사가 원하는 역량
${req}

규칙
- 질문 종류는 순서대로 "경험", "직무", "상황" 각 1개.
  - 경험: 자기소개서의 경험 하나를 골라 맡은 역할·기간·결과 수치를 구체적으로 말하게 하는 질문.
  - 직무: 회사가 원하는 역량 중 하나(근거 없음인 것 우선)를 자기소개서 경험과 연결해 묻는 질문.
  - 상황: 자기소개서의 경험에서 생길 법한 갈등이나 실패 상황을 묻는 질문.
- "evidence"에는 근거 문장을 자기소개서에서 한 글자도 바꾸지 말고 그대로 복사한다.
- 자기소개서에 없는 경험을 지어내지 않는다.
- 질문은 존댓말 한 문장, 60자 이내.

출력: {"questions": [{"type": "경험", "question": "...", "evidence": "..."}, ...]}

자기소개서
"""
${resume.slice(0, 2500)}
"""`;
}

export const QUESTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: { type: { type: "string" }, question: { type: "string" }, evidence: { type: "string" } },
        required: ["type", "question", "evidence"],
      },
    },
  },
  required: ["questions"],
});

const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

/** AI 답을 검사해, 규칙에 맞는 질문만 남기고 빠진 자리는 규칙 질문으로 채운다. */
export function parseAiQuestions(text: string, resume: string, fallback: Question[]): { questions: Question[]; aiCount: number } {
  let items: unknown[] = [];
  try {
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const data = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
    items = Array.isArray(data?.questions) ? data.questions : [];
  } catch {
    items = [];
  }
  const body = norm(resume);
  const out: Question[] = [];
  let aiCount = 0;
  TYPES.forEach((type, i) => {
    const it = (items[i] ?? {}) as Record<string, string>;
    const q = norm(it.question);
    const evidence = norm(it.evidence);
    const ok = q.length >= 8 && q.length <= 120 && /[?요다][.!]?$/.test(q) && (!evidence || body.includes(evidence));
    if (ok) {
      out.push({ type, question: q, evidence: evidence && body.includes(evidence) ? evidence : "", source: "ai" });
      aiCount++;
    } else out.push(fallback[i]);
  });
  return { questions: out, aiCount };
}

const josa = (word: string, withFinal: string, without: string) => {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? withFinal : without;
};

/** AI 없이 역량 대조 결과로 질문 3개 */
export function ruleQuestions(resume: string, coverage: Coverage[]): Question[] {
  const sents = sentences(resume).filter((s) => s.length >= 15);
  const covered = coverage.find((c) => c.found.length && c.evidence);
  const missing = coverage.find((c) => !c.found.length);
  const q: Question[] = [...DEFAULT_QUESTIONS];
  const ev = covered?.evidence ?? sents.find((s) => /\d/.test(s)) ?? sents[0];
  if (ev) {
    const short = ev.length > 30 ? `${ev.slice(0, 30)}…` : ev;
    q[0] = { type: "경험", question: `자기소개서에 "${short}"라고 쓰셨는데, 그때 맡은 역할과 기간, 결과를 구체적으로 말해 주세요.`, evidence: ev, source: "rule" };
  }
  if (missing) {
    q[1] = { type: "직무", question: `저희는 ${missing.name}${josa(missing.name, "을", "를")} 중요하게 보는데, 그 역량을 보여 준 경험을 말해 주세요.`, evidence: "", source: "rule" };
  } else if (coverage[0]) {
    const c = coverage[0];
    q[1] = { type: "직무", question: `${c.name}${josa(c.name, "이", "가")} 이 직무에서 왜 중요한지, 본인 경험과 연결해 말해 주세요.`, evidence: c.evidence, source: "rule" };
  }
  return q;
}
