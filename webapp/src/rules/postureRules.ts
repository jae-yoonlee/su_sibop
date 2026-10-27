// 자세 규칙: 얼굴 안 보임·고개 돌림·숙임(step3_coaching.CoachRules), 자리 이동(coach_engine), 중앙 이탈·눈동자·딴 곳 보기(웹에서 추가).
import {
  CENTER_X_TOL, CENTER_Y_RANGE, FACE_GAP_SEC, GAZE_BASE_RATIO, GAZE_BLINK_SKIP, GAZE_MIN_STD, GAZE_WINDOW_SEC,
  HOLD_SEC, LOOK_EYE_TOL, LOOK_HEAD_DEG, LOOK_HOLD_SEC, MIN_SHOW_SEC, PITCH_LIMIT, SHIFT_SIZE_RATIO, SHIFT_TOL, SHIFT_Y_TOL, YAW_LIMIT,
} from "./constants";
import { EventTracker } from "./events";
import type { FaceBox, FaceInfo } from "./face";
import { std } from "./stats";

export type PostureAlert = "away" | "turn" | "down" | "center" | "shift" | "look" | "gaze";
const ORDER: PostureAlert[] = ["away", "turn", "down", "center", "shift", "look", "gaze"];

/** 세팅 때 렌즈·질문 카드를 볼 때의 얼굴 각도(정면 기준)와 눈동자 방향 */
export interface LookTarget {
  yaw: number;
  pitch: number;
  gx: number;
  gy: number;
}

export interface PostureBase {
  box: FaceBox; // 세팅 때 얼굴 위치
  gazeStd: number; // 세팅 때 눈동자 흔들림
  targets?: LookTarget[]; // 렌즈, 질문 카드 (없으면 딴 곳 보기 판정 안 함)
}

/** 점 p에서 선분 a–b까지 거리 (렌즈와 질문 카드 사이를 오가며 보는 것도 정상) */
export function segDist(p: [number, number], a: [number, number], b: [number, number]) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy);
}

/** 얼굴이나 눈동자가 렌즈~질문 카드 범위를 벗어났는지. 눈 감은 프레임은 판단 보류(null). */
export function lookingAway(angles: { yaw: number; pitch: number }, info: FaceInfo, targets: LookTarget[]): boolean | null {
  const [a, b] = targets;
  if (segDist([angles.yaw, angles.pitch], [a.yaw, a.pitch], [b.yaw, b.pitch]) > LOOK_HEAD_DEG) return true;
  if (info.blink >= GAZE_BLINK_SKIP) return null;
  return segDist([info.gazeX, info.gazeY], [a.gx, a.gy], [b.gx, b.gy]) > LOOK_EYE_TOL;
}

export function offCenter(box: FaceBox) {
  return Math.abs(box.cx - 0.5) > CENTER_X_TOL || box.cy < CENTER_Y_RANGE[0] || box.cy > CENTER_Y_RANGE[1];
}

/** 세팅 때 자리에서 벗어난 축들 (가로 x, 세로 y, 앞뒤 size). 비어 있으면 제자리 */
export function shiftAxes(box: FaceBox, base: FaceBox): ("x" | "y" | "size")[] {
  const out: ("x" | "y" | "size")[] = [];
  if (Math.abs(box.cx - base.cx) > SHIFT_TOL) out.push("x");
  if (Math.abs(box.cy - base.cy) > SHIFT_Y_TOL) out.push("y");
  // 앞뒤: 얼굴 폭은 고개를 돌리거나 기울이면 20% 넘게 줄어 '자리 이동' 오경보가 났다 (2026-10-27 실사용, shiftBy size 9초).
  // 거리(z)가 있으면 거리 비율로 본다. 거리가 1.25배면 얼굴 폭이 0.8배인 것과 같음
  const ratio = box.z && base.z ? base.z / box.z : box.w / base.w;
  if (Math.abs(ratio - 1) > SHIFT_SIZE_RATIO) out.push("size");
  return out;
}

export class PostureRules {
  held: Record<string, number> = {};
  gazeStd: number | null = null;
  readonly tracker = new EventTracker();
  private since = new Map<string, number>();
  private lastOn = new Map<string, number>();
  private gaze: { t: number; x: number; y: number }[] = [];
  private lookAway = false;
  private lastT: number | null = null;
  /** 자리 이동으로 본 시간(초)을 축별로. 오경보가 어느 축 때문인지 검증용 */
  shiftBy = { x: 0, y: 0, size: 0 };

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

  /** 고개 돌림·숙임 경고가 따로 있으니 그 수준이면 여기선 빼고, 눈 감은 순간은 직전 판정 유지 */
  private looking(angles: { yaw: number; pitch: number }, info: FaceInfo | null): boolean {
    if (!this.base.targets || !info) return false;
    if (Math.abs(angles.yaw) >= YAW_LIMIT || angles.pitch >= PITCH_LIMIT) return (this.lookAway = false);
    const r = lookingAway(angles, info, this.base.targets);
    if (r !== null) this.lookAway = r;
    return this.lookAway;
  }

  /** angles: 정면 기준으로 보정한 각도 (얼굴 없으면 null) */
  update(t: number, angles: { yaw: number; pitch: number } | null, info: FaceInfo | null, box: FaceBox | null): PostureAlert[] {
    const face = angles !== null && box !== null;
    const away = this.hold("away", !face, t);
    const gap = !face && away < FACE_GAP_SEC;
    const isCenter = face && offCenter(box!);
    const axes = face && !isCenter ? shiftAxes(box!, this.base.box) : [];
    const isShift = axes.length > 0;
    const dt = this.lastT === null ? 0 : Math.min(0.5, t - this.lastT);
    this.lastT = t;
    for (const a of axes) this.shiftBy[a] += dt;
    // 몸이 옆으로 가면 고개를 안 돌려도 yaw가 돌아간 것처럼 나와서, 이동 중엔 돌림으로 세지 않음 (coach_engine과 같음)
    const yawOk = isCenter || isShift;
    this.held = {
      away,
      turn: this.hold("turn", face && !yawOk && Math.abs(angles!.yaw) >= YAW_LIMIT, t, gap),
      down: this.hold("down", face && angles!.pitch >= PITCH_LIMIT, t, gap),
      center: this.hold("center", isCenter, t, gap),
      shift: this.hold("shift", isShift, t, gap),
      look: this.hold("look", face && !yawOk && this.looking(angles!, info), t, gap),
      gaze: this.hold("gaze", face && this.gazeShaky(t, info), t, gap),
    };
    for (const [k, sec] of Object.entries(this.held)) if (sec >= (k === "look" ? LOOK_HOLD_SEC : HOLD_SEC)) this.lastOn.set(k, t);
    const active = ORDER.filter((k) => this.lastOn.has(k) && t - this.lastOn.get(k)! < MIN_SHOW_SEC);
    this.tracker.track(active, t);
    return active;
  }
}
