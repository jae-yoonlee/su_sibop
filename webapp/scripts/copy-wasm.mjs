// MediaPipe wasm을 public/에 복사해 우리 사이트에서 직접 내려준다 (외부 CDN이 막힌 곳에서도 동작, 버전 불일치 방지).
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("public/mediapipe", { recursive: true });
cpSync("node_modules/@mediapipe/tasks-vision/wasm", "public/mediapipe", { recursive: true });

// 검증 페이지용 가짜 자소서·채용공고 (원본은 저장소 루트 data/eval/)
mkdirSync("public/eval", { recursive: true });
cpSync("../data/eval/cases.json", "public/eval/cases.json");
