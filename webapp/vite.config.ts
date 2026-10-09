import { defineConfig } from "vite";

// GitHub Pages 주소가 https://<계정>.github.io/su_sibop/ 이라 기본 경로를 맞춘다. 로컬 개발은 "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? process.env.BASE_PATH ?? "/su_sibop/" : "/",
  worker: { format: "es" },
  // 브라우저 안 AI 라이브러리(약 6MB)는 첫 화면과 따로 받으므로 크기 경고를 올림
  build: { chunkSizeWarningLimit: 7000 },
}));
