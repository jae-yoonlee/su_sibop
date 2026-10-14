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

// 근거 문장은 규칙이 고르고(즉시·지어낼 수 없음), 브라우저 안 AI는 질문 문장 3개만 쓴다.
// 자소서 전체 대신 고른 문장만 넣고 출력도 짧아서 빠르다 (2026-10-12 결정: 자소서 질문은 로컬 AI, 속도는 규칙으로).
export interface Slot {
  type: (typeof TYPES)[number];
  evidence: string; // 규칙이 고른 자소서 문장 ("" 가능)
  quote: string; // 질문에 넣을 인용 (중간에 자르지 않은 완결된 구절)
  focus: string; // AI에 줄 '무엇을 물을지'
  competency?: string; // 직무 질문에서 묻는 역량
}

const ROLE = /(제가|저는|직접|맡아|맡았|담당|팀장|리더|주도)/;
const SITUATION = /(갈등|의견|설득|조율|협업|협력|팀원|문제|실패|어려|위기|반대|마감)/;

const QUOTE_MAX = 45;
/** 질문에 넣을 인용: 문장이 길면 쉼표로 나눈 구절 중 숫자·역할이 있는 것을 고르고 끝을 '~다'로 맺는다. 중간에 '…'로 자르지 않는다 (2026-10-14 요청). */
export function quoteClause(sentence: string): string {
  const s = sentence.trim().replace(/[.!?]+$/, "").replace(/^(저는|제가)\s+/, "");
  if (s.length <= QUOTE_MAX) return s;
  const parts = s.split(/,\s*/).map((p) => p.trim()).filter((p) => p.length >= 10);
  if (parts.length < 2) return s;
  const pick = parts.find((p) => /\d/.test(p) && ROLE.test(p)) ?? parts.find((p) => /\d/.test(p)) ?? parts.reduce((a, b) => (b.length > a.length ? b : a));
  return pick.replace(/(고|며)$/, "다");
}

/** 질문 3개의 근거 문장을 규칙으로 고른다 (서로 다른 문장, 같은 자소서면 항상 같은 결과) */
export function questionSlots(resume: string, coverage: Coverage[]): Slot[] {
  const sents = sentences(resume).filter((s) => s.length >= 15);
  const used = new Set<string>();
  const take = (...tests: ((s: string) => boolean)[]) => {
    for (const t of tests) {
      const hit = sents.find((s) => !used.has(s) && t(s));
      if (hit) {
        used.add(hit);
        return hit;
      }
    }
    return "";
  };
  const covered = coverage.find((c) => c.found.length && c.evidence);
  const missing = coverage.find((c) => !c.found.length);
  const exp = take((s) => /\d/.test(s) && ROLE.test(s), (s) => /\d/.test(s), (s) => s === covered?.evidence, ROLE.test.bind(ROLE), () => true);
  const job = missing ?? coverage.find((c) => c.found.length) ?? null;
  const jobEv = take((s) => !!job?.found.some((w) => s.toLowerCase().includes(w.toLowerCase())), (s) => /\d/.test(s), () => true);
  // 상황 질문은 경험 문장이어야 의미가 있어, 갈등·협업 문장이 없으면 경험 질문의 문장을 다시 쓴다
  const sit = take(SITUATION.test.bind(SITUATION)) || exp;
  return [
    { type: "경험", evidence: exp, quote: quoteClause(exp), focus: "이 경험에서 본인이 맡은 역할·기간·결과 수치를 구체적으로 묻는다." },
    {
      type: "직무",
      evidence: jobEv,
      quote: quoteClause(jobEv),
      competency: job?.name,
      focus: job
        ? missing
          ? `회사가 원하는 '${job.name}' 역량이 자기소개서에 드러나지 않는다. 이 경험과 연결해 그 역량을 보여 달라고 묻는다.`
          : `회사가 원하는 '${job.name}' 역량을 이 경험에서 어떻게 발휘했는지 묻는다.`
        : "지원 직무에 필요한 역량을 이 경험과 연결해 묻는다.",
    },
    { type: "상황", evidence: sit, quote: quoteClause(sit), focus: "이 경험에서 생길 법한 갈등·실패·어려움에 어떻게 대처했는지 묻는다." },
  ];
}

