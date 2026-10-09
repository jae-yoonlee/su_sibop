import "./styles.css";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker, openCamera, runFaceLoop, type FrameResult } from "./media/camera";
import { openMic, type Mic } from "./media/mic";
import { CameraSetup, SETUP_MESSAGES } from "./rules/cameraSetup";
import { ANSWER_SEC, QUESTION_SEC } from "./rules/constants";
import { STATUS_ALERTS } from "./rules/gate";
import { ALERT_LABELS, AnswerCoach, type AnswerStats } from "./rules/session";
import { toDb } from "./rules/stats";
import { VOICE_SETUP_MESSAGES, VoiceSetup } from "./rules/voice";

// 1단계 체험판: 질문 생성(2단계)·꼬리질문(3단계) 전이라 기본 질문 2개로 진행 (question_gen.DEFAULT_QUESTIONS)
const QUESTIONS = [
  "가장 기억에 남는 프로젝트에서 맡은 역할과 기간을 구체적으로 말해 주세요.",
  "팀원과 의견이 달랐던 적이 있다면 어떻게 해결했는지 말해 주세요.",
];
const READ_SENTENCE = "안녕하세요. 오늘 면접에서 제 경험을 차분하고 또렷하게 말씀드리겠습니다.";

type Phase = "intro" | "loading" | "setup" | "ready" | "question" | "answer" | "result";

const app = document.querySelector<HTMLDivElement>("#app")!;
const S = {
  phase: "intro" as Phase,
  error: "",
  video: null as HTMLVideoElement | null,
  lm: null as FaceLandmarker | null,
  delegate: "",
  mic: null as Mic | null,
  cam: new CameraSetup(),
  voice: new VoiceSetup(),
  frame: null as FrameResult | null,
  fps: 0,
  rmsDb: -100,
  qIndex: 0,
  phaseAt: 0,
  coach: null as AnswerCoach | null,
  results: [] as AnswerStats[],
  debug: false,
};

const now = () => performance.now() / 1000;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector<T>(sel);

// ── 화면 그리기 ─────────────────────────────────────────────

function render() {
  if (S.phase === "intro" || S.phase === "result") {
    S.video?.remove();
    app.innerHTML = S.phase === "intro" ? introHtml() : resultHtml();
    bindPage();
    return;
  }
  if (!$(".stage")) {
    app.innerHTML = `<div class="stage"><div class="overlay"></div></div>`;
    if (S.video) $(".stage")!.prepend(S.video);
  }
  $(".overlay")!.innerHTML = overlayHtml();
  bindOverlay();
  tickUi();
}

function introHtml() {
  return `
  <div class="mesh"></div>
  <div class="page">
    <nav class="nav"><div class="brand">면접<b>.</b>코치</div><span class="badge">1단계 체험판</span></nav>
    <div class="wrap">
      <h1 class="display-xl">면접,<br/>실전처럼.</h1>
      <p class="lead">카메라와 목소리를 실시간으로 보고, 답변하는 동안 바로 코칭해요. 영상과 소리는 이 브라우저 안에서만 분석하고 어디에도 보내지 않아요.</p>
      <div class="chips">
        <span class="chip">Chrome · Edge 권장</span>
        <span class="chip">컴퓨터 소리는 꺼 두기</span>
        <span class="chip">밝은 곳에서</span>
      </div>
      <button class="btn-green" id="go">카메라·마이크 켜기</button>
      ${S.error ? `<div class="err">${S.error}</div>` : ""}
      <div class="steps">
        ${step(1, "자리 맞추기", "가운데 앉기, 렌즈 보기, 질문 화면 보기로 내 정면을 잡아요")}
        ${step(2, "목소리 기준", "주변 소음을 재고, 문장을 읽어 내 목소리 크기를 기준으로 잡아요")}
        ${step(3, "질문 2개", `질문을 ${QUESTION_SEC}초 보고 ${ANSWER_SEC}초 답해요. 그동안 실시간 알림이 떠요`)}
        ${step(4, "결과", "어떤 경고를 몇 번, 얼마나 오래 받았는지 정리해요")}
      </div>
    </div>
  </div>`;
}

const step = (n: number, h: string, p: string) =>
  `<div class="step-card"><div class="n">STEP ${n}</div><h3>${h}</h3><div>${p}</div></div>`;

const SETUP_DOTS = [
  ["position", "가운데 앉기"],
  ["lens", "렌즈 보기"],
  ["screen", "질문 화면 보기"],
  ["noise", "조용히"],
  ["voice", "문장 읽기"],
] as const;

