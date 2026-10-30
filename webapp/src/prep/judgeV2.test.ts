import { describe, expect, it } from "vitest";
import { calibrate, candidatesV2, combined, CONFUSE, decideV2, EXAMPLES, EXAMPLES_YES2, judgeIdsV2, judgeMessagesV2, logit } from "./judge";
import { COMPETENCIES } from "./competency";
import { auc } from "../eval/metrics";

const ids = COMPETENCIES.map((c) => c.id);

describe("새 AI 판정 (v2)", () => {
  it("역량마다 예시가 맞음 2개, 아님 2개이고 헷갈리는 역량 짝이 자기 자신이 아님", () => {
    for (const id of ids) {
      expect(EXAMPLES_YES2[id]).toBeTruthy();
      expect(CONFUSE[id]).not.toBe(id);
      const m = judgeMessagesV2(id, "문장");
      expect(m.filter((x) => x.role === "assistant").map((x) => x.content)).toEqual(["yes", "no", "yes", "no"]);
      expect(m[7].content).toContain(EXAMPLES[CONFUSE[id]].yes); // 헷갈리는 역량의 행동 = 아님
      expect(m.at(-1)!.content).toContain('"문장"');
    }
  });
  it("뜻 없는 입력의 평균 yes 확률을 버릇으로 잰다", async () => {
    const cal = await calibrate(["self", "math"], async (m) => ({ p: m.at(-1)!.content.includes("자기개발") ? 0.8 : 0.2, raw: "" }));
    expect(cal.get("self")).toBeCloseTo(0.8);
    expect(cal.get("math")).toBeCloseTo(0.2);
  });
  it("버릇만큼 빼서, yes를 잘 하는 역량의 yes는 덜 믿는다", async () => {
    const resume = "처음 해 보는 일이라 실패한 게시물도 많았지만, 매주 숫자를 기록하며 다음 시도를 정했습니다.";
    const js = await judgeIdsV2(["self"], resume, async () => ({ p: 0.8, raw: "" }), new Map([["self", 0.8]]));
    expect(js[0].z).toBeCloseTo(0);
    expect(js[0].weak).toBe(1);
    expect(combined(js[0], 0.5)).toBeCloseTo(0.5);
    expect(decideV2(js, 1)).toEqual([]);
    expect(decideV2(js, 0.4)).toEqual(["self"]);
  });
  it("후보: 규칙으로 이미 인정된 역량은 빼고, 뜻 점수 기준 없이 위에서 몇 개", () => {
    const resume = "독학으로 디자인을 공부했습니다. 그 과정에서 많이 배웠습니다. 친구를 도왔습니다.";
    const c = candidatesV2(["self", "interpersonal"], resume, [
      { id: "interpersonal", score: 0.7, sentence: "친구를 도왔습니다.", passed: false },
      { id: "self", score: 0.9, sentence: "독학으로 디자인을 공부했습니다.", passed: true },
    ]);
    expect(c.map((x) => x.id)).toEqual(["interpersonal"]);
    expect(c[0].sem).toBe(0.7);
  });
  it("AUC", () => {
    expect(auc([{ score: 2, gold: true }, { score: 1, gold: false }])).toBe(1);
    expect(auc([{ score: 1, gold: true }, { score: 1, gold: false }])).toBe(0.5);
    expect(auc([{ score: null, gold: true }, { score: 1, gold: false }])).toBeNaN();
    expect(logit(0.5)).toBeCloseTo(0);
  });
});
