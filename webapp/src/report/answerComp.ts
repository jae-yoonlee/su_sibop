// 면접 답변에서도 역량 찾기: 자소서에 쓴 필요역량이 실제 답변에서도 드러났는지.
// 자소서와 같은 규칙(단어 → 문맥 → 애매한 문장 AI 판정)을 받아쓴 답변에 돌린다. 모두 이 PC 안에서.
import { COMPETENCIES, findCompetencies, guessCompetency, type Coverage } from "../prep/competency";
import { judgeIds, type Judgment, type YesNoAsk } from "../prep/judge";
import { splitSentences } from "./facts";

export type AnswerVerdict = "둘 다" | "자소서만" | "답변만" | "둘 다 없음";

export interface AnswerCompRow {
  id: string;
  name: string;
  inResume: boolean;
  inAnswer: boolean;
  via: "단어" | "문맥" | "AI" | null; // 답변에서 무엇으로 찾았나
  evidence: string; // 답변 근거 문장
  q: number; // 몇 번째 답변 (-1 = 없음)
  verdict: AnswerVerdict;
}

/** 받아쓰기에는 마침표가 거의 없어서, 말 끝(다·요·죠)으로 문장을 나눠 마침표를 붙인다 (규칙이 문장 단위로 보므로) */
export function answerText(answer: string) {
  return splitSentences(answer).map((s) => (/[.?!]$/.test(s) ? s : `${s}.`)).join(" ");
}

export function verdictOf(inResume: boolean, inAnswer: boolean): AnswerVerdict {
  return inResume ? (inAnswer ? "둘 다" : "자소서만") : inAnswer ? "답변만" : "둘 다 없음";
}

/** coverage: 필요역량 ↔ 자소서 대조표. ask가 있으면 규칙이 못 잡은 역량만 애매한 문장을 AI에게 묻는다 */
export async function answerCompetency(
  coverage: Coverage[],
  answers: string[],
  ask: YesNoAsk | null = null,
): Promise<{ rows: AnswerCompRow[]; judgments: Judgment[] }> {
  const texts = answers.map((a) => answerText(a ?? ""));
  const hits = texts.map((t) => findCompetencies(t, true));
  const rows: AnswerCompRow[] = [];
  for (const c of coverage) {
    const id = guessCompetency(c);
    if (!id || rows.some((r) => r.id === id)) continue;
    const q = hits.findIndex((h) => h.some((x) => x.id === id));
    const hit = q >= 0 ? hits[q].find((x) => x.id === id)! : null;
    rows.push({
      id,
      name: COMPETENCIES.find((x) => x.id === id)?.name ?? c.name,
      inResume: c.found.length > 0,
      inAnswer: !!hit,
      via: hit ? (hit.via.includes("단어") ? "단어" : "문맥") : null,
      evidence: hit?.sentences[0] ?? "",
      q,
      verdict: verdictOf(c.found.length > 0, !!hit),
    });
  }
  let judgments: Judgment[] = [];
  const missing = rows.filter((r) => !r.inAnswer).map((r) => r.id);
  if (ask && missing.length) {
    judgments = await judgeIds(missing, texts.join(" "), ask);
    for (const j of judgments.filter((x) => x.yes)) {
      const r = rows.find((x) => x.id === j.id && !x.inAnswer);
      if (!r) continue;
      Object.assign(r, { inAnswer: true, via: "AI", evidence: j.sentence, q: texts.findIndex((t) => t.includes(j.sentence)), verdict: verdictOf(r.inResume, true) });
    }
  }
  return { rows, judgments };
}
