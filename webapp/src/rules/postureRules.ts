// 자세 규칙: 얼굴 안 보임·고개 돌림·숙임(step3_coaching.CoachRules), 자리 이동(coach_engine), 중앙 이탈·눈동자(웹에서 추가).
import {
  CENTER_X_TOL, CENTER_Y_RANGE, FACE_GAP_SEC, GAZE_BASE_RATIO, GAZE_BLINK_SKIP, GAZE_MIN_STD, GAZE_WINDOW_SEC,
  HOLD_SEC, MIN_SHOW_SEC, PITCH_LIMIT, SHIFT_SIZE_RATIO, SHIFT_TOL, YAW_LIMIT,
} from "./constants";
import { EventTracker } from "./events";
import type { FaceBox, FaceInfo } from "./face";
import { std } from "./stats";

export type PostureAlert = "away" | "turn" | "down" | "center" | "shift" | "gaze";
const ORDER: PostureAlert[] = ["away", "turn", "down", "center", "shift", "gaze"];

export interface PostureBase {
  box: FaceBox; // 세팅 때 얼굴 위치
  gazeStd: number; // 세팅 때 눈동자 흔들림
}

export function offCenter(box: FaceBox) {
  return Math.abs(box.cx - 0.5) > CENTER_X_TOL || box.cy < CENTER_Y_RANGE[0] || box.cy > CENTER_Y_RANGE[1];
}

export function shifted(box: FaceBox, base: FaceBox) {
  return Math.abs(box.cx - base.cx) > SHIFT_TOL || Math.abs(box.w / base.w - 1) > SHIFT_SIZE_RATIO;
}

export class PostureRules {
  held: Record<string, number> = {};
  gazeStd: number | null = null;
  readonly tracker = new EventTracker();
  private since = new Map<string, number>();
  private lastOn = new Map<string, number>();
  private gaze: { t: number; x: number; y: number }[] = [];

  constructor(private base: PostureBase) {}

  /** cond가 연속으로 참인 시간. keep이면 타이머를 그대로 둔다 (얼굴이 잠깐 끊긴 경우). */
  private hold(name: string, cond: boolean, t: number, keep = false) {
    if (keep) return this.since.has(name) ? t - this.since.get(name)! : 0;
    if (!cond) {
      this.since.delete(name);
      return 0;
    }
    if (!this.since.has(name)) this.since.set(name, t);
    return t - this.since.get(name)!;
  }

  private gazeShaky(t: number, info: FaceInfo | null): boolean {
    if (info && info.blink < GAZE_BLINK_SKIP) this.gaze.push({ t, x: info.gazeX, y: info.gazeY });
    while (this.gaze.length && t - this.gaze[0].t > GAZE_WINDOW_SEC) this.gaze.shift();
    if (this.gaze.length < 10 || t - this.gaze[0].t < GAZE_WINDOW_SEC * 0.8) {
      this.gazeStd = null;
      return false;
    }
    this.gazeStd = Math.hypot(std(this.gaze.map((g) => g.x)), std(this.gaze.map((g) => g.y)));
    return this.gazeStd >= Math.max(GAZE_MIN_STD, this.base.gazeStd * GAZE_BASE_RATIO);
  }

  /** angles: 정면 기준으로 보정한 각도 (얼굴 없으면 null) */
  update(t: number, angles: { yaw: number; pitch: number } | null, info: FaceInfo | null, box: FaceBox | null): PostureAlert[] {
    const face = angles !== null && box !== null;
    const away = this.hold("away", !face, t);
    const gap = !face && away < FACE_GAP_SEC;
    const isCenter = face && offCenter(box!);
    const isShift = face && !isCenter && shifted(box!, this.base.box);
    // 몸이 옆으로 가면 고개를 안 돌려도 yaw가 돌아간 것처럼 나와서, 이동 중엔 돌림으로 세지 않음 (coach_engine과 같음)
    const yawOk = isCenter || isShift;
    this.held = {
      away,
      turn: this.hold("turn", face && !yawOk && Math.abs(angles!.yaw) >= YAW_LIMIT, t, gap),
      down: this.hold("down", face && angles!.pitch >= PITCH_LIMIT, t, gap),
      center: this.hold("center", isCenter, t, gap),
      shift: this.hold("shift", isShift, t, gap),
      gaze: this.hold("gaze", face && this.gazeShaky(t, info), t, gap),
    };
    for (const [k, sec] of Object.entries(this.held)) if (sec >= HOLD_SEC) this.lastOn.set(k, t);
    const active = ORDER.filter((k) => this.lastOn.has(k) && t - this.lastOn.get(k)! < MIN_SHOW_SEC);
    this.tracker.track(active, t);
    return active;
  }
}
