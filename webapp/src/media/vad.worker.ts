// Silero VAD (MIT, snakers4/silero-vad v5)를 이 PC 안에서 돌린다. 16kHz 512샘플 조각마다 '말소리일 확률'을 돌려준다.
import * as ort from "onnxruntime-web/webgpu";

ort.env.wasm.numThreads = 1; // GitHub Pages는 여러 스레드(교차 출처 격리)를 못 씀

let session: ort.InferenceSession | null = null;
let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
let busy = Promise.resolve();

self.onmessage = (e: MessageEvent<{ init?: string; frame?: Float32Array; t?: number }>) => {
  const { init, frame, t } = e.data;
  if (init) {
    void ort.InferenceSession.create(init)
      .then((s) => {
        session = s;
        self.postMessage({ ready: true });
      })
      .catch((err: Error) => self.postMessage({ error: err.message }));
    return;
  }
  if (!frame || !session) return;
  const s = session;
  // 상태(state)가 이어지므로 한 조각씩 순서대로
  busy = busy.then(async () => {
    try {
      const r = await s.run({ input: new ort.Tensor("float32", frame, [1, 512]), state, sr });
      state = r.stateN as ort.Tensor;
      self.postMessage({ p: (r.output.data as Float32Array)[0], t });
    } catch (err) {
      self.postMessage({ error: (err as Error).message });
    }
  });
};
