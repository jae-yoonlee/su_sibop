// 브라우저 안 AI (WebLLM + Qwen3-1.7B). 첫 방문엔 약 1GB를 받고, 그 뒤엔 브라우저 캐시에서 읽는다.
import type { InitProgressReport, WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import { QUESTION_SCHEMA, questionPrompt } from "./questions";
import { FOLLOWUP_SCHEMA } from "./followup";
import type { Coverage } from "./competency";
import { yesProb, type YesNoAsk } from "./judge";
import { fcProbs, type FcAsk } from "./judgeFC";

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

/** 모델 하나를 별도 스레드에 띄운다 (검증 페이지에서도 모델을 바꿔 가며 씀) */
export async function createEngine(id: string, onProgress: (r: InitProgressReport) => void): Promise<WebWorkerMLCEngine> {
  const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm"); // 첫 화면을 가볍게: 필요할 때 따로 받음
  const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
  return CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: onProgress });
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
      engine = await createEngine(id, (r) => set({ kind: "loading", progress: r.progress, text: r.text }));
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
  return generateQuestions(e, resume, coverage);
}

/** 앱과 검증 페이지가 같은 프롬프트·설정을 쓰도록 한 곳에 둔다 */
export async function generateQuestions(e: WebWorkerMLCEngine, resume: string, coverage: Coverage[]): Promise<string> {
  const res = await e.chat.completions.create({
    messages: [{ role: "user", content: questionPrompt(resume, coverage) }],
    temperature: 0.7,
    max_tokens: 300, // 질문 문장 3개만 쓰므로 짧게 (빠름)
    response_format: { type: "json_object", schema: QUESTION_SCHEMA },
    extra_body: { enable_thinking: false },
  });
  return res.choices[0]?.message?.content ?? "";
}

/** 꼬리질문 한 문장. 모델이 아직 준비 안 됐으면 null (그때는 틀 문장) */
export function followupAsker(): ((prompt: string) => Promise<string>) | null {
  if (!engine || llmState.kind !== "ready") return null;
  const e = engine;
  return async (prompt) => {
    const res = await e.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8, // 같은 답에도 매번 조금 다르게
      max_tokens: 80,
      response_format: { type: "json_object", schema: FOLLOWUP_SCHEMA },
      extra_body: { enable_thinking: false },
    });
    return res.choices[0]?.message?.content ?? "";
  };
}

/** 짧은 JSON 답 하나 (사실 대조 재확인 등). 모델이 아직 준비 안 됐으면 null → 규칙 판정만 */
export function jsonAsker(schema: string, maxTokens: number): ((prompt: string) => Promise<string>) | null {
  if (!engine || llmState.kind !== "ready") return null;
  const e = engine;
  return async (prompt) => {
    const res = await e.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object", schema },
      extra_body: { enable_thinking: false },
    });
    return res.choices[0]?.message?.content ?? "";
  };
}

/** 역량 판정용: 한 단어(yes/no)만 만들고 그 자리의 후보 확률을 읽는다. 모델이 아직 준비 안 됐으면 null */
export function yesNoAsker(): YesNoAsk | null {
  if (!engine || llmState.kind !== "ready") return null;
  return yesNoAskerFor(engine);
}

/** 검증 페이지에서 판정 모델만 바꿔 볼 때도 같은 설정 */
export function yesNoAskerFor(e: WebWorkerMLCEngine): YesNoAsk {
  return async (messages) => {
    const res = await e.chat.completions.create({
      messages,
      temperature: 1, // 고른 단어는 안 쓰고 확률만 읽으므로 원래 분포 그대로
      max_tokens: 1,
      logprobs: true,
      top_logprobs: 5,
      extra_body: { enable_thinking: false },
    });
    const c = res.choices[0];
    const top = c?.logprobs?.content?.[0]?.top_logprobs ?? [];
    return { p: yesProb(top), raw: `${c?.message?.content ?? ""} | ${top.map((t) => `${t.token}:${Math.exp(t.logprob).toFixed(2)}`).join(" ")}` };
  };
}

/** 강제선택 판정용: 글자 하나(A~J, X)만 만들고 후보 확률을 읽는다. WebLLM은 후보를 최대 5개까지만 준다 */
export function fcAskerFor(e: WebWorkerMLCEngine): FcAsk {
  return async (messages) => {
    const res = await e.chat.completions.create({
      messages,
      temperature: 1, // 확률만 읽으므로 원래 분포 그대로
      max_tokens: 1,
      logprobs: true,
      top_logprobs: 5,
      extra_body: { enable_thinking: false },
    });
    const c = res.choices[0];
    const top = c?.logprobs?.content?.[0]?.top_logprobs ?? [];
    return { probs: fcProbs(top), raw: `${c?.message?.content ?? ""} | ${top.map((t) => `${t.token}:${Math.exp(t.logprob).toFixed(2)}`).join(" ")}` };
  };
}

export const currentModel = () => modelId;
