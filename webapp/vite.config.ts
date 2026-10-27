import { defineConfig, type Plugin } from "vite";

// 보안 정책(CSP): 이 앱이 쓰는 곳 말고는 스크립트·연결을 막는다. GitHub Pages는 응답 헤더를 못 바꿔 meta 태그로 넣는다.
// 개발 서버(빠른 새로고침)는 인라인 스크립트를 써서 배포 빌드에만 붙인다. 바깥 주소를 새로 쓰면 여기에 더해야 한다.
const CSP = [
  "default-src 'self'",
  // wasm-unsafe-eval: 얼굴·소리·VAD·WebLLM이 WebAssembly를 씀. jsdelivr: 문장 의미 모델 런타임(onnxruntime)이 거기서 받음
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  // huggingface/hf.co: AI 모델 파일, raw.githubusercontent: WebLLM 실행 파일, storage.googleapis: 얼굴·소리 모델, generativelanguage: Gemini(키 넣었을 때만)
  "connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://raw.githubusercontent.com https://cdn.jsdelivr.net https://storage.googleapis.com https://generativelanguage.googleapis.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const securityMeta = (): Plugin => ({
  name: "security-meta",
  apply: "build",
  transformIndexHtml: () => [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
    { tag: "meta", attrs: { name: "referrer", content: "strict-origin-when-cross-origin" }, injectTo: "head-prepend" },
  ],
});

// GitHub Pages 주소가 https://<계정>.github.io/su_sibop/ 이라 기본 경로를 맞춘다. 로컬 개발은 "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? process.env.BASE_PATH ?? "/su_sibop/" : "/",
  plugins: [securityMeta()],
  worker: { format: "es" },
  // 브라우저 안 AI 라이브러리(약 6MB)는 첫 화면과 따로 받으므로 크기 경고를 올림
  // eval.html = 질문 모델·역량 찾기 검증 페이지, gaze.html = 시선 규칙 측정 페이지 (팀 내부용)
  build: { chunkSizeWarningLimit: 7000, rollupOptions: { input: { main: "index.html", eval: "eval.html", gaze: "gaze.html" } } },
}));