function setupStepKey(): string {
  return S.cam.active ? S.cam.step : S.voice.active ? S.voice.step : "done";
}

function overlayHtml() {
  const meter = `<div class="meter"><i></i><b></b></div><div class="debug" ${S.debug ? "" : "hidden"}></div>`;
  if (S.phase === "loading") {
    return `<div class="setup-card"><div class="msg">얼굴 분석 모델을 불러오는 중…</div><div>처음 한 번만 몇 초 걸려요</div></div>`;
  }
  if (S.phase === "setup") {
    const cur = setupStepKey();
    const order = SETUP_DOTS.map(([k]) => k as string);
    const dots = SETUP_DOTS.map(([k, label]) => {
      const cls = order.indexOf(k) < order.indexOf(cur) || cur === "done" ? "done" : k === cur ? "on" : "";
      return `<span class="dot ${cls}">${label}</span>`;
    }).join("");
    return `
      <div class="guide"></div>
      <div class="qslot placeholder">질문은 여기에 떠요</div>
      <div class="setup-card">
        <div class="dots">${dots}</div>
        <div class="msg" id="setup-msg"></div>
        <div class="read" id="read" hidden>“${READ_SENTENCE}”</div>
        <div class="bar" id="setup-bar" hidden><i></i></div>
        <button class="btn-ghost-sm" id="redo">처음부터 다시</button>
      </div>${meter}`;
  }
  if (S.phase === "ready") {
    const warns = S.cam.warnings.map((w) => `<div>${SETUP_MESSAGES[w]}</div>`).join("");
    return `<button class="start" id="start">시작</button><div class="warn-list">${warns}</div>${meter}`;
  }
  // question / answer
  const q = QUESTIONS[S.qIndex];
  const label = S.phase === "question" ? "질문을 읽고 생각해 보세요" : "답변 중";
  return `
    <div class="qslot"><div class="meta"><span class="badge">질문 ${S.qIndex + 1} / ${QUESTIONS.length}</span><span>${label}</span></div>
      <p class="q">${q}</p></div>
    <div class="topbar"><div class="timer"><svg width="84" height="84"><circle cx="42" cy="42" r="36" stroke="rgba(255,255,255,.15)" stroke-width="8" fill="none"/>
      <circle id="ring" cx="42" cy="42" r="36" stroke="${S.phase === "question" ? "#fff" : "#5865f2"}" stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray="226" stroke-dashoffset="0"/></svg><span id="sec"></span></div></div>
    <div class="toasts"></div>
    <div class="bottom-actions"><button class="btn-ghost-sm" id="skip">${S.phase === "question" ? "바로 답변 시작" : "답변 끝내기"}</button></div>
    ${meter}`;
}

function resultHtml() {
  const all = new Map<string, { label: string; count: number; seconds: number; shown: number }>();
  for (const r of S.results)
    for (const a of r.alerts) {
      const row = all.get(a.name) ?? { label: a.label, count: 0, seconds: 0, shown: 0 };
      row.count += a.count;
      row.seconds += a.seconds;
      row.shown += a.shown;
      all.set(a.name, row);
    }
  const rows = [...all.values()].sort((a, b) => b.count - a.count);
  const total = rows.reduce((a, r) => a + r.count, 0);
  const shown = rows.reduce((a, r) => a + r.shown, 0);
  const top = rows[0]?.label ?? "없음";
  const perQ = S.results
    .map((r, i) => `<tr><td>질문 ${i + 1}</td><td>${r.durationS}초</td><td>${r.alerts.map((a) => `${a.label} ${a.count}`).join(", ") || "경고 없음"}</td></tr>`)
    .join("");
  const settings = S.mic?.settings ?? {};
  return `
  <div class="mesh"></div>
  <div class="page"><div class="wrap">
    <nav class="nav"><div class="brand">면접<b>.</b>코치</div><span class="badge">결과</span></nav>
    <h1 class="display-md">이번 연습 결과</h1>
    <div class="stats">
      <div class="stat"><div class="v">${total}</div><div class="k">경고 기준에 걸린 횟수</div></div>
      <div class="stat"><div class="v">${shown}</div><div class="k">화면에 띄운 알림</div></div>
      <div class="stat"><div class="v" style="font-size:32px;line-height:1.2">${top}</div><div class="k">가장 많이 받은 경고</div></div>
    </div>
    <div class="card-dark">
      <h2 style="margin-top:0">경고별 누적</h2>
      <table><tr><th>경고</th><th>횟수</th><th>지속 시간</th><th>화면 알림</th></tr>
      ${rows.map((r) => `<tr><td>${r.label}</td><td>${r.count}회</td><td>${r.seconds.toFixed(1)}초</td><td>${r.shown}회</td></tr>`).join("") || `<tr><td colspan="4">경고가 없었어요</td></tr>`}
      </table>
      <p style="opacity:.75;font-size:14px">알림은 답변을 방해하지 않게 20초에 하나, 1분에 2개까지만 띄워요. 못 띄운 경고도 여기에는 모두 들어가요.</p>
      <h2>질문별</h2>
      <table>${perQ}</table>
    </div>
    <div class="actions">
      <button class="btn-primary" id="download">결과 저장 (JSON)</button>
      <button class="btn-green" id="again">다시 하기</button>
    </div>
    <details><summary>측정 정보 (테스트용)</summary><pre>${JSON.stringify(
      { face: S.delegate, fps: Math.round(S.fps), mic: { autoGainControl: settings.autoGainControl, noiseSuppression: settings.noiseSuppression, sampleRate: settings.sampleRate },
        noiseDb: S.voice.noiseDb?.toFixed(1), voiceDb: S.voice.voiceDb?.toFixed(1), camera: S.cam.warnings, ua: navigator.userAgent }, null, 2)}</pre></details>
  </div></div>`;
}

