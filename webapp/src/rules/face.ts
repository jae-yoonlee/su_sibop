// MediaPipe 결과 → 각도·눈동자·얼굴 위치. step2_face_landmarks.py의 analyze()와 camera_setup.py의 face_box()를 옮김.

export interface FaceInfo {
  yaw: number;
  pitch: number;
  roll: number;
  blink: number; // 두 눈 감음 점수 중 큰 값
  gazeX: number; // 눈동자 방향 (-1~1). 거울 화면이라 부호는 믿지 않고 본인 기준과 비교해서만 씀
  gazeY: number;
  gazeSrc: "iris" | "blend"; // 눈동자 방향을 어디서 얻었는지
  jaw: number; // 입 벌림 점수 (0~1). 말소리가 들리는데 입이 안 움직이면 다른 사람·TV 소리로 봄
}

export interface FaceBox {
  cx: number; // 거울 화면 기준 가로 중심 (0=왼쪽)
  cy: number;
  w: number;
}

export interface Landmark {
  x: number;
  y: number;
}

/** 4x4 행렬의 (행 r, 열 c). MediaPipe 웹은 열 우선(column-major)으로 주지만, 이동 성분 위치로 확인해 둘 다 처리한다. */
export function matrixGetter(data: ArrayLike<number>): (r: number, c: number) => number {
  // 열 우선이면 이동(z)이 data[14], 행 우선이면 data[11]. 얼굴은 카메라 앞 수십 cm라 |z|가 큼.
  const columnMajor = Math.abs(data[14]) >= Math.abs(data[11]);
  return columnMajor ? (r, c) => data[c * 4 + r] : (r, c) => data[r * 4 + c];
}

const deg = (rad: number) => (rad * 180) / Math.PI;

export function headAngles(data: ArrayLike<number>): { yaw: number; pitch: number; roll: number } {
  const m = matrixGetter(data);
  const pitch = deg(Math.atan2(m(2, 1), m(2, 2)));
  const yaw = deg(Math.atan2(-m(2, 0), Math.hypot(m(2, 1), m(2, 2))));
  const roll = deg(Math.atan2(m(1, 0), m(0, 0)));
  return { yaw, pitch, roll };
}

// 홍채 위치로 시선 방향 (MediaPipe 얼굴 점 478개 중 468~477이 홍채).
// 눈 양끝 사이에서 홍채 중심이 어디 있는지(가로), 위아래 눈꺼풀 사이 어디 있는지(세로)를 0~1로 잰다.
// 표정 점수(eyeLook*)는 눈 모양 전체에서 추정한 값이라 작은 움직임에 둔해서, 점 좌표로 직접 잰 값을 먼저 쓴다.
const EYES = [
  { iris: 468, a: 33, b: 133, top: 159, bottom: 145 }, // 화면 왼쪽 눈 (바깥 끝 → 안쪽 끝)
  { iris: 473, a: 362, b: 263, top: 386, bottom: 374 }, // 화면 오른쪽 눈 (안쪽 끝 → 바깥 끝)
];
/** 홍채가 눈 안에서 움직이는 폭은 눈 길이의 ±25% 안팎이라, 4배 해서 표정 점수와 같은 -1~1 범위로 맞춘다 [가설] */
export const IRIS_SCALE = 4;

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

export function irisGaze(points: ArrayLike<Landmark>): { x: number; y: number } | null {
  if (points.length < 478) return null;
  let x = 0, y = 0;
  for (const e of EYES) {
    const [i, a, b, top, bottom] = [points[e.iris], points[e.a], points[e.b], points[e.top], points[e.bottom]];
    const w = b.x - a.x, h = bottom.y - top.y;
    if (Math.abs(w) < 1e-4 || Math.abs(h) < 1e-4) return null;
    x += (i.x - a.x) / w - 0.5;
    y += (i.y - top.y) / h - 0.5;
  }
  return { x: clamp1((x / 2) * IRIS_SCALE), y: clamp1((-y / 2) * IRIS_SCALE) };
}

export function analyze(matrix: ArrayLike<number>, blend: Record<string, number>, points?: ArrayLike<Landmark>): FaceInfo {
  const s = (k: string) => blend[k] ?? 0;
  const iris = points ? irisGaze(points) : null;
  return {
    ...headAngles(matrix),
    blink: Math.max(s("eyeBlinkLeft"), s("eyeBlinkRight")),
    gazeX: iris?.x ?? (s("eyeLookOutLeft") + s("eyeLookInRight") - s("eyeLookInLeft") - s("eyeLookOutRight")) / 2,
    gazeY: iris?.y ?? (s("eyeLookUpLeft") + s("eyeLookUpRight") - s("eyeLookDownLeft") - s("eyeLookDownRight")) / 2,
    gazeSrc: iris ? "iris" : "blend",
    jaw: s("jawOpen"),
  };
}

/** 랜드마크 → 얼굴 중심·폭 (화면 비율). Python은 거울로 뒤집은 프레임을 썼으므로 x를 뒤집어 같은 기준으로 맞춘다. */
export function faceBox(points: Landmark[]): FaceBox {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const p of points) {
    const x = 1 - p.x;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 };
}
