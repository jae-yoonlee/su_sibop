// 칸(자소서 × 역량) 단위 채점 (2026-10-30). 자소서 20개 × 역량 10개 = 200칸.
// AUC를 '후보 문장'이 아니라 '칸'으로 잰다: 후보에 안 뽑혀 점수가 없는 정답 칸도 놓친 것으로 센다.
// 표본이 작아서(정답 54칸) 자소서 단위로 다시 뽑는 부트스트랩으로 95% 구간을 같이 낸다.

export interface Cell { caseId: string; id: string; score: number; gold: boolean; rule: boolean }

export interface Count { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }

const div = (a: number, b: number) => (b ? a / b : 0);

/** 규칙이 찾았거나 점수가 문턱 이상이면 '있음' */
export function count(cells: Cell[], tau: number): Count {
  let tp = 0, fp = 0, fn = 0;
  for (const c of cells) {
    const yes = c.rule || c.score >= tau;
    if (yes && c.gold) tp++;
    else if (yes) fp++;
    else if (c.gold) fn++;
  }
  const precision = div(tp, tp + fp), recall = div(tp, tp + fn);
  return { tp, fp, fn, precision, recall, f1: div(2 * precision * recall, precision + recall) };
}

/** 칸 AUC: 정답 칸이 오답 칸보다 점수가 높을 확률. 규칙이 찾은 칸은 가장 높은 점수로 본다 (앱이 실제로 내는 판정과 같게) */
export function cellAuc(cells: Cell[]) {
  const sc = (c: Cell) => (c.rule ? Infinity : c.score);
  const pos = cells.filter((c) => c.gold).map(sc);
  const neg = cells.filter((c) => !c.gold).map(sc);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** 이 칸들에서 F1이 가장 높은 문턱 */
export function bestTau(cells: Cell[]) {
  const taus = [...new Set(cells.map((c) => c.score))].sort((a, b) => a - b);
  let best = Infinity, bestF = count(cells, Infinity).f1;
  for (const t of taus) {
    const f = count(cells, t).f1;
    if (f > bestF) [best, bestF] = [t, f];
  }
  return best;
}

/** 자소서를 홀짝으로 반씩 나눠, 한쪽에서 정한 문턱으로 다른 쪽을 잰다 (두 번 바꿔서 합침). 문턱을 정한 자소서로는 채점하지 않는다 */
export function crossCount(cells: Cell[]) {
  const ids = [...new Set(cells.map((c) => c.caseId))].sort();
  const a = new Set(ids.filter((_, i) => i % 2 === 0));
  const halves = [cells.filter((c) => a.has(c.caseId)), cells.filter((c) => !a.has(c.caseId))];
  const taus = [bestTau(halves[1]), bestTau(halves[0])];
  const decided = halves.flatMap((h, k) => h.map((c) => ({ ...c, score: c.score >= taus[k] ? 1 : 0 })));
  return { ...count(decided, 1), taus };
}

/** 같은 시드면 같은 결과 */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** 자소서 단위 부트스트랩 95% 구간 */
export function bootstrap(cells: Cell[], stat: (cs: Cell[]) => number, n = 2000, seed = 1): [number, number] {
  const by = new Map<string, Cell[]>();
  cells.forEach((c) => by.set(c.caseId, [...(by.get(c.caseId) ?? []), c]));
  const groups = [...by.values()];
  const r = rng(seed);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = Array.from({ length: groups.length }, () => groups[Math.floor(r() * groups.length)]).flat();
    const v = stat(s);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]];
}