export function questionPrompt(resume: string, coverage: Coverage[]) {
  const slots = questionSlots(resume, coverage);
  const list = slots.map((s, i) => `${i + 1}. [${s.type}] 근거: "${s.evidence || "(근거 문장 없음)"}"${s.quote ? `\n   인용할 때 쓸 표현: '${s.quote}'` : ""}\n   지시: ${s.focus}`).join("\n");
  return `너는 한국 기업의 채용 면접관이다. 아래 1~3번마다 면접 질문 한 문장씩, 모두 3개를 써라.

${list}

규칙
- "자기소개서에 '(인용할 때 쓸 표현)'라고 쓰셨는데, (구체적으로 물을 것)?" 형태로, 지원자가 무엇을 답해야 하는지 하나만 분명하게 묻는다.
- 인용은 위의 표현을 그대로 쓴다. 문장을 중간에 자르거나 '…', '...'을 쓰지 않는다.
- "어떻게 생각하시나요"처럼 막연하게 묻지 않는다.
- 근거에 없는 경험·숫자를 지어내지 않는다.
- 존댓말 한 문장, 90자 이내.

출력: {"questions": ["1번 질문", "2번 질문", "3번 질문"]}`;
}

export const QUESTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: { questions: { type: "array", minItems: 3, maxItems: 3, items: { type: "string" } } },
  required: ["questions"],
});

const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

/** AI 질문 하나 검사. 통과하면 "" 아니면 이유 */
export function questionProblem(q: string, resume: string): string {
  if (q.length < 8 || q.length > 120) return "길이";
  if (!/[?요다][.!]?$/.test(q)) return "물음 형태 아님";
  if (/…|\.\.\./.test(q)) return "말을 중간에 자름";
  if (/어떻게 생각하시/.test(q)) return "막연한 물음";
  const made = (q.match(/\d+/g) ?? []).filter((n) => !resume.includes(n));
  if (made.length) return "없던 숫자";
  return "";
}

/** AI 답을 검사해, 규칙에 맞는 질문만 남기고 빠진 자리는 규칙 질문으로 채운다. 근거 문장은 규칙 질문(fallback)과 같은 것. */
export function parseAiQuestions(text: string, resume: string, fallback: Question[]): { questions: Question[]; aiCount: number } {
  let items: unknown[] = [];
  try {
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const data = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
    items = Array.isArray(data?.questions) ? data.questions : [];
  } catch {
    items = [];
  }
  const out: Question[] = [];
  let aiCount = 0;
  TYPES.forEach((type, i) => {
    const it = items[i];
    const q = norm(typeof it === "string" ? it : ((it as Record<string, string>)?.question ?? ""));
    if (!questionProblem(q, resume)) {
      out.push({ type, question: q, evidence: fallback[i].evidence, source: "ai" });
      aiCount++;
    } else out.push(fallback[i]);
  });
  return { questions: out, aiCount };
}

const josa = (word: string, withFinal: string, without: string) => {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? withFinal : without;
};

/** AI를 못 쓸 때: 규칙이 고른 근거 문장으로 질문 3개 (근거 문장은 AI 질문과 같음) */
export function ruleQuestions(resume: string, coverage: Coverage[]): Question[] {
  const [exp, job, sit] = questionSlots(resume, coverage);
  const q: Question[] = DEFAULT_QUESTIONS.map((d, i) => ({ ...d, evidence: [exp, job, sit][i].evidence }));
  if (exp.quote) q[0].question = `자기소개서에 '${exp.quote}'라고 쓰셨는데, 그 일에서 구체적으로 무엇을 하셨고 결과는 어땠나요?`;
  const missing = coverage.find((c) => !c.found.length);
  if (missing) q[1].question = `저희는 ${missing.name}${josa(missing.name, "을", "를")} 중요하게 보는데, 자기소개서에서는 잘 드러나지 않았어요. 그 역량을 보여 준 경험을 하나 말씀해 주세요.`;
  else if (job.competency) q[1].question = `${job.competency}${josa(job.competency, "이", "가")} 이 직무에서 왜 중요한지, 본인 경험과 연결해 말씀해 주세요.`;
  if (sit.quote) q[2].question = `자기소개서에 '${sit.quote}'라고 쓰셨는데, 그 과정에서 의견이 부딪히거나 일이 틀어진 적이 있다면 어떻게 해결하셨나요?`;
  return q;
}
