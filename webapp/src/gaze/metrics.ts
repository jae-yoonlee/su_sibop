// 시선 측정 계산: 화면이 "여기를 보세요"라고 띄운 곳(정답)과 규칙 판정(딴 곳 보기)을 프레임마다 비교한다.
// 정답을 사람이 표시할 필요가 없도록, 띄운 시각이 곧 정답이다. 띄운 직후 CUE_SETTLE_SEC는 시선이 옮겨 가는 중이라 뺀다.
import { segDist } from "../rules/postureRules";

export const CUE_SEC = 4; // 한 곳을 보는 시간
export const CUE_SETTLE_SEC = 1; // 앞의 이 시간은 계산에서 뺌

export interface Cue {
  id: string;
  label: string; // 화면 안내 문구
  away: boolean; // 정답: 이곳을 보면 '딴 곳 보기'여야 하나
  x: number; // 화면 위 표시 위치 (0~1)
  y: number;
  eyesOnly?: boolean; // 고개는 그대로, 눈만
}

/** 렌즈와 질문 카드는 봐도 되는 곳, 나머지는 딴 곳. 눈만 움직이는 칸은 홍채 방식의 차이를 보려고 넣음 */
export const CUES: Cue[] = [
  { id: "lens", label: "카메라 렌즈", away: false, x: 0.5, y: 0.02 },
  { id: "card", label: "질문 카드", away: false, x: 0.5, y: 0.22 },
  { id: "memo", label: "왼쪽 아래 메모", away: true, x: 0.05, y: 0.92 },
  { id: "right", label: "오른쪽 끝", away: true, x: 0.97, y: 0.5 },
  { id: "left", label: "왼쪽 끝", away: true, x: 0.03, y: 0.5 },
  { id: "down", label: "아래 키보드", away: true, x: 0.5, y: 0.98 },
  { id: "eyes-left", label: "고개는 그대로, 눈만 왼쪽 끝", away: true, x: 0.03, y: 0.3, eyesOnly: true },
  { id: "eyes-right", label: "고개는 그대로, 눈만 오른쪽 끝", away: true, x: 0.97, y: 0.3, eyesOnly: true },
];

/** 두 바퀴, 매번 순서를 섞음 (같은 순서 연습 효과 방지) */
export function cueOrder(rand: () => number = Math.random, rounds = 2): Cue[] {
  const out: Cue[] = [];
  for (let r = 0; r < rounds; r++) {
    const a = [...CUES];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    out.push(...a);
  }
  return out;
}

export interface Frame {
  t: number; // 이 칸이 뜬 뒤 초
  cue: string;
  away: boolean; // 정답
  yaw: number; // 정면 기준으로 보정한 각도
  pitch: number;
  blink: number;
  iris: [number, number] | null;
  blend: [number, number];
}

export interface Target {
  yaw: number;
  pitch: number;
  iris: [number, number] | null;
  blend: [number, number];
}

export type Src = "iris" | "blend";

/** 한 프레임 판정 (앱의 lookingAway와 같은 식, 기준값만 바꿔 가며). 눈 감은 프레임은 null */
export function judgeFrame(f: Frame, targets: [Target, Target], src: Src, eyeTol: number, headDeg: number, blinkSkip = 0.5): boolean | null {
  const [a, b] = targets;
  if (segDist([f.yaw, f.pitch], [a.yaw, a.pitch], [b.yaw, b.pitch]) > headDeg) return true;
  if (f.blink >= blinkSkip) return null;
  const g = f[src], ga = a[src], gb = b[src];
  if (!g || !ga || !gb) return null;
  return segDist(g, ga, gb) > eyeTol;
}

export interface Score {
  src: Src;
  eyeTol: number;
  headDeg: number;
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number; // 딴 곳이라고 한 것 중 맞은 비율
  recall: number; // 실제 딴 곳 중 잡은 비율
  falseAlarm: number; // 봐도 되는 곳을 보는데 딴 곳이라고 한 비율
  eyesOnlyRecall: number; // 눈만 움직인 칸에서 잡은 비율
}

const ratio = (a: number, b: number) => (b ? a / b : NaN);

export function score(frames: Frame[], targets: [Target, Target], src: Src, eyeTol: number, headDeg: number): Score {
  let tp = 0, fp = 0, fn = 0, tn = 0, eTp = 0, eN = 0;
  const eyesOnly = new Set(CUES.filter((c) => c.eyesOnly).map((c) => c.id));
  for (const f of frames) {
    if (f.t < CUE_SETTLE_SEC) continue;
    const p = judgeFrame(f, targets, src, eyeTol, headDeg);
    if (p === null) continue;
    if (p && f.away) tp++;
    else if (p) fp++;
    else if (f.away) fn++;
    else tn++;
    if (eyesOnly.has(f.cue)) {
      eN++;
      if (p) eTp++;
    }
  }
  return {
    src, eyeTol, headDeg, n: tp + fp + fn + tn, tp, fp, fn, tn,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), falseAlarm: ratio(fp, fp + tn), eyesOnlyRecall: ratio(eTp, eN),
  };
}

export const EYE_TOLS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
export const HEAD_DEGS = [8, 12, 16];

/** 기준값을 바꿔 가며 전부 계산 (곡선). 오경보 10% 이하 중 가장 많이 잡는 값을 추천 [기준: 가설] */
export function sweep(frames: Frame[], targets: [Target, Target]) {
  const all: Score[] = [];
  for (const src of ["iris", "blend"] as Src[]) for (const h of HEAD_DEGS) for (const e of EYE_TOLS) all.push(score(frames, targets, src, e, h));
  const pick = (src: Src) =>
    all.filter((s) => s.src === src && s.falseAlarm <= 0.1).sort((a, b) => b.recall - a.recall)[0] ?? null;
  return { all, best: { iris: pick("iris"), blend: pick("blend") } };
}

/** 세팅 프레임들의 평균 → 기준점 */
export function meanTarget(frames: Omit<Frame, "t" | "cue" | "away">[]): Target {
  const m = (f: (x: (typeof frames)[0]) => number) => frames.reduce((a, x) => a + f(x), 0) / Math.max(frames.length, 1);
  const withIris = frames.filter((f) => f.iris);
  const mi = (k: 0 | 1) => withIris.reduce((a, x) => a + x.iris![k], 0) / withIris.length;
  return {
    yaw: m((f) => f.yaw),
    pitch: m((f) => f.pitch),
    iris: withIris.length ? [mi(0), mi(1)] : null,
    blend: [m((f) => f.blend[0]), m((f) => f.blend[1])],
  };
}
