import { describe, expect, it } from "vitest";
import { COMPETENCIES } from "./competency";
import { fcMessages, fcProbs, fcScores, fcShots, judgeFC, LETTERS, NONE } from "./judgeFC";
import { bestTau, bootstrap, cellAuc, count, crossCount, type Cell } from "../eval/cells";

describe("강제선택 판정", () => {
  it("예시는 역량마다 '맞음' 하나와 '없음' 4개, 같은 예시가 두 번 나오지 않음", () => {
    const shots = fcShots();
    expect(shots).toHaveLength(14);
    expect(new Set(shots.map((s) => s[0])).size).toBe(14);
    expect(shots.filter((s) => s[1] === NONE)).toHaveLength(4);
    expect(new Set(shots.map((s) => s[1]).filter((a) => a !== NONE))).toEqual(new Set(LETTERS));
    const m = fcMessages("문장");
    expect(m[0].content).toContain("J. 직업윤리와 책임감");
    expect(m.at(-1)!.content).toContain('"문장"');
  });
  it("보기 글자 확률만 모아 합이 1이 되게 하고, 보기에 없는 토큰은 뺀다", () => {
    const p = fcProbs([
      { token: "D", logprob: Math.log(0.6) },
      { token: " X", logprob: Math.log(0.2) },
      { token: "<think>", logprob: Math.log(0.15) },
      { token: "c.", logprob: Math.log(0.05) },
    ])!;
    expect(p.self).toBeCloseTo(0.6 / 0.85);
    expect(p[NONE]).toBeCloseTo(0.2 / 0.85);
    expect(p.problem).toBeCloseTo(0.05 / 0.85);
    expect(fcProbs([{ token: "네", logprob: 0 }])).toBeNull();
  });
  it("문장마다 한 번 묻고, 역량 점수는 가장 강하게 고른 문장의 확률", async () => {
    const resume = "매일 강의를 듣고 문제를 풀었습니다. 고객 불만을 듣고 절차를 바꿨습니다. 열심히 하겠습니다.";
    let n = 0;
    const js = await judgeFC(resume, async (m) => {
      n++;
      const s = m.at(-1)!.content;
      const probs: Record<string, number> = s.includes("강의") ? { self: 0.9, X: 0.1 } : s.includes("고객") ? { problem: 0.5, organization: 0.4, X: 0.1 } : { X: 1 };
      return { probs, raw: "" };
    });
    expect(n).toBe(3);
    const best = fcScores(js);
    expect(best.get("self")).toEqual({ score: 0.9, sentence: "매일 강의를 듣고 문제를 풀었습니다." });
    expect(best.get("organization")!.score).toBe(0.4);
    expect(best.get("ethics")!.score).toBe(0);
    expect(best.size).toBe(COMPETENCIES.length);
  });
});

describe("칸 단위 채점", () => {
  const cells: Cell[] = [
    { caseId: "t01", id: "a", score: 0.9, gold: true, rule: false },
    { caseId: "t01", id: "b", score: 0.2, gold: false, rule: false },
    { caseId: "t02", id: "a", score: 0.1, gold: true, rule: true },
    { caseId: "t02", id: "b", score: 0.6, gold: false, rule: false },
  ];
  it("규칙이 찾은 칸은 점수와 상관없이 있음", () => {
    expect(count(cells, Infinity)).toMatchObject({ tp: 1, fp: 0, fn: 1 });
    expect(count(cells, 0.5)).toMatchObject({ tp: 2, fp: 1, fn: 0 });
  });
  it("AUC, 문턱, 교차 채점, 부트스트랩", () => {
    expect(cellAuc(cells)).toBe(1); // t02 a는 점수가 낮아도 규칙이 찾아서 최고점
    expect(bestTau(cells)).toBe(0.9);
    const x = crossCount(cells);
    expect(x.tp + x.fn).toBe(2);
    const [lo, hi] = bootstrap(cells, (s) => count(s, 0.5).tp, 200);
    expect(lo).toBeLessThanOrEqual(hi);
  });
});
