// 애매한 문장만 이 PC 안 AI(Qwen3)에게 묻기 (2026-10-23 사용자 결정).
// 규칙 점수가 1점(약한 서술)뿐이라 역량으로 인정 못 한 문장을 "이 문장이 이 역량을 행동으로 보여 주나?"로 묻는다.
// 자소서는 밖으로 안 나가고, 면접 전에 한 번만 돌므로 속도 부담이 적다. AI가 없으면 규칙 결과 그대로.
import { CUE_PASS, COMPETENCIES, cueMatches, cueScore, guessCompetency, sentences, type Coverage } from "./competency";

/** NCS 직업기초능력 정의 (한국산업인력공단 NCS 직업기초능력 영역 정의를 쉬운 말로) */
export const NCS_DEF: Record<string, string> = {
  communication: "글과 말로 다른 사람의 뜻을 파악하고 자기 뜻을 정확히 전하는 능력 (문서 작성, 경청, 의사표현)",
  math: "계산, 통계, 표와 그래프로 수를 이해하고 일에 쓰는 능력",
  problem: "문제를 알아차리고 원인을 찾아 대안을 실행하고 결과를 확인하는 능력",
  self: "스스로를 돌아보고 관리하며 필요한 것을 배워 성장하는 능력",
  resource: "시간, 돈, 물건, 사람 중 필요한 것을 확보하고 계획대로 효율적으로 나누어 쓰는 능력",
  interpersonal: "함께 일하는 사람들과 원만하게 지내는 능력 (팀워크, 리더십, 갈등 해결, 협상, 고객 응대)",
  information: "필요한 정보를 찾고 모아 분석하고 정리해 쓰는 능력",
  technology: "일에 필요한 도구, 장비, 기술을 이해하고 골라서 적용하는 능력",
  organization: "조직과 고객, 업무가 돌아가는 방식을 이해하고 그에 맞게 일하는 능력",
  ethics: "맡은 일을 책임 있게 하고 규칙과 약속, 안전을 지키는 태도",
};

export const JUDGE_SCHEMA = JSON.stringify({
  type: "object",
  properties: { yes: { type: "boolean" }, why: { type: "string" } },
  required: ["yes", "why"],
});

/** 한 번에 묻는 최대 문장 수 (한 번에 약 1~2초) [가설] */
export const JUDGE_MAX = 6;

export interface Judgment {
  id: string; // 역량
  sentence: string;
  cues: string[]; // 걸린 약한 서술
  yes: boolean | null; // AI 답 (null = 답을 못 읽음)
  why: string;
  raw: string; // AI 원문 (결과 JSON에서 확인용)
  ms: number;
}

export function judgePrompt(id: string, sentence: string) {
  const name = COMPETENCIES.find((c) => c.id === id)?.name ?? id;
  return [
    "자기소개서 한 문장이 아래 역량을 보여 주는지 판단하세요.",
    `역량: ${name} = ${NCS_DEF[id]}`,
    `문장: "${sentence}"`,
    "글쓴이가 이 역량에 해당하는 행동을 실제로 했다고 읽히면 yes: true.",
    "역량 이름이나 관련 단어만 있고 행동이 없거나, 다른 역량에 더 가까우면 yes: false.",
    'JSON으로만 답하세요. why는 20자 안의 이유. 예: {"yes": true, "why": "원인을 찾아 고침"}',
  ].join("\n");
}

export function parseJudge(raw: string): { yes: boolean | null; why: string } {
  try {
    const t = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    return { yes: typeof j.yes === "boolean" ? j.yes : null, why: String(j.why ?? "").slice(0, 40) };
  } catch {
    return { yes: null, why: "" };
  }
}

/** 규칙으로 인정 못 했지만 약한 서술(1점 이상)이 걸린 문장. 점수 높은 문장부터, 역량마다 최대 2개 */
export function weakSentences(id: string, resume: string): { sentence: string; cues: string[] }[] {
  const sents = sentences(resume);
  if (cueScore(id, sents) >= CUE_PASS) return []; // 이미 규칙으로 인정됨
  return sents
    .map((s) => ({ sentence: s, m: cueMatches(id, s) }))
    .filter((x) => x.m.length)
    .sort((a, b) => b.m.reduce((t, m) => t + m.w, 0) - a.m.reduce((t, m) => t + m.w, 0))
    .slice(0, 2)
    .map((x) => ({ sentence: x.sentence, cues: x.m.map((m) => m.text) }));
}

/** 역량 id 목록에서 약한 문장을 AI에게 묻고, 하나라도 yes면 그 역량을 인정 */
export async function judgeIds(ids: string[], resume: string, ask: (prompt: string) => Promise<string>, max = JUDGE_MAX): Promise<Judgment[]> {
  const todo = ids.flatMap((id) => weakSentences(id, resume).map((w) => ({ id, ...w }))).slice(0, max);
  const out: Judgment[] = [];
  for (const t of todo) {
    if (out.some((j) => j.id === t.id && j.yes)) continue; // 이미 인정된 역량은 더 안 물음
    const t0 = performance.now();
    let raw = "";
    try {
      raw = await ask(judgePrompt(t.id, t.sentence));
    } catch (e) {
      raw = `오류: ${(e as Error).message}`;
    }
    out.push({ ...t, ...parseJudge(raw), raw, ms: Math.round(performance.now() - t0) });
  }
  return out;
}

/** 필요역량 대조표에서 근거 없는 칸만 AI 판정으로 다시 본다 */
export async function addJudge(coverage: Coverage[], resume: string, ask: (prompt: string) => Promise<string>) {
  const missing = coverage.map((c) => guessCompetency(c)).filter((id, i): id is string => !!id && !coverage[i].found.length);
  const judgments = await judgeIds([...new Set(missing)], resume, ask);
  const out = coverage.map((c) => {
    const id = guessCompetency(c);
    const j = !c.found.length && judgments.find((x) => x.id === id && x.yes);
    return j ? { ...c, id, found: [`AI: ${j.why || "행동이 보임"}`], evidence: j.sentence, via: "AI" as const } : c;
  });
  return { coverage: out, judgments, added: out.filter((c, i) => c !== coverage[i]).length };
}
