// 애매한 문장만 이 PC 안 AI(Qwen3)에게 묻기 (2026-10-23 사용자 결정).
// 규칙 점수가 1점(약한 서술)뿐이라 역량으로 인정 못 한 문장을 "이 문장이 이 역량을 행동으로 보여 주나?"로 묻는다.
// 2026-10-23 추가: 규칙이 0점인 '돌려 말한' 문장은 뜻 비교(e5) 점수가 어느 정도 높은 것만 후보로 올려 같이 묻는다
// (먼저 넓게 고르고 AI가 확인하는 방식). 질문에는 그 역량의 '맞음/아님' 예시를 하나씩 넣는다 (예시 몇 개로 판단 기준을 보여 주는 방식).
// 자소서는 밖으로 안 나가고, 면접 전에 한 번만 돌므로 속도 부담이 적다. AI가 없으면 규칙 결과 그대로.
import { CUE_PASS, COMPETENCIES, cueMatches, cueScore, guessCompetency, sentences, type Coverage } from "./competency";
import type { SemScore } from "./semantic";

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
export const JUDGE_MAX = 8;
/** 규칙 0점 문장을 AI 후보로 올리는 뜻 비교 점수 [가설] e5는 관련 없는 문장끼리도 0.75 안팎이라 그보다 조금 위 */
export const SEM_CANDIDATE = 0.8;

/** 역량마다 '맞음/아님' 예시 하나씩. 검증 자료(cases.json) 문장은 쓰지 않고 새로 지음 */
export const EXAMPLES: Record<string, { yes: string; no: string }> = {
  communication: { yes: "반대하던 선배에게 지난 기록을 보여 드리며 이야기해 계획을 바꾸기로 했습니다.", no: "저는 발표를 좋아하는 편입니다." },
  math: { yes: "주문 기록을 요일별로 나눠 보니 금요일 주문이 두 배였습니다.", no: "숫자를 다루는 일에 관심이 많습니다." },
  problem: { yes: "반납이 자꾸 늦어져 알림 시간을 하루 앞당겼더니 연체가 거의 없어졌습니다.", no: "문제해결 능력을 키우고 싶습니다." },
  self: { yes: "첫 대회에서 떨어진 뒤 부족했던 부분을 매일 연습해 다음 대회에 다시 나갔습니다.", no: "저는 성실한 사람입니다." },
  resource: { yes: "부원 열 명이 겹치지 않게 당번을 나누고 남은 비품을 미리 채워 두었습니다.", no: "예산이라는 말을 자주 들었습니다." },
  interpersonal: { yes: "조원과 생각이 달라 몇 번 말다툼했지만, 서로 원하는 것을 하나씩 받아들여 끝까지 함께 했습니다.", no: "친구가 많은 편입니다." },
  information: { yes: "비슷한 가게 열 곳의 메뉴판을 모아 가격대를 비교해 정리했습니다.", no: "정보가 중요하다고 생각합니다." },
  technology: { yes: "아두이노로 온도 센서를 연결해 자동으로 창문을 여는 장치를 만들었습니다.", no: "새로운 기술에 관심이 많습니다." },
  organization: { yes: "본사와 매장의 주문 절차가 달라 생기는 혼선을 알고, 넘기기 전에 양식을 맞춰 드렸습니다.", no: "회사에 입사하고 싶습니다." },
  ethics: { yes: "아무도 확인하지 않는 야간에도 점검표를 한 줄씩 채우고 퇴근했습니다.", no: "책임감이 중요하다고 배웠습니다." },
};

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
    "역량 단어가 없어도 행동이 그 역량이면 true입니다.",
    `맞음 예: "${EXAMPLES[id].yes}" → true`,
    `아님 예: "${EXAMPLES[id].no}" → false`,
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

/** AI에게 물을 후보: 약한 서술(1점) 문장, 그다음 뜻 비교 점수가 SEM_CANDIDATE 이상인 문장 (같은 문장은 한 번) */
export function candidates(ids: string[], resume: string, sem: SemScore[] = []) {
  const weak = ids.flatMap((id) => weakSentences(id, resume).map((w) => ({ id, ...w })));
  const sents = sentences(resume);
  const bySem = sem
    .filter((x) => ids.includes(x.id) && !x.passed && x.score >= SEM_CANDIDATE && cueScore(x.id, sents) < CUE_PASS)
    .filter((x) => !weak.some((w) => w.id === x.id && w.sentence === x.sentence))
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ id: x.id, sentence: x.sentence, cues: [`뜻 ${x.score.toFixed(2)}`] }));
  return [...weak, ...bySem];
}

/** 역량 id 목록에서 후보 문장을 AI에게 묻고, 하나라도 yes면 그 역량을 인정 */
export async function judgeIds(ids: string[], resume: string, ask: (prompt: string) => Promise<string>, max = JUDGE_MAX, sem: SemScore[] = []): Promise<Judgment[]> {
  const todo = candidates(ids, resume, sem).slice(0, max);
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
export async function addJudge(coverage: Coverage[], resume: string, ask: (prompt: string) => Promise<string>, sem: SemScore[] = []) {
  const missing = coverage.map((c) => guessCompetency(c)).filter((id, i): id is string => !!id && !coverage[i].found.length);
  const judgments = await judgeIds([...new Set(missing)], resume, ask, JUDGE_MAX, sem);
  const out = coverage.map((c) => {
    const id = guessCompetency(c);
    const j = !c.found.length && judgments.find((x) => x.id === id && x.yes);
    return j ? { ...c, id, found: [`AI: ${j.why || "행동이 보임"}`], evidence: j.sentence, via: "AI" as const } : c;
  });
  return { coverage: out, judgments, added: out.filter((c, i) => c !== coverage[i]).length };
}
