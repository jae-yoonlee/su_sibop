import { describe, expect, it } from "vitest";
import { CUES, cueOrder, judgeFrame, meanTarget, score, sweep, type Frame, type Target } from "./metrics";

const T: [Target, Target] = [
  { yaw: 0, pitch: -8, iris: [0, 0.1], blend: [0, 0.1] },
  { yaw: 0, pitch: 0, iris: [0, 0], blend: [0, 0] },
];
const fr = (o: Partial<Frame>): Frame => ({ t: 2, cue: "lens", away: false, yaw: 0, pitch: 0, blink: 0, iris: [0, 0], blend: [0, 0], ...o });

describe("시선 측정 계산", () => {
  it("순서를 섞어 두 바퀴", () => {
    expect(cueOrder(() => 0.5)).toHaveLength(CUES.length * 2);
  });
  it("고개가 범위를 넘으면 딴 곳, 눈 감으면 판단 보류", () => {
    expect(judgeFrame(fr({ yaw: 20 }), T, "iris", 0.25, 12)).toBe(true);
    expect(judgeFrame(fr({ blink: 0.8 }), T, "iris", 0.25, 12)).toBeNull();
    expect(judgeFrame(fr({ iris: [0.4, 0] }), T, "iris", 0.25, 12)).toBe(true);
    expect(judgeFrame(fr({ iris: [0.4, 0] }), T, "blend", 0.25, 12)).toBe(false);
  });
  it("점수: 잡은 비율, 오경보, 앞 1초 제외", () => {
    const frames = [
      fr({ cue: "memo", away: true, yaw: 20 }),
      fr({ cue: "memo", away: true }),
      fr({ cue: "lens", away: false }),
      fr({ cue: "lens", away: false, yaw: 30 }),
      fr({ cue: "memo", away: true, yaw: 20, t: 0.5 }), // 빠짐
    ];
    const s = score(frames, T, "iris", 0.25, 12);
    expect(s.n).toBe(4);
    expect(s.recall).toBe(0.5);
    expect(s.falseAlarm).toBe(0.5);
  });
  it("눈만 움직인 칸은 따로 센다, 곡선과 추천값", () => {
    const frames = [fr({ cue: "eyes-left", away: true, iris: [0.5, 0], blend: [0.1, 0] }), fr({ cue: "lens" })];
    const r = sweep(frames, T);
    expect(r.best.iris?.eyesOnlyRecall).toBe(1);
    expect(r.best.blend?.recall).toBeLessThan(1);
  });
  it("기준점 평균", () => {
    const m = meanTarget([{ yaw: 2, pitch: 0, blink: 0, iris: [0.2, 0], blend: [0, 0] }, { yaw: 4, pitch: 0, blink: 0, iris: null, blend: [0.2, 0] }]);
    expect(m.yaw).toBe(3);
    expect(m.iris).toEqual([0.2, 0]);
    expect(m.blend[0]).toBeCloseTo(0.1);
  });
});
