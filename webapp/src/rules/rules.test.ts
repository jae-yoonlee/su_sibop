import { describe, expect, it } from "vitest";
import { CameraSetup, positionIssue } from "./cameraSetup";
import { headAngles, faceBox, type FaceInfo } from "./face";
import { FeedbackGate } from "./gate";
import { PostureRules } from "./postureRules";
import { AnswerCoach } from "./session";
import { EnergyVad, SileroGate, VoiceRules, VoiceSetup } from "./voice";

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

  it("위아래로 움직여도 shift", () => {
    const r = new PostureRules(base);
    let out: string[] = [];
    run(0, 2.5, 0.05, (t) => (out = r.update(t, { yaw: 0, pitch: 0 }, info(), { ...CENTER, cy: CENTER.cy + 0.1 })));
    expect(out).toContain("shift");
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

  describe("카메라·질문 말고 딴 곳 보기", () => {
    // 렌즈는 정면보다 10° 위, 질문 카드는 정면. 눈동자도 각각 기록
    const targets = [{ yaw: 0, pitch: -10, gx: 0, gy: 0.1 }, { yaw: 0, pitch: 0, gx: 0, gy: 0 }];
    const look = (angles: { yaw: number; pitch: number }, f: FaceInfo, sec = 2.2) => {
      const r = new PostureRules({ ...base, targets });
      let out: string[] = [];
      run(0, sec, 0.05, (t) => (out = r.update(t, angles, f, CENTER)));
      return out;
    };

    it("렌즈와 질문 사이를 보면 괜찮음", () => {
      expect(look({ yaw: 0, pitch: -5 }, info({ gazeY: 0.05 }))).not.toContain("look");
      expect(look({ yaw: 8, pitch: 0 }, info())).not.toContain("look");
    });

    it("고개는 정면인데 눈만 옆을 2초 넘게 보면 look", () => {
      expect(look({ yaw: 0, pitch: 0 }, info({ gazeX: 0.5 }))).toContain("look");
      expect(look({ yaw: 0, pitch: 0 }, info({ gazeX: 0.5 }), 1.8)).not.toContain("look");
    });

    it("고개를 15° 옆으로(돌림 경고 20° 전) 2초 넘게 돌리면 look", () => {
      expect(look({ yaw: 15, pitch: 0 }, info())).toContain("look");
    });

    it("20° 넘게 돌리면 돌림 경고만 (겹치지 않게)", () => {
      const out = look({ yaw: 25, pitch: 0 }, info());
      expect(out).toContain("turn");
      expect(out).not.toContain("look");
    });

    it("눈 감은 순간은 판정을 끊지 않음", () => {
      const r = new PostureRules({ ...base, targets });
      let out: string[] = [];
      run(0, 2.2, 0.05, (t) => (out = r.update(t, { yaw: 0, pitch: 0 }, info({ gazeX: 0.5, blink: t > 1 && t < 1.2 ? 0.9 : 0 }), CENTER)));
      expect(out).toContain("look");
    });
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

  it("숨소리·잡음 수준의 작은 소리는 침묵을 끊지 않음", () => {
    // 목소리 기준 -20dB. 소리 -46dB는 소음(-60dB)의 5배라 예전엔 '말함'이었지만, 목소리보다 26dB 작음
    const r = new VoiceRules({ ...vb, voiceDb: -20 }, 0);
    let out: string[] = [];
    run(0, 5.5, 0.03, (t) => (out = r.update(t, 0.005)));
    expect(out).toContain("stuck");
  });

  it("짧은 소리(0.3초 미만)는 침묵을 끊지 않음", () => {
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 3, 0.03, (t) => r.update(t, 0.001));
    run(3.03, 3.2, 0.03, (t) => r.update(t, VOICE));
    run(3.23, 5.3, 0.03, (t) => (out = r.update(t, 0.001)));
    expect(out).toContain("stuck");
  });

  it("30초 안에 침묵이 두 번 와도 두 번 셈", () => {
    const r = new VoiceRules(vb, 0);
    run(0, 6, 0.03, (t) => r.update(t, 0.001));
    run(6.03, 8, 0.03, (t) => r.update(t, VOICE));
    run(8.03, 14.5, 0.03, (t) => r.update(t, 0.001));
    r.tracker.finish(14.5);
    expect(r.tracker.events.filter((e) => e.name === "stuck")).toHaveLength(2);
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

  it("Silero 판정: 0.5 넘으면 켜고, 0.35 아래 0.3초 이어져야 끔", () => {
    const g = new SileroGate();
    expect(g.feed(0, 0.6)).toBe(true);
    expect(g.feed(0.1, 0.2)).toBe(true); // 말 사이 짧은 틈
    expect(g.feed(0.2, 0.45)).toBe(true); // 애매한 값은 그대로 유지
    expect(g.feed(0.3, 0.1)).toBe(true);
    expect(g.feed(0.6, 0.1)).toBe(false);
    expect(g.at(0.6)).toBe(false);
    expect(g.at(2)).toBeNull(); // 판정이 끊기면 음량 판정으로
  });

  it("시끄러운 곳: 소음이 커도 Silero가 말 아니라고 하면 침묵으로 셈", () => {
    // 음량 판정은 목소리만큼 큰 소음(-30dB)을 말로 봐서 침묵을 못 잡음
    const energy = new VoiceRules(vb, 0);
    const silero = new VoiceRules(vb, 0);
    let e: string[] = [], s: string[] = [];
    run(0, 6, 0.03, (t) => {
      e = energy.update(t, VOICE);
      s = silero.update(t, VOICE, false);
    });
    expect(e).not.toContain("stuck");
    expect(s).toContain("stuck");
    expect(silero.sileroBlocks).toBe(silero.blocks);
  });

  it("Silero 모드: 말소리라도 내 목소리보다 20dB 넘게 작으면(먼 데 말소리) 침묵 유지", () => {
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 5.5, 0.03, (t) => (out = r.update(t, 0.002, true))); // -54dB
    expect(out).toContain("stuck");
    const me = new VoiceRules(vb, 0);
    run(0, 3, 0.03, (t) => me.update(t, 0.001, false));
    run(3.03, 5.5, 0.03, (t) => (out = me.update(t, VOICE, true)));
    expect(out).not.toContain("stuck");
  });

  it("Silero 모드: 말하는 구간은 빼고 바닥 소음을 잼", () => {
    // 말을 쉬지 않고 해도(하위 10%가 목소리) 주변 소음 경고가 뜨지 않아야
    const r = new VoiceRules(vb, 0);
    let out: string[] = [];
    run(0, 1, 0.03, (t) => r.update(t, 0.001, false));
    run(1.03, 20, 0.03, (t) => (out = r.update(t, VOICE, true)));
    expect(out).not.toContain("noise");
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
    run(1.63, 7, 0.03, (t) => s.feed(t, 0.005)); // -46 dB
    run(7.03, 8.6, 0.03, (t) => s.feed(t, 0.001)); // 읽기를 멈춤
    expect(s.message).toBe("voice_low");
    expect(s.attempt).toBe(1);
    run(8.63, 14, 0.03, (t) => s.feed(t, VOICE));
    expect(s.step).toBe("voice"); // 계속 읽는 중이면 기다림
    run(14.03, 15.6, 0.03, (t) => s.feed(t, 0.001));
    expect(s.step).toBe("done");
    expect(s.voiceDb!).toBeCloseTo(-30.5, 0);
  });

  it("세팅: 4초를 넘겨도 문장을 다 읽고 멈출 때까지 넘어가지 않음", () => {
    const s = new VoiceSetup();
    run(0, 1.6, 0.03, (t) => s.feed(t, 0.001));
    run(1.63, 6.5, 0.03, (t) => s.feed(t, VOICE)); // 약 4.8초 말함
    run(6.53, 7.0, 0.03, (t) => s.feed(t, 0.001)); // 0.5초 쉼 (문장 중간 숨 고르기)
    expect(s.step).toBe("voice");
    run(7.03, 9, 0.03, (t) => s.feed(t, VOICE));
    run(9.03, 10.6, 0.03, (t) => s.feed(t, 0.001));
    expect(s.step).toBe("done");
  });
});

describe("알림 간격", () => {
  it("한 번 띄우면 20초 동안 다른 경고는 기다리다 기록만", () => {
    const g = new FeedbackGate();
    expect(g.update(0, ["turn"])).toEqual(["turn"]);
    expect(g.update(3, ["turn", "noise"])).toEqual([]);
    g.update(12, ["turn", "noise"]);
    expect(g.log.find((l) => l.name === "noise")!.reason).toBe("EXPIRED");
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

  it("작은 목소리는 다른 경고와 같이, 이어지는 동안 계속", () => {
    const g = new FeedbackGate();
    g.update(0, ["turn"]);
    expect(g.update(1, ["turn", "quiet"]).sort()).toEqual(["quiet", "turn"]);
    expect(g.update(10, ["quiet"])).toEqual(["quiet"]);
    expect(g.log.filter((l) => l.name === "quiet" && l.outcome === "shown")).toHaveLength(1);
  });

  it("시선 경고는 간격 규칙과 따로 뜨고, 한 번 띄우면 5초 쉬고 다시 확인", () => {
    const g = new FeedbackGate();
    g.update(0, ["turn"]);
    expect(g.update(1, ["look"])).toContain("look"); // 20초 간격에 안 막힘
    expect(g.update(3, ["look"])).toContain("look"); // 카드 2.5초
    expect(g.update(4, ["look"])).not.toContain("look"); // 쉬는 중
    expect(g.update(8.4, ["look"])).not.toContain("look");
    expect(g.update(8.6, ["gaze"])).toContain("gaze"); // 끝나고 5초 뒤 다시 확인
    expect(g.log.filter((l) => l.reason === "EYE")).toHaveLength(2);
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
