// 강제선택 판정 (2026-10-30 실험, 앱에는 아직 안 씀).
// 지금 방식(judge.ts)은 역량마다 "이 문장에 이 역량이 있나? yes/no"를 따로 물어서, 행동이 나오는 문장이면 역량 여러 개에 다 yes가 나왔다
// (EXAONE 7.8B: 맞음 46, 틀림 73). 여기서는 문장 하나에 "10개 중 가장 잘 드러난 역량 하나, 또는 없음"을 고르게 한다.
// 역량끼리 확률을 나눠 가지므로 한 문장이 여러 역량에 높은 점수를 주기 어렵다. 묻는 횟수도 (문장 수)번으로 줄어든다.
// 자소서는 밖으로 안 나간다 (PC 안 Ollama 또는 브라우저 안 모델).
import { COMPETENCIES, sentences } from "./competency";
import { EXAMPLES, NCS_DEF, type Msg } from "./judge";

/** 보기 글자. 역량 10개는 A~J, 없음은 X (한 글자라 모델이 한 토큰으로 답한다) */
export const LETTERS = "ABCDEFGHIJ".split("");
export const NONE = "X";
export const letterOf = (id: string) => LETTERS[COMPETENCIES.findIndex((c) => c.id === id)];

const options = () =>
  [...COMPETENCIES.map((c, i) => `${LETTERS[i]}. ${c.name}: ${NCS_DEF[c.id]}`), `${NONE}. 없음: 역량 이름만 있거나, 생각·바람·각오뿐이거나, 맡은 역할·배경만 말한 문장`].join("\n");

const ask = (sentence: string) => `문장: "${sentence}"\n답 (글자 하나):`;

/** 예시: 역량마다 '맞음' 문장 하나(→ 그 역량 글자)와 '아님' 문장 일부(→ X). 순서는 고정으로 섞는다 (마지막 예시 쪽으로 쏠리지 않게) */
export function fcShots(): [string, string][] {
  const yes = COMPETENCIES.map((c, i): [string, string] => [EXAMPLES[c.id].yes, LETTERS[i]]);
  const no = ["self", "ethics", "organization", "problem"].map((id): [string, string] => [EXAMPLES[id].no, NONE]);
  const all = [...yes, ...no];
  const order = [3, 11, 7, 0, 13, 5, 9, 2, 12, 8, 1, 10, 6, 4]; // 0~13을 한 번씩
  return order.map((k) => all[k]);
}

export function fcMessages(sentence: string): Msg[] {
  return [
    {
      role: "system",
      content: `자기소개서 문장 하나를 읽고, 말한 사람이 실제로 한 행동에서 가장 잘 드러나는 직업기초능력을 아래에서 하나만 고르세요. 행동이 없으면 ${NONE}.\n${options()}\n글자 하나로만 답하세요.`,
    },
    ...fcShots().flatMap(([s, a]): Msg[] => [{ role: "user", content: ask(s) }, { role: "assistant", content: a }]),
    { role: "user", content: ask(sentence) },
  ];
}

/** 첫 토큰 후보 확률 → 역량별 확률 (보기 글자만 모아 합이 1이 되게). 보기 글자가 하나도 없으면 null */
export function fcProbs(top: { token: string; logprob: number }[]): Record<string, number> | null {
  const acc: Record<string, number> = {};
  let sum = 0;
  for (const t of top) {
    const w = t.token.trim().replace(/[.)]$/, "").toUpperCase();
    const k = w === NONE ? NONE : LETTERS.includes(w) ? COMPETENCIES[LETTERS.indexOf(w)].id : null;
    if (!k) continue;
    acc[k] = (acc[k] ?? 0) + Math.exp(t.logprob);
    sum += Math.exp(t.logprob);
  }
  if (!sum) return null;
  for (const k in acc) acc[k] /= sum;
  return acc;
}

export type FcAsk = (messages: Msg[]) => Promise<{ probs: Record<string, number> | null; raw: string }>;

export interface FcSentence { sentence: string; probs: Record<string, number> | null; raw: string; ms: number }

/** 자소서 문장마다 한 번씩 묻는다 */
export async function judgeFC(resume: string, ask: FcAsk): Promise<FcSentence[]> {
  const out: FcSentence[] = [];
  for (const s of sentences(resume)) {
    const t0 = performance.now();
    let r: { probs: Record<string, number> | null; raw: string };
    try {
      r = await ask(fcMessages(s));
    } catch (e) {
      r = { probs: null, raw: `오류: ${(e as Error).message}` };
    }
    out.push({ sentence: s, ...r, ms: Math.round(performance.now() - t0) });
  }
  return out;
}

/** 역량별 점수 = 그 역량을 가장 강하게 고른 문장의 확률, 근거 = 그 문장 */
export function fcScores(js: FcSentence[]): Map<string, { score: number; sentence: string }> {
  const best = new Map<string, { score: number; sentence: string }>();
  for (const c of COMPETENCIES) best.set(c.id, { score: 0, sentence: "" });
  for (const j of js) {
    if (!j.probs) continue;
    for (const c of COMPETENCIES) {
      const p = j.probs[c.id] ?? 0;
      if (p > best.get(c.id)!.score) best.set(c.id, { score: p, sentence: j.sentence });
    }
  }
  return best;
}
