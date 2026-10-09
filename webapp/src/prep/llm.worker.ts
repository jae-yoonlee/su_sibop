// 브라우저 안 AI는 별도 스레드에서 돌린다 (얼굴 분석·화면이 멈추지 않게).
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
