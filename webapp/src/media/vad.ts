// 말소리 판정기 불러오기. 정해진 시간 안에 못 불러오면 음량 판정으로 대신하고, 화면에 그렇게 표시한다.
export const VAD_LOAD_TIMEOUT_MS = 15000;

export type VadMode = "loading" | "silero" | "energy";
export interface Vad {
  mode: VadMode;
  error: string;
  push(frame: Float32Array, t: number): void;
  stop(): void;
}

export function startVad(onProb: (p: number, t: number) => void, onMode: (m: VadMode) => void): Vad {
  const vad: Vad = { mode: "loading", error: "", push() {}, stop() {} };
  const fail = (msg: string) => {
    if (vad.mode === "energy") return;
    vad.mode = "energy";
    vad.error = msg;
    worker?.terminate();
    onMode("energy");
  };
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./vad.worker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    fail((e as Error).message);
    return vad;
  }
  const timer = setTimeout(() => fail("말소리 판정 모델을 제때 못 불러옴"), VAD_LOAD_TIMEOUT_MS);
  worker.onerror = (e) => fail(e.message || "말소리 판정기 오류");
  worker.onmessage = (e: MessageEvent<{ ready?: boolean; error?: string; p?: number; t?: number }>) => {
    if (e.data.error) return fail(e.data.error);
    if (e.data.ready) {
      clearTimeout(timer);
      if (vad.mode !== "loading") return;
      vad.mode = "silero";
      onMode("silero");
      return;
    }
    if (e.data.p !== undefined && vad.mode === "silero") onProb(e.data.p, e.data.t ?? 0);
  };
  worker.postMessage({ init: new URL(`${import.meta.env.BASE_URL}vad/silero_vad_v5.onnx`, location.href).href });
  vad.push = (frame, t) => {
    if (vad.mode === "silero") worker!.postMessage({ frame, t }, [frame.buffer]);
  };
  vad.stop = () => {
    clearTimeout(timer);
    worker?.terminate();
  };
  return vad;
}