// ── 이벤트 ─────────────────────────────────────────────

function bindPage() {
  $("#go")?.addEventListener("click", start);
  $("#again")?.addEventListener("click", () => {
    S.results = [];
    S.qIndex = 0;
    S.cam = new CameraSetup();
    S.voice = new VoiceSetup();
    go("setup");
  });
  $("#download")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), results: S.results }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `면접코치-${Date.now()}.json` });
    a.click();
  });
}

function bindOverlay() {
  $("#redo")?.addEventListener("click", () => {
    S.cam = new CameraSetup();
    S.voice = new VoiceSetup();
    render();
  });
  $("#start")?.addEventListener("click", () => go("question"));
  $("#skip")?.addEventListener("click", () => (S.phase === "question" ? go("answer") : endAnswer()));
}

document.addEventListener("keydown", (e) => {
  if (e.key === "d" || e.key === "D") {
    S.debug = !S.debug;
    $(".debug")?.toggleAttribute("hidden", !S.debug);
  }
});

function go(phase: Phase) {
  S.phase = phase;
  S.phaseAt = now();
  if (phase === "answer") {
    const base = { box: S.cam.baseBox!, gazeStd: S.cam.baseGazeStd };
    const v = S.voice;
    S.coach = new AnswerCoach(base, { noiseRms: v.noiseRms!, noiseDb: v.noiseDb!, voiceDb: v.voiceDb! }, S.phaseAt, QUESTIONS[S.qIndex]);
  }
  render();
}

function endAnswer() {
  if (!S.coach) return;
  S.results.push(S.coach.finish(now()));
  S.coach = null;
  if (S.qIndex + 1 < QUESTIONS.length) {
    S.qIndex++;
    go("question");
  } else go("result");
}

async function start() {
  S.error = "";
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    S.error = "이 브라우저에서는 카메라를 쓸 수 없어요. https 주소의 Chrome이나 Edge로 열어 주세요.";
    return render();
  }
  try {
    S.video = Object.assign(document.createElement("video"), { muted: true, playsInline: true });
    go("loading");
    await openCamera(S.video);
    S.mic = await openMic(onRms);
    const { lm, delegate } = await createLandmarker();
    S.lm = lm;
    S.delegate = delegate;
    runFaceLoop(S.video, lm, onFrame);
    go("setup");
  } catch (e) {
    S.mic?.stop();
    (S.video?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    const name = (e as Error).name;
    S.error =
      name === "NotAllowedError" ? "카메라·마이크 권한이 막혀 있어요. 주소창 왼쪽 자물쇠에서 허용해 주세요."
      : name === "NotFoundError" ? "카메라나 마이크를 찾지 못했어요."
      : `시작하지 못했어요: ${(e as Error).message}`;
    S.phase = "intro";
    render();
  }
}

// ── 매 프레임·매 소리 조각 ─────────────────────────────────────────────

let lastFrameT = 0;
function onFrame(r: FrameResult) {
  if (lastFrameT) S.fps = S.fps * 0.9 + (1 / Math.max(r.t - lastFrameT, 1e-3)) * 0.1;
  lastFrameT = r.t;
  S.frame = r;
  if (S.phase === "setup" && S.cam.active) {
    const before = S.cam.step;
    S.cam.feed(r.t, r.info, r.box);
    if (S.cam.step !== before) return render();
  }
  if (S.phase === "answer" && S.coach) {
    const angles = r.info ? S.cam.apply(r.info) : null;
    S.coach.onFrame(r.t, angles, r.info, r.box);
  }
  tickUi();
}

