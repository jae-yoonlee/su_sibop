// MediaPipe 결과 → 각도·눈동자·얼굴 위치. step2_face_landmarks.py의 analyze()와 camera_setup.py의 face_box()를 옮김.

export interface FaceInfo {
  yaw: number;
  pitch: number;
  roll: number;
  blink: number; // 두 눈 감음 점수 중 큰 값
  gazeX: number; // 눈동자 방향 (-1~1). 거울 화면이라 부호는 믿지 않고 본인 기준과 비교해서만 씀
  gazeY: number;
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

export function analyze(matrix: ArrayLike<number>, blend: Record<string, number>): FaceInfo {
  const s = (k: string) => blend[k] ?? 0;
  return {
    ...headAngles(matrix),
    blink: Math.max(s("eyeBlinkLeft"), s("eyeBlinkRight")),
    gazeX: (s("eyeLookOutLeft") + s("eyeLookInRight") - s("eyeLookInLeft") - s("eyeLookOutRight")) / 2,
    gazeY: (s("eyeLookUpLeft") + s("eyeLookUpRight") - s("eyeLookDownLeft") - s("eyeLookDownRight")) / 2,
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
