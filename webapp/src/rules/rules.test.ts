import { describe, expect, it } from "vitest";
import { CameraSetup, positionIssue } from "./cameraSetup";
import { headAngles, faceBox, type FaceInfo } from "./face";
import { FeedbackGate } from "./gate";
import { PostureRules } from "./postureRules";
import { AnswerCoach } from "./session";
import { EnergyVad, VoiceRules, VoiceSetup } from "./voice";

const CENTER = { cx: 0.5, cy: 0.45, w: 0.3 };
const info = (o: Partial<FaceInfo> = {}): FaceInfo => ({ yaw: 0, pitch: 0, roll: 0, blink: 0, gazeX: 0, gazeY: 0, ...o });
const run = (from: number, to: number, step: number, fn: (t: number) => void) => {
  for (let t = from; t <= to + 1e-9; t += step) fn(Math.round(t * 1000) / 1000);
};

describe("face", () => {
  it("열 우선·행 우선 행렬 모두 같은 각도", () => {
    const a = (30 * Math.PI) / 180;
    // y축 회전(yaw) 30°: 행 우선 R = [[c,0,s],[0,1,0],[-s,0,c]], 이동 z=-50
    const rowMajor = [Math.cos(a), 0, Math.sin(a), 0, 0, 1, 0, 0, -Math.sin(a), 0, Math.cos(a), -50, 0, 0, 0, 1];
    const colMajor = [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => rowMajor[r * 4 + c]));
    expect(headAngles(rowMajor).yaw).toBeCloseTo(30);
    expect(headAngles(colMajor).yaw).toBeCloseTo(30);
  });

  it("거울 기준으로 x를 뒤집음", () => {
    const b = faceBox([{ x: 0.1, y: 0.4 }, { x: 0.3, y: 0.6 }]);
    expect(b.cx).toBeCloseTo(0.8);
    expect(b.w).toBeCloseTo(0.2);
  });
});

describe("카메라 세팅", () => {
  it("위치 문제 판정 (camera_setup.position_issue와 같음)", () => {
    expect(positionIssue(null)).toBe("no_face");
    expect(positionIssue({ ...CENTER, w: 0.1 })).toBe("too_far");
    expect(positionIssue({ ...CENTER, w: 0.5 })).toBe("too_close");
    expect(positionIssue({ ...CENTER, cx: 0.3 })).toBe("move_right");
    expect(positionIssue({ ...CENTER, cx: 0.7 })).toBe("move_left");
    expect(positionIssue({ ...CENTER, cy: 0.2 })).toBe("too_high");
    expect(positionIssue(CENTER)).toBeNull();
  });

  it("위치 → 렌즈 → 화면 순서로 끝나고 정면 기준을 잡음", () => {
    const s = new CameraSetup();
    run(0, 1.2, 0.05, (t) => s.feed(t, info(), CENTER));
    expect(s.step).toBe("lens");
    run(1.25, 4.0, 0.05, (t) => s.feed(t, info({ pitch: 2 }), CENTER));
    expect(s.step).toBe("screen");
    run(4.05, 8, 0.05, (t) => s.feed(t, info({ pitch: 8, yaw: 3 }), CENTER));
    expect(s.step).toBe("done");
    expect(s.baseline!.pitch).toBeCloseTo(8);
    expect(s.apply(info({ yaw: 3, pitch: 8 })).yaw).toBeCloseTo(0);
  });

  it("흔들리면 렌즈 단계를 끝내지 않음", () => {
    const s = new CameraSetup();
    run(0, 1.2, 0.05, (t) => s.feed(t, info(), CENTER));
    run(1.25, 6, 0.05, (t) => s.feed(t, info({ yaw: Math.round(t * 20) % 2 ? 8 : -8 }), CENTER));
    expect(s.step).toBe("lens");
  });
});