function onRms(rms: number) {
  const t = now();
  S.rmsDb = toDb(rms);
  if (S.phase === "setup" && !S.cam.active && S.voice.active) {
    const before = S.voice.step;
    S.voice.feed(t, rms);
    if (S.voice.step !== before) {
      if (!S.voice.active) return go("ready");
      return render();
    }
  }
  if (S.phase === "answer") S.coach?.onAudio(t, rms);
}

// 시간·글자·막대만 갱신 (DOM 전체를 다시 그리지 않음)
function tickUi() {
  const t = now();
  const meterI = $(".meter i"), meterB = $(".meter b");
  const toPct = (db: number) => Math.max(0, Math.min(100, ((db + 70) / 60) * 100));
  if (meterI) meterI.style.height = `${toPct(S.rmsDb)}%`;
  if (meterB && S.voice.voiceDb !== null) meterB.style.bottom = `${toPct(S.voice.voiceDb)}%`;

  if (S.phase === "setup") {
    const msg = $("#setup-msg");
    if (msg) msg.textContent = S.cam.active ? SETUP_MESSAGES[S.cam.message] : VOICE_SETUP_MESSAGES[S.voice.message];
    $(".guide")?.classList.toggle("ok", S.cam.message === "position_ok" || (!S.cam.active));
    $(".qslot")?.classList.toggle("look", S.cam.step === "screen");
    const voiceStep = !S.cam.active;
    $("#read")?.toggleAttribute("hidden", !(voiceStep && S.voice.step === "voice"));
    const bar = $("#setup-bar");
    if (bar) {
      bar.toggleAttribute("hidden", !voiceStep);
      bar.querySelector("i")!.style.width = `${S.voice.level * 100}%`;
    }
  }
  if (S.phase === "question" || S.phase === "answer") {
    const total = S.phase === "question" ? QUESTION_SEC : ANSWER_SEC;
    const left = Math.max(0, total - (t - S.phaseAt));
    const sec = $("#sec"), ring = $("#ring");
    if (sec) sec.textContent = String(Math.ceil(left));
    if (ring) ring.setAttribute("stroke-dashoffset", String(226 * (1 - left / total)));
    if (left <= 0) return S.phase === "question" ? go("answer") : endAnswer();
  }
  if (S.phase === "answer" && S.coach) {
    const box = $(".toasts");
    const want = S.coach.shown.join(",");
    if (box && box.dataset.shown !== want) {
      box.dataset.shown = want;
      box.innerHTML = S.coach.shown.map((k) => `<div class="toast ${STATUS_ALERTS.has(k) ? "status" : ""}">${ALERT_LABELS[k]}</div>`).join("");
    }
  }
  const dbg = $(".debug");
  if (dbg && S.debug) {
    const f = S.frame?.info;
    const a = f && S.cam.baseline ? S.cam.apply(f) : null;
    const p = S.coach?.posture, v = S.coach?.voice;
    dbg.textContent = [
      `얼굴 ${S.delegate} ${Math.round(S.fps)}fps ${S.frame?.procMs.toFixed(0) ?? "-"}ms`,
      a ? `yaw ${a.yaw.toFixed(1)} pitch ${a.pitch.toFixed(1)}` : f ? `raw yaw ${f.yaw.toFixed(1)} pitch ${f.pitch.toFixed(1)}` : "얼굴 없음",
      S.frame?.box ? `cx ${S.frame.box.cx.toFixed(2)} cy ${S.frame.box.cy.toFixed(2)} w ${S.frame.box.w.toFixed(2)}` : "",
      p?.gazeStd != null ? `눈동자 흔들림 ${p.gazeStd.toFixed(3)} (기준 ${S.cam.baseGazeStd.toFixed(3)})` : "",
      `소리 ${S.rmsDb.toFixed(1)}dB 소음 ${S.voice.noiseDb?.toFixed(1) ?? "-"} 목소리 ${S.voice.voiceDb?.toFixed(1) ?? "-"}`,
      v ? `말함 ${v.speaking ? "O" : "X"} 차이 ${v.levelGapDb?.toFixed(1) ?? "-"} 바닥소음 ${v.noiseFloorDb?.toFixed(1) ?? "-"}` : "",
    ].filter(Boolean).join("\n");
  }
}

// 얼굴이 안 잡혀 프레임이 멈춰도 타이머는 흐르게
setInterval(() => {
  if (S.phase === "question" || S.phase === "answer") tickUi();
}, 250);

render();
