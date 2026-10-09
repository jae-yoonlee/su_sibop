// 카메라 + MediaPipe Face Landmarker (브라우저 안에서 실행, 영상은 밖으로 나가지 않음)
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { analyze, faceBox, type FaceBox, type FaceInfo } from "../rules/face";

// 패키지와 같은 버전의 wasm을 빌드 때 public/mediapipe로 복사해 둠 (scripts/copy-wasm.mjs)
const WASM_URL = `${import.meta.env.BASE_URL}mediapipe`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface FrameResult {
  t: number; // 초 (performance.now 기준)
  info: FaceInfo | null;
  box: FaceBox | null;
  procMs: number;
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export async function createLandmarker(): Promise<{ lm: FaceLandmarker; delegate: "GPU" | "CPU" }> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const make = (delegate: "GPU" | "CPU") =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  try {
    return { lm: await make("GPU"), delegate: "GPU" };
  } catch {
    return { lm: await make("CPU"), delegate: "CPU" }; // 그래픽 가속이 안 되는 PC
  }
}

/** 화면 갱신마다 한 프레임 분석. stop()으로 멈춤. */
export function runFaceLoop(video: HTMLVideoElement, lm: FaceLandmarker, onFrame: (r: FrameResult) => void) {
  let running = true;
  let lastVideoTime = -1;
  let lastTs = 0;
  const tick = () => {
    if (!running) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const ts = Math.max(Math.round(now), lastTs + 1); // VIDEO 모드는 시각이 계속 늘어야 함
      lastTs = ts;
      const res = lm.detectForVideo(video, ts);
      const procMs = performance.now() - now;
      const pts = res.faceLandmarks[0];
      const mat = res.facialTransformationMatrixes?.[0];
      const bs = res.faceBlendshapes?.[0];
      let info: FaceInfo | null = null;
      let box: FaceBox | null = null;
      if (pts && mat && bs) {
        const blend: Record<string, number> = {};
        for (const c of bs.categories) blend[c.categoryName] = c.score;
        info = analyze(mat.data, blend);
        box = faceBox(pts);
      }
      onFrame({ t: now / 1000, info, box, procMs });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { stop: () => (running = false) };
}
