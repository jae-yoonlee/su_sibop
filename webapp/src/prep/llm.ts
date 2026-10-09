// 브라우저 안 AI (WebLLM + Qwen3-1.7B). 첫 방문엔 약 1GB를 받고, 그 뒤엔 브라우저 캐시에서 읽는다.
import type { InitProgressReport, WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import { QUESTION_SCHEMA, questionPrompt } from "./questions";
import type { Coverage } from "./competency";

export type LlmState =
  | { kind: "idle" }
  | { kind: "unsupported"; reason: string }
  | { kind: "loading"; progress: number; text: string }
  | { kind: "ready"; model: string }
  | { kind: "error"; reason: string };

let engine: WebWorkerMLCEngine | null = null;
let loading: Promise<WebWorkerMLCEngine | null> | null = null;
export let llmState: LlmState = { kind: "idle" };
let modelId = "";
const listeners = new Set<(s: LlmState) => void>();

function set(s: LlmState) {
  llmState = s;
  listeners.forEach((f) => f(s));
}

export function onLlmState(f: (s: LlmState) => void) {
  listeners.add(f);
  f(llmState);
  return () => listeners.delete(f);
}

/** WebGPU가 있는지, 16비트 연산을 지원하는지 (지원하면 더 작은 f16 모델) */
async function pickModel(): Promise<string | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return null;
  return adapter.features.has("shader-f16") ? "Qwen3-1.7B-q4f16_1-MLC" : "Qwen3-1.7B-q4f32_1-MLC";
}

/** 모델을 미리 받아 둔다. 여러 번 불러도 한 번만 받는다. */
export function preloadLlm(): Promise<WebWorkerMLCEngine | null> {
  if (loading) return loading;
  loading = (async () => {
    const id = await pickModel();
    if (!id) {
      set({ kind: "unsupported", reason: "이 브라우저·PC에서는 그래픽 가속(WebGPU)을 쓸 수 없어요" });
      return null;
    }
    modelId = id;
    set({ kind: "loading", progress: 0, text: "AI 준비 시작" });
    try {
      const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm"); // 첫 화면을 가볍게: 필요할 때 따로 받음
      const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
      engine = await CreateWebWorkerMLCEngine(worker, id, {
        initProgressCallback: (r: InitProgressReport) => set({ kind: "loading", progress: r.progress, text: r.text }),
      });
      set({ kind: "ready", model: id });
      return engine;
    } catch (e) {
      set({ kind: "error", reason: (e as Error).message });
      return null;
    }
  })();
  return loading;
}

export async function aiQuestions(resume: string, coverage: Coverage[]): Promise<string> {
  const e = await preloadLlm();
  if (!e) throw new Error("AI를 쓸 수 없어요");
  const res = await e.chat.completions.create({
    messages: [{ role: "user", content: questionPrompt(resume, coverage) }],
    temperature: 0.7,
    max_tokens: 500,
    response_format: { type: "json_object", schema: QUESTION_SCHEMA },
    extra_body: { enable_thinking: false },
  });
  return res.choices[0]?.message?.content ?? "";
}

export const currentModel = () => modelId;
