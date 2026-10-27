// 시선 측정 페이지 (팀 내부용). 화면에 "여기를 보세요"를 차례로 띄우고, 그동안의 얼굴 각도와 눈동자 값을 기록해
// 딴 곳 보기 규칙이 얼마나 맞는지 잰다. 영상은 저장하지 않고 숫자만 남긴다.
import { esc } from "../safe";
import "../styles.css";
import { createLandmarker, openCamera, runFaceLoop, type FrameResult } from "../media/camera";
import { LOOK_EYE_TOL, LOOK_HEAD_DEG } from "../rules/constants";
import { CUE_SEC, CUE_SETTLE_SEC, cueOrder, meanTarget, score, sweep, type Cue, type Frame, type Score, type Target } from "./metrics";

const app = document.querySelector<HTMLDivElement>("#app")!;
const CALIB: Cue[] = [
  { id: "calib-lens", label: "카메라 렌즈", away: false, x: 0.5, y: 0.02 },
  { id: "calib-card", label: "질문 카드", away: false, x: 0.5, y: 0.22 },
];
const CALIB_SEC = 3;

const S = {
  phase: "intro" as "intro" | "loading" | "run" | "done",
  error: "",
  queue: [] as Cue[],
  cue: null as Cue | null,
  cueAt: 0,
  calib: { lens: [] as Frame[], card: [] as Frame[] },
  frames: [] as Frame[],
  targets: null as [Target, Target] | null,
  base: { yaw: 0, pitch: 0 }, // 질문 카드를 볼 때 각도 = 정면
  lastFace: 0,
  result: null as null | { all: Score[]; best: { iris: Score | null; blend: Score | null }; app: Score },
  stop: null as null | { stop(): void },
};

const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "-");

function render() {
  if (S.phase === "run") return renderCue();
  app.innerHTML = `<div class="page"><div class="wrap">
    <div class="nav"><div class="brand">면접 코치 <b>시선 측정</b></div><a class="link" href="./">앱으로</a></div>
    <h1 class="display-md">딴 곳 보기 규칙 측정</h1>
    ${S.phase === "done" ? resultHtml() : `
    <div class="card-dark">
      <p>화면에 점과 글자가 차례로 떠요. <b>뜬 곳을 4초 동안 바라봐 주세요.</b> 처음 두 곳(렌즈, 질문 카드)은 기준을 재는 곳이에요.</p>
      <p>모두 ${CUES_COUNT}곳, 약 ${Math.round(CUES_COUNT * CUE_SEC + CALIB.length * CALIB_SEC)}초 걸려요. 노트북은 면접 볼 때처럼 두고, 전체 화면으로 해 주세요.</p>
      <p class="muted">영상은 저장하지 않아요. 얼굴 각도와 눈동자 값(숫자)만 이 브라우저에 남고, 끝나면 JSON으로 내려받을 수 있어요.</p>
      ${S.error ? `<p style="color:var(--magenta)">${esc(S.error)}</p>` : ""}
      <button class="btn-green" id="start" ${S.phase === "loading" ? "disabled" : ""}>${S.phase === "loading" ? "카메라와 얼굴 인식 준비 중…" : "시작"}</button>
    </div>`}
  </div></div>`;
  document.getElementById("start")?.addEventListener("click", () => void start());
  document.getElementById("dl")?.addEventListener("click", download);
  document.getElementById("again")?.addEventListener("click", () => {
    S.phase = "intro";
    S.result = null;
    render();
  });
}
const CUES_COUNT = cueOrder(() => 0).length;

function renderCue() {
  const c = S.cue!;
  const left = Math.round(c.x * 100), top = Math.round(c.y * 100);
  const noFace = performance.now() / 1000 - S.lastFace > 0.5;
  app.innerHTML = `<div style="position:fixed;inset:0;background:var(--canvas)">
    ${c.id === "calib-card" || c.id === "card" ? `<div style="position:absolute;left:30%;right:30%;top:14%;height:16%;border-radius:24px;background:var(--primary-soft);border:2px solid var(--primary)"></div>` : ""}
    <div style="position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;background:var(--primary);box-shadow:0 0 0 8px rgba(52,87,240,.18)"></div>
    <div style="position:absolute;left:50%;top:55%;transform:translate(-50%,-50%);text-align:center;font-size:28px;font-weight:700;color:var(--ink)">
      ${esc(c.label)}<div style="font-size:18px;font-weight:500;margin-top:6px">${c.eyesOnly ? "파란 점을 눈으로만 보세요" : "파란 점을 보세요"}</div>
      <div style="font-size:16px;opacity:.7;margin-top:8px">${S.queue.length + 1}곳 남음${noFace ? ", 얼굴이 안 보여요" : ""}</div>
    </div></div>`;
}

