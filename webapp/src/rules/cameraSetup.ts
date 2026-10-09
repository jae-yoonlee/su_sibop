// 카메라 세팅: 위치 → 렌즈 보기 → 질문 화면 보기. camera_setup.py의 CameraSetup을 옮기고 눈동자 기준을 추가.
import {
  CAMERA_HIGH_PITCH, CAMERA_LOW_PITCH, CENTER_X_TOL, CENTER_Y_RANGE, FACE_W_MAX, FACE_W_MIN,
  GAZE_BLINK_SKIP, LENS_MAX_YAW, POSITION_OK_SEC, SCREEN_GAP_WARN, SETTLE_SEC, STEADY_MAX_STD, STEADY_SEC,
} from "./constants";
import type { FaceBox, FaceInfo } from "./face";
import { mean, std } from "./stats";

export type SetupStep = "position" | "lens" | "screen" | "done";

export const SETUP_MESSAGES = {
  no_face: "얼굴이 보이지 않아요. 카메라 앞에 앉아 주세요",
  too_far: "조금 더 가까이 앉아 주세요",
  too_close: "조금 뒤로 물러나 주세요",
  move_left: "왼쪽으로 조금 옮겨 주세요",
  move_right: "오른쪽으로 조금 옮겨 주세요",
  too_high: "얼굴이 화면 위쪽에 있어요. 카메라를 조금 위로 향해 주세요",
  too_low: "얼굴이 화면 아래쪽에 있어요. 카메라를 조금 아래로 향해 주세요",
  position_ok: "좋아요. 그대로 계세요",
  lens: "카메라 렌즈를 2초 동안 바라봐 주세요",
  screen: "고개를 정면으로 하고, 질문이 뜰 위쪽 카드를 2초 동안 바라봐 주세요",
  camera_low: "카메라가 눈보다 낮아요. 노트북을 책 위에 올려 보세요",
  camera_high: "카메라가 눈보다 높아요. 카메라를 조금 낮춰 주세요",
  screen_gap: "화면과 카메라가 멀어서, 화면을 보는 것도 시선을 피하는 것처럼 보일 수 있어요",
  done: "카메라 준비 완료!",
} as const;
export type SetupMessage = keyof typeof SETUP_MESSAGES;

type Angles = { yaw: number; pitch: number; roll: number };
const ANGLE_KEYS = ["yaw", "pitch", "roll"] as const;

export function positionIssue(box: FaceBox | null): SetupMessage | null {
  if (!box) return "no_face";
  if (box.w < FACE_W_MIN) return "too_far";
  if (box.w > FACE_W_MAX) return "too_close";
  if (box.cx < 0.5 - CENTER_X_TOL) return "move_right";
  if (box.cx > 0.5 + CENTER_X_TOL) return "move_left";
  if (box.cy < CENTER_Y_RANGE[0]) return "too_high";
  if (box.cy > CENTER_Y_RANGE[1]) return "too_low";
  return null;
}

/** 최근 STEADY_SEC 동안 각도가 흔들림 없이 유지됐으면 평균 각도 */
export class SteadyWindow {
  private samples: { t: number; v: Angles; gx: number; gy: number; blink: number }[] = [];

  reset() {
    this.samples = [];
  }

  feed(t: number, info: FaceInfo): (Angles & { gazeStd: number }) | null {
    this.samples.push({ t, v: { yaw: info.yaw, pitch: info.pitch, roll: info.roll }, gx: info.gazeX, gy: info.gazeY, blink: info.blink });
    this.samples = this.samples.filter((s) => t - s.t <= STEADY_SEC);
    if (t - this.samples[0].t < STEADY_SEC - 0.05) return null;
    for (const k of ANGLE_KEYS) if (std(this.samples.map((s) => s.v[k])) > STEADY_MAX_STD) return null;
    const open = this.samples.filter((s) => s.blink < GAZE_BLINK_SKIP);
    const gazeStd = open.length ? Math.hypot(std(open.map((s) => s.gx)), std(open.map((s) => s.gy))) : 0;
    return {
      yaw: mean(this.samples.map((s) => s.v.yaw)),
      pitch: mean(this.samples.map((s) => s.v.pitch)),
      roll: mean(this.samples.map((s) => s.v.roll)),
      gazeStd,
    };
  }
}

export class CameraSetup {
  step: SetupStep = "position";
  message: SetupMessage = "no_face";
  lens: Angles | null = null;
  baseline: Angles | null = null; // 질문 화면을 볼 때 각도 → 정면(0°)
  baseBox: FaceBox | null = null; // 그때의 얼굴 위치 (자리 이동 판정 기준)
  baseGazeStd = 0; // 그때의 눈동자 흔들림
  warnings: SetupMessage[] = [];
  private okSince: number | null = null;
  private stepAt: number | null = null;
  private window = new SteadyWindow();

  get active() {
    return this.step !== "done";
  }

  restart() {
    Object.assign(this, new CameraSetup());
  }

  private go(step: SetupStep) {
    this.step = step;
    this.stepAt = null;
    this.window.reset();
    this.message = step === "done" ? "done" : step === "position" ? "no_face" : step;
  }

  feed(t: number, info: FaceInfo | null, box: FaceBox | null) {
    if (this.step === "done") return;
    if (this.step === "position") {
      const issue = positionIssue(box);
      if (issue) {
        this.okSince = null;
        this.message = issue;
        return;
      }
      this.okSince ??= t;
      this.message = "position_ok";
      if (t - this.okSince >= POSITION_OK_SEC) this.go("lens");
      return;
    }
    if (!info) {
      this.window.reset();
      this.message = "no_face";
      return;
    }
    this.message = this.step;
    this.stepAt ??= t;
    if (t - this.stepAt < SETTLE_SEC) return;
    const m = this.window.feed(t, info);
    if (!m) return;
    if (this.step === "lens") {
      if (Math.abs(m.yaw) > LENS_MAX_YAW) return this.window.reset();
      this.lens = m;
      this.go("screen");
    } else if (this.step === "screen") {
      if (Math.abs(m.yaw - this.lens!.yaw) > LENS_MAX_YAW) return this.window.reset();
      this.baseline = m;
      this.baseBox = box;
      this.baseGazeStd = m.gazeStd;
      this.warnings = this.diagnose();
      this.go("done");
    }
  }

  diagnose(): SetupMessage[] {
    const out: SetupMessage[] = [];
    const lens = this.lens!, base = this.baseline!;
    if (lens.pitch > CAMERA_LOW_PITCH) out.push("camera_low");
    else if (lens.pitch < CAMERA_HIGH_PITCH) out.push("camera_high");
    if (Math.abs(base.pitch - lens.pitch) > SCREEN_GAP_WARN) out.push("screen_gap");
    return out;
  }

  /** 보정된 각도 = 현재 각도 − 정면 기준 */
  apply(info: FaceInfo): Angles {
    const b = this.baseline!;
    return { yaw: info.yaw - b.yaw, pitch: info.pitch - b.pitch, roll: info.roll - b.roll };
  }
}
