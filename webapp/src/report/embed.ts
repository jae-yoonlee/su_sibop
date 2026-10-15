// 문장 뜻 비교 엔진: 브라우저 안 문장 의미 모델(multilingual-e5-small, 약 120MB, 처음 한 번만 받음).
// 자소서·답변은 이 PC 안에서만 계산한다. 모델을 못 받으면 글자 조각(2글자) 겹침으로 대신하고, 화면에 그렇게 표시한다.
// 사실 대조(4단계)와 뜻 기반 역량 찾기가 함께 쓴다.

export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export type EmbedMode = "idle" | "loading" | "model" | "fallback";
export let embedMode: EmbedMode = "idle";
export let embedError = "";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let loading: Promise<Extractor | null> | null = null;

/** 모델을 미리 받아 둔다 (면접 중 뒤에서). 여러 번 불러도 한 번만 받는다. */
export function preloadEmbedder(): Promise<Extractor | null> {
  loading ??= (async () => {
    embedMode = "loading";
    try {
      const { pipeline } = await import("@huggingface/transformers");
      const hasGpu = !!(navigator as Navigator & { gpu?: unknown }).gpu;
      const ext = (await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", device: hasGpu ? "webgpu" : "wasm" })) as unknown as Extractor;
      embedMode = "model";
      return ext;
    } catch (e) {
      embedError = (e as Error).message;
      embedMode = "fallback";
      return null;
    }
  })();
  return loading;
}

const clean = (s: string) => s.replace(/[\s.,!?'"“”‘’·…()]/g, "");
function bigrams(s: string) {
  const t = clean(s);
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}
/** 대체 방식: 2글자 조각 겹침 (코사인) */
export function charSim(a: string, b: string) {
  const A = bigrams(a), B = bigrams(b);
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of A) {
    na += v * v;
    dot += v * (B.get(k) ?? 0);
  }
  for (const v of B.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// 같은 뜻으로 볼 기준 [가설: 실측 전]. e5는 관련 없는 문장도 0.7대가 나와서 기준이 높다.
export const SAME_TOPIC = { model: 0.84, fallback: 0.3 };

/** a 문장들과 b 문장들의 뜻 비슷함 표 (0~1). mode는 실제로 쓴 방식 */
export async function similarity(a: string[], b: string[]): Promise<{ sim: number[][]; mode: "model" | "fallback" }> {
  const ext = a.length && b.length ? await preloadEmbedder() : null;
  if (ext) {
    try {
      // e5는 앞에 "query: "를 붙여야 제 성능
      const [ea, eb] = await Promise.all([a, b].map(async (xs) => (await ext(xs.map((x) => `query: ${x}`), { pooling: "mean", normalize: true })).tolist()));
      return { sim: ea.map((x) => eb.map((y) => x.reduce((s, v, i) => s + v * y[i], 0))), mode: "model" };
    } catch (e) {
      embedError = (e as Error).message;
    }
  }
  return { sim: a.map((x) => b.map((y) => charSim(x, y))), mode: "fallback" };
}
