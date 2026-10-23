// 뜻 기반 역량 찾기 (3번째 신호). 단어도 문맥 규칙도 못 잡은 역량만, 자소서 문장과 역량 예시 문장의 뜻을 비교한다.
// 브라우저 안 문장 의미 모델(report/embed.ts)로 계산하고 자소서는 밖으로 안 나간다.
// 모델을 못 받았으면(글자 비교 대체) 이 단계는 건너뛴다: 글자 겹침으로는 "뜻이 같다"를 판단할 수 없어서.
import { similarity } from "../report/embed";
import { COMPETENCIES, PROTOTYPES, cueScore, findCompetencies, guessCompetency, sentences, type Coverage } from "./competency";

// [가설: 실측 전] e5는 관련 없는 문장끼리도 0.75 안팎이 나온다. 약한 문맥 단서(1점)가 있으면 기준을 낮춘다.
export const SEM = { alone: 0.88, withCue: 0.85 };

export interface SemScore { id: string; score: number; sentence: string; passed: boolean }

/** 역량별로 자소서에서 예시 문장과 가장 가까운 문장과 그 점수 */
async function bestMatches(resume: string, ids: string[]) {
  const sents = sentences(resume);
  const protos = ids.flatMap((id) => PROTOTYPES[id].map((p) => ({ id, p })));
  if (!sents.length || !protos.length) return { mode: "fallback" as const, best: new Map<string, { score: number; sentence: string }>() };
  const { sim, mode } = await similarity(protos.map((x) => x.p), sents);
  const best = new Map<string, { score: number; sentence: string }>();
  protos.forEach((x, i) =>
    sim[i].forEach((v, j) => {
      if (v > (best.get(x.id)?.score ?? -1)) best.set(x.id, { score: v, sentence: sents[j] });
    }),
  );
  return { mode, best };
}

const passes = (id: string, score: number, sents: string[]) => score >= (cueScore(id, sents) >= 1 ? SEM.withCue : SEM.alone);

/** 필요역량 대조표에서 근거가 없는 칸만 뜻으로 다시 본다. mode가 fallback이면 아무것도 안 바꾼다 */
export async function addSemantic(coverage: Coverage[], resume: string): Promise<{ coverage: Coverage[]; mode: "model" | "fallback"; added: number; scores?: SemScore[] }> {
  const missing = coverage.map((c) => ({ c, id: guessCompetency(c) })).filter((x) => !x.c.found.length && x.id);
  if (!missing.length) return { coverage, mode: "model", added: 0 };
  const { mode, best } = await bestMatches(resume, [...new Set(missing.map((x) => x.id!))]);
  if (mode !== "model") return { coverage, mode, added: 0 };
  const sents = sentences(resume);
  let added = 0;
  // 결과 JSON에서 실제 뜻 점수를 볼 수 있게, 통과 못 한 것까지 남긴다
  const scores = [...best].map(([id, b]) => ({ id, score: Math.round(b.score * 1000) / 1000, sentence: b.sentence, passed: passes(id, b.score, sents) }));
  const out = coverage.map((c) => {
    const id = guessCompetency(c);
    const b = id && best.get(id);
    if (c.found.length || !id || !b || !passes(id, b.score, sents)) return c;
    added++;
    return { ...c, id, found: [`뜻 비슷함 ${b.score.toFixed(2)}`], evidence: b.sentence, via: "뜻" as const };
  });
  return { coverage: out, mode, added, scores };
}

/** 검증용: 단어·문맥·뜻을 모두 써서 찾은 역량 id */
export async function findAll(resume: string): Promise<{ ids: string[]; mode: "model" | "fallback" }> {
  const ids = findCompetencies(resume, true).map((h) => h.id);
  const rest = COMPETENCIES.map((c) => c.id).filter((id) => !ids.includes(id));
  const { mode, best } = await bestMatches(resume, rest);
  if (mode !== "model") return { ids, mode };
  const sents = sentences(resume);
  return { ids: [...ids, ...rest.filter((id) => passes(id, best.get(id)?.score ?? 0, sents))], mode };
}