describe("자세 규칙", () => {
  const base = { box: CENTER, gazeStd: 0.02 };

  it("20° 이상 2초 돌리면 turn", () => {
    const r = new PostureRules(base);
    let out: string[] = [];
    run(0, 1.9, 0.05, (t) => (out = r.update(t, { yaw: 25, pitch: 0 }, info(), CENTER)));
    expect(out).not.toContain("turn");
    run(1.95, 2.1, 0.05, (t) => (out = r.update(t, { yaw: 25, pitch: 0 }, info(), CENTER)));
    expect(out).toContain("turn");
  });

  it("얼굴이 0.5초 미만 끊겨도 돌림 타이머 유지", () => {
    const r = new PostureRules(base);
    let out: string[] = [];
    run(0, 1.0, 0.05, (t) => r.update(t, { yaw: 25, pitch: 0 }, info(), CENTER));
    run(1.05, 1.3, 0.05, (t) => r.update(t, null, null, null));
    run(1.35, 2.1, 0.05, (t) => (out = r.update(t, { yaw: 25, pitch: 0 }, info(), CENTER)));
    expect(out).toContain("turn");
  });

  it("자리를 옮긴 동안은 돌림이 아니라 shift", () => {
    const r = new PostureRules(base);
    const moved = { ...CENTER, cx: 0.63 };
    let out: string[] = [];
    run(0, 2.5, 0.05, (t) => (out = r.update(t, { yaw: 25, pitch: 0 }, info(), moved)));
    expect(out).toContain("shift");
    expect(out).not.toContain("turn");
  });

  it("화면 가운데를 벗어나면 center (shift 아님)", () => {
    const r = new PostureRules(base);
    let out: string[] = [];
    run(0, 2.5, 0.05, (t) => (out = r.update(t, { yaw: 0, pitch: 0 }, info(), { ...CENTER, cx: 0.75 })));
    expect(out).toContain("center");
    expect(out).not.toContain("shift");
  });

  it("앞뒤로 크게 움직이면 shift", () => {
    const r = new PostureRules(base);
    let out: string[] = [];
    run(0, 2.5, 0.05, (t) => (out = r.update(t, { yaw: 0, pitch: 0 }, info(), { ...CENTER, w: 0.4 })));
    expect(out).toContain("shift");
  });

  it("눈동자가 계속 흔들리면 gaze, 가만히 있으면 없음", () => {
    const still = new PostureRules(base), shaky = new PostureRules(base);
    let a: string[] = [], b: string[] = [];
    run(0, 7, 0.05, (t) => {
      a = still.update(t, { yaw: 0, pitch: 0 }, info({ gazeX: 0.01 }), CENTER);
      b = shaky.update(t, { yaw: 0, pitch: 0 }, info({ gazeX: Math.round(t * 10) % 2 ? 0.4 : -0.4 }), CENTER);
    });
    expect(a).not.toContain("gaze");
    expect(b).toContain("gaze");
  });
});

