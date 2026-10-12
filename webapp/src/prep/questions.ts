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
  focus: string; // AI에 줄 '무엇을 물을지'
  competency?: string; // 직무 질문에서 묻는 역량
}

const ROLE = /(제가|저는|직접|맡아|맡았|담당|팀장|리더|주도)/;
const SITUATION = /(갈등|의견|설득|조율|협업|협력|팀원|문제|실패|어려|위기|반대|마감)/;

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
  const sit = take(SITUATION.test.bind(SITUATION), () => true);
  return [
    { type: "경험", evidence: exp, focus: "이 경험에서 본인이 맡은 역할·기간·결과 수치를 구체적으로 묻는다." },
    {
      type: "직무",
      evidence: jobEv,
      competency: job?.name,
      focus: job
        ? missing
          ? `회사가 원하는 '${job.name}' 역량이 자기소개서에 드러나지 않는다. 이 경험과 연결해 그 역량을 보여 달라고 묻는다.`
          : `회사가 원하는 '${job.name}' 역량을 이 경험에서 어떻게 발휘했는지 묻는다.`
        : "지원 직무에 필요한 역량을 이 경험과 연결해 묻는다.",
    },
    { type: "상황", evidence: sit, focus: "이 경험에서 생길 법한 갈등·실패·어려움에 어떻게 대처했는지 묻는다." },
  ];
}

export function questionPrompt(resume: string, coverage: Coverage[]) {
  const slots = questionSlots(resume, coverage);
  const list = slots.map((s, i) => `${i + 1}. [${s.type}] 근거: "${s.evidence || "(근거 문장 없음)"}"\n   지시: ${s.focus}`).join("\n");
  return `너는 한국 기업의 채용 면접관이다. 아래 1~3번마다 면접 질문 한 문장씩, 모두 3개를 써라.

${list}

규칙
- 근거 문장의 구체적인 내용(프로젝트·숫자·역할)을 질문에 넣는다.
- 근거에 없는 경험·숫자를 지어내지 않는다.
- 존댓말 한 문장, 70자 이내.

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
  const short = (ev: string) => (ev.length > 30 ? `${ev.slice(0, 30)}…` : ev);
  const q: Question[] = DEFAULT_QUESTIONS.map((d, i) => ({ ...d, evidence: [exp, job, sit][i].evidence }));
  if (exp.evidence) q[0].question = `자기소개서에 "${short(exp.evidence)}"라고 쓰셨는데, 그때 맡은 역할과 기간, 결과를 구체적으로 말해 주세요.`;
  const missing = coverage.find((c) => !c.found.length);
  if (missing) q[1].question = `저희는 ${missing.name}${josa(missing.name, "을", "를")} 중요하게 보는데, 그 역량을 보여 준 경험을 말해 주세요.`;
  else if (job.competency) q[1].question = `${job.competency}${josa(job.competency, "이", "가")} 이 직무에서 왜 중요한지, 본인 경험과 연결해 말해 주세요.`;
  if (sit.evidence) q[2].question = `"${short(sit.evidence)}" 경험에서 의견이 부딪히거나 일이 틀어진 적이 있다면 어떻게 해결했는지 말해 주세요.`;
  return q;
}
