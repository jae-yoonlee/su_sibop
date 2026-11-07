import { describe, expect, it } from "vitest";
import { JUDGES, pickJudge, subj } from "./judges";
import { maxSpeakSec } from "../media/tts";

describe("면접관", () => {
  it("바로 앞 면접관은 다시 고르지 않음", () => {
    for (const prev of [0, 1, 2]) for (const r of [0, 0.49, 0.5, 0.999]) expect(pickJudge(prev, () => r)).not.toBe(prev);
    expect(new Set([0, 0.4, 0.8].map((r) => pickJudge(undefined, () => r))).size).toBe(3);
  });
  it("왼쪽·가운데·오른쪽에 앉음", () => {
    expect(JUDGES.map((j) => j.side)).toEqual([-1, 0, 1]);
  });
  it("조사", () => {
    expect([0, 1, 2].map(subj)).toEqual(["면접관 1이", "면접관 2가", "면접관 3이"]);
  });
  it("말 끝 신호가 없어도 멈추는 최대 시간", () => {
    expect(maxSpeakSec("가".repeat(70), 1)).toBe(13);
  });
});