describe("음성", () => {
  const vb = { noiseRms: 0.001, noiseDb: -60, voiceDb: -30 };
  const VOICE = 0.03; // -30 dB

  it("소음의 3배를 0.15초 넘으면 말함", () => {
    const v = new EnergyVad(0.001);
    expect(v.feed(0, 0.01)).toBe(false);
    expect(v.feed(0.15, 0.01)).toBe(true);
  });

  it("답변 시작부터 5초 말이 없으면 stuck", () => {
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 4.9, 0.03, (t) => (out = r.update(t, 0.001)));
    expect(out).not.toContain("stuck");
    run(4.93, 5.2, 0.03, (t) => (out = r.update(t, 0.001)));
    expect(out).toContain("stuck");
  });

  it("말하면 stuck이 풀림", () => {
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 5.5, 0.03, (t) => r.update(t, 0.001));
    run(5.53, 6.5, 0.03, (t) => (out = r.update(t, VOICE)));
    expect(out).not.toContain("stuck");
  });

  it("기준보다 6dB 넘게 작게 계속 말하면 quiet", () => {
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 20, 0.03, (t) => (out = r.update(t, 0.012))); // 약 -38 dB
    expect(out).toContain("quiet");
    const ok = new VoiceRules(vb, 0);
    run(0, 20, 0.03, (t) => (out = ok.update(t, VOICE)));
    expect(out).not.toContain("quiet");
  });

  it("바닥 소음이 10dB 넘게 오르면 noise", () => {
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 10, 0.03, (t) => (out = r.update(t, 0.001)));
    expect(out).not.toContain("noise");
    run(10.03, 20, 0.03, (t) => (out = r.update(t, 0.0025))); // -52 dB: 소음 +8 dB
    expect(out).not.toContain("noise");
    const loud = new VoiceRules(vb, 0);
    run(0, 10, 0.03, (t) => (out = loud.update(t, 0.0025)));
    run(10.03, 20, 0.03, (t) => (out = loud.update(t, 0.004))); // -48 dB: +12 dB
    expect(out).toContain("noise");
  });

  it("세팅: 조용히 있을 때 소리가 크면 소음을 다시 잼", () => {
    const s = new VoiceSetup();
    run(0, 1.6, 0.03, (t) => s.feed(t, 0.03));
    expect(s.step).toBe("noise");
    expect(s.message).toBe("noise_high");
    run(1.63, 3.4, 0.03, (t) => s.feed(t, 0.001));
    expect(s.step).toBe("voice");
  });

  it("세팅: 소음 → 문장 읽기 → 기준 확정, 너무 작으면 다시", () => {
    const s = new VoiceSetup();
    run(0, 1.6, 0.03, (t) => s.feed(t, 0.001));
    expect(s.step).toBe("voice");
    run(1.63, 6, 0.03, (t) => s.feed(t, 0.005)); // -46 dB
    expect(s.message).toBe("voice_low");
    run(6.03, 10, 0.03, (t) => s.feed(t, VOICE));
    expect(s.step).toBe("done");
    expect(s.voiceDb!).toBeCloseTo(-30.5, 0);
  });
});

describe("알림 간격", () => {
  it("한 번 띄우면 20초 동안 다른 경고는 기다리다 기록만", () => {
    const g = new FeedbackGate();
    expect(g.update(0, ["turn"])).toEqual(["turn"]);
    expect(g.update(3, ["turn", "quiet"])).toEqual([]);
    g.update(12, ["turn", "quiet"]);
    expect(g.log.find((l) => l.name === "quiet")!.reason).toBe("EXPIRED");
  });

  it("같은 종류는 45초 안에 다시 안 띄움", () => {
    const g = new FeedbackGate();
    g.update(0, ["turn"]);
    g.update(5, []);
    g.update(30, ["turn"]);
    expect(g.log.at(-1)!.reason).toBe("TYPE_COOLDOWN");
  });

  it("얼굴 안 보임·침묵은 간격과 상관없이 바로", () => {
    const g = new FeedbackGate();
    g.update(0, ["turn"]);
    expect(g.update(1, ["stuck"])).toContain("stuck");
  });

  it("답변 통계에 띄운 것·못 띄운 것 모두 집계", () => {
    const c = new AnswerCoach({ box: CENTER, gazeStd: 0.02 }, null, 0, "q");
    run(0, 3, 0.05, (t) => c.onFrame(t, { yaw: 30, pitch: 0 }, info(), CENTER));
    run(3.05, 6, 0.05, (t) => c.onFrame(t, { yaw: 0, pitch: 20 }, info(), CENTER));
    const s = c.finish(6);
    expect(s.alerts.map((a) => a.name).sort()).toEqual(["down", "turn"]);
    expect(s.alerts.find((a) => a.name === "turn")!.shown).toBe(1);
    expect(s.alerts.find((a) => a.name === "down")!.shown).toBe(0);
  });
});