async function start() {
  S.phase = "loading";
  S.error = "";
  render();
  try {
    const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true });
    await openCamera(video);
    const { lm } = await createLandmarker();
    S.calib = { lens: [], card: [] };
    S.frames = [];
    S.queue = [...CALIB, ...cueOrder()];
    next();
    S.phase = "run";
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    S.stop = runFaceLoop(video, lm, onFrame);
    render();
  } catch (e) {
    S.phase = "intro";
    S.error = `시작하지 못했어요: ${(e as Error).message}`;
    render();
  }
}

function next() {
  S.cue = S.queue.shift() ?? null;
  S.cueAt = performance.now() / 1000;
}

function onFrame(r: FrameResult) {
  if (S.phase !== "run" || !S.cue) return;
  const t = r.t - S.cueAt;
  const c = S.cue;
  if (r.info) {
    S.lastFace = r.t;
    const i = r.info;
    const f: Frame = {
      t, cue: c.id, away: c.away, yaw: i.yaw - S.base.yaw, pitch: i.pitch - S.base.pitch, blink: i.blink,
      iris: i.gazeSrc === "iris" ? [i.gazeX, i.gazeY] : null, blend: [i.blendX ?? i.gazeX, i.blendY ?? i.gazeY],
    };
    if (c.id === "calib-lens" && t >= CUE_SETTLE_SEC && i.blink < 0.5) S.calib.lens.push(f);
    else if (c.id === "calib-card" && t >= CUE_SETTLE_SEC && i.blink < 0.5) S.calib.card.push(f);
    else if (!c.id.startsWith("calib")) S.frames.push(f);
  }
  const len = c.id.startsWith("calib") ? CALIB_SEC : CUE_SEC;
  if (t < len) return;
  if (c.id === "calib-card") calibrate();
  next();
  if (!S.cue) return finish();
  renderCue();
}

/** 기준: 질문 카드를 볼 때 각도를 정면(0)으로, 렌즈와 카드 두 점을 '봐도 되는 곳'으로 (앱 세팅과 같은 방식) */
function calibrate() {
  const card = meanTarget(S.calib.card);
  S.base = { yaw: card.yaw, pitch: card.pitch };
  const lens = meanTarget(S.calib.lens);
  S.targets = [
    { ...lens, yaw: lens.yaw - card.yaw, pitch: lens.pitch - card.pitch },
    { ...card, yaw: 0, pitch: 0 },
  ];
}

function finish() {
  S.stop?.stop();
  void document.exitFullscreen?.().catch(() => undefined);
  if (!S.targets || !S.calib.lens.length || !S.calib.card.length || !S.frames.length) {
    S.phase = "intro";
    S.error = "얼굴이 잘 안 보여서 잴 수 없었어요. 밝은 곳에서 다시 해 주세요.";
    return render();
  }
  const sw = sweep(S.frames, S.targets);
  S.result = { ...sw, app: score(S.frames, S.targets, "iris", LOOK_EYE_TOL, LOOK_HEAD_DEG) };
  S.phase = "done";
  render();
}

function row(name: string, s: Score | null) {
  if (!s) return `<tr><td>${name}</td><td colspan="6">오경보 10% 이하인 값이 없음</td></tr>`;
  return `<tr><td>${name}</td><td>눈 ${s.eyeTol}, 고개 ${s.headDeg}°</td><td><b>${pct(s.recall)}</b></td><td>${pct(s.falseAlarm)}</td><td>${pct(s.precision)}</td><td>${pct(s.eyesOnlyRecall)}</td><td>${s.n}</td></tr>`;
}

function resultHtml() {
  const r = S.result!;
  return `<div class="card-dark">
    <h2 style="margin-top:0">결과</h2>
    <table><tr><th>방식</th><th>기준값</th><th>딴 곳 잡은 비율</th><th>오경보</th><th>정확도</th><th>눈만 움직임 잡은 비율</th><th>프레임</th></tr>
    ${row("지금 앱 (홍채)", r.app)}
    ${row("홍채 최적", r.best.iris)}
    ${row("표정 점수 최적", r.best.blend)}
    </table>
    <p class="muted">프레임마다 비교했고, 점이 뜬 직후 ${CUE_SETTLE_SEC}초와 눈 감은 프레임은 뺐어요. '최적'은 오경보 10% 이하 중 가장 많이 잡는 기준값이에요. 한 사람 결과라 기준값을 바로 바꾸지 말고, 3~5명을 모아서 정해요.</p>
    <div class="actions"><button class="btn-primary" id="dl">결과 저장 (JSON)</button><button class="btn-green" id="again">다시 재기</button></div>
  </div>`;
}

function download() {
  const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), ua: navigator.userAgent, targets: S.targets, result: S.result, frames: S.frames }, null, 1)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `시선측정-${Date.now()}.json` });
  a.click();
}

render();
