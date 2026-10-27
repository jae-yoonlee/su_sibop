import "./styles.css";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker, openCamera, runFaceLoop, type FrameResult } from "./media/camera";
import { openMic, type Mic } from "./media/mic";
import { startVad, type Vad, type VadMode } from "./media/vad";
import { startSound, type SoundSensor } from "./media/sound";
import { accuracy } from "./media/cer";
import { STT_MODE_TEXT, sttMode, Transcriber, type SttMode } from "./media/stt";
import { CameraSetup, SETUP_MESSAGES } from "./rules/cameraSetup";
import { ANSWER_SEC, CLIP_LEAD_SEC, PROBLEM_COUNT, QUESTION_SEC, SOUND_EVERY_SEC, WARN_COUNT } from "./rules/constants";
import { AnswerRecorder, fixDuration } from "./media/recorder";
import { STATUS_ALERTS } from "./rules/gate";
import { ALERT_LABELS, AnswerCoach, type AnswerStats } from "./rules/session";
import { toDb } from "./rules/stats";
import { SileroGate, VOICE_SETUP_MESSAGES, VoiceSetup } from "./rules/voice";
import { checkFacts, extractFacts, RECHECK_SCHEMA, type FactResult } from "./report/facts";
import { answerCompetency } from "./report/answerComp";
import { FEEDBACK_SCHEMA, makeFeedback, type Feedback } from "./report/feedback";
import { preloadEmbedder } from "./report/embed";
import { currentModel, followupAsker, jsonAsker, llmState, onLlmState, preloadLlm, type LlmState } from "./prep/llm";
import { ISSUE_LABELS, loadHistory, makeFollowup, saveHistory, type IssueName } from "./prep/followup";
import { runPrep, type PrepState, type StepState } from "./prep/pipeline";

// 2라운드 × (본질문 → 꼬리질문) = 4문항. AI가 만든 본질문 3개 중 앞의 2개를 쓰고 1개는 예비.
const ROUNDS = 2;
const TOTAL = ROUNDS * 2;
const FOLLOW_READ_SEC = 10; // 꼬리질문은 짧으니 읽는 시간도 짧게
const MIN_CHARS = 30;
const KEY_STORE = "sibop.geminiKey";
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* 저장 안 돼도 이번 실행엔 지장 없음 */ } },
};
const READ_SENTENCE = "안녕하세요. 오늘 면접에서 제 경험을 차분하고 또렷하게 말씀드리겠습니다.";

type Phase = "intro" | "loading" | "setup" | "ready" | "question" | "answer" | "followup" | "result";

interface Asked {
  text: string;
  kind: "main" | "follow";
  type: string; // 경험·직무·상황
  source: "ai" | "rule";
  evidence: string;
  reason?: IssueName; // 꼬리질문: 규칙이 고른 빈 곳
  issues?: IssueName[];
  error?: string; // 꼬리질문을 AI가 못 쓴 이유
  ms?: number; // 답변이 끝나고 꼬리질문이 뜨기까지
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const S = {
  phase: "intro" as Phase,
  error: "",
  video: null as HTMLVideoElement | null,
  lm: null as FaceLandmarker | null,
  delegate: "",
  mic: null as Mic | null,
  vad: null as Vad | null,
  sound: null as SoundSensor | null,
  soundAt: 0,
  gate: new SileroGate(),
  cam: new CameraSetup(),
  voice: new VoiceSetup(),
  frame: null as FrameResult | null,
  fps: 0,
  rmsDb: -100,
  asked: [] as Asked[], // 실제로 물은 질문 (results·transcripts와 같은 순서)
  phaseAt: 0,
  coach: null as AnswerCoach | null,
  results: [] as AnswerStats[],
  debug: false,
  input: { posting: "", resume: "", geminiKey: store.get(KEY_STORE) },
  prep: null as PrepState | null,
  sttMode: "none" as SttMode,
  stt: null as Transcriber | null,
  sttCheck: null as { text: string; acc: number; error: string } | null, // 문장 읽기 받아쓰기 결과
  readAttempt: -1,
  transcripts: [] as string[], // 질문별 답변 받아쓰기
  rec: null as AnswerRecorder | null,
  clips: [] as (string | null)[], // 질문별 답변 녹화 (blob: 주소, 이 브라우저 메모리에만)
  recError: "",
  facts: null as null | "running" | { rows: FactResult[]; mode: "model" | "fallback"; ms: number }, // 자소서 ↔ 답변 사실 대조
  factOff: new Set<string>(), // 사용자가 대조에서 뺀 항목
  answerComp: null as null | "running" | Awaited<ReturnType<typeof answerCompetency>>, // 필요역량이 답변에서도 드러났나
  feedback: null as null | "running" | Feedback, // 이 PC 안 AI 종합 피드백
};
const cur = () => S.asked[S.asked.length - 1];
const curQ = () => cur()?.text ?? "";
const questionsReady = () => !!S.prep?.done;
const mainCount = () => S.asked.filter((a) => a.kind === "main").length;
function askMain() {
  const q = S.prep!.questions[mainCount()];
  S.asked.push({ text: q.question, kind: "main", type: q.type, source: q.source, evidence: q.evidence });
}
function resetRun() {
  S.results = [];
  S.transcripts = [];
  S.asked = [];
  S.clips.forEach((u) => u && URL.revokeObjectURL(u));
  S.clips = [];
  S.recError = "";
  S.facts = null;
  S.answerComp = null;
  S.feedback = null;
  S.factOff.clear();
}

type Grade = "ok" | "warn" | "bad";
const grade = (n: number): Grade => (n >= PROBLEM_COUNT ? "bad" : n >= WARN_COUNT ? "warn" : "ok");
const GRADE_TEXT: Record<Grade, string> = { ok: "좋음", warn: "주의", bad: "고칠 점" };

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

function llmChip(st: LlmState) {
  if (st.kind === "loading") return `AI 준비 중 ${Math.round(st.progress * 100)}%`;
  if (st.kind === "ready") return "AI 준비 완료";
  if (st.kind === "unsupported") return "기본 질문으로 진행해요";
  if (st.kind === "error") return "기본 질문으로 진행해요";
  return "AI 확인 중";
}

function introHtml() {
  const i = S.input;
  return `
  <div class="mesh"></div>
  <div class="page">
    <nav class="nav"><div class="brand">면접<b>.</b>코치</div><span class="chip" id="llm-chip">${llmChip(llmState)}</span></nav>
    <div class="wrap">
      <section class="hero">
        <div class="hero-text">
          <h1 class="display-xl">면접,<br/>실전처럼.</h1>
          <p class="lead">채용공고와 자소서를 넣으면 그 회사에 맞는 질문으로 실제 면접처럼 연습할 수 있어요.</p>
        </div>
        <div class="hero-art" aria-hidden="true"><i class="o1"></i><i class="o2"></i><i class="o3"></i><i class="o4"></i></div>
      </section>
      <div class="inputs">
        <label class="field"><span class="field-h">희망 회사 채용공고</span>
          <span class="field-sub">자격요건, 우대사항, 인재상을 그대로 붙여 넣어 주세요</span>
          <textarea id="posting" rows="12" placeholder="예) 다양한 부서와 원활하게 협업하며 데이터를 바탕으로 문제를 해결할 분을 찾습니다.">${esc(i.posting)}</textarea></label>
        <label class="field"><span class="field-h">내 자기소개서</span>
          <span class="field-sub">이 컴퓨터 밖으로 나가지 않아요</span>
          <textarea id="resume" rows="12" placeholder="자기소개서 전체를 붙여 넣어 주세요">${esc(i.resume)}</textarea></label>
      </div>
      <details class="keybox"><summary>Gemini 키 (선택)</summary>
        <p>넣으면 필요한 역량을 더 정확하게 정리해요. 채용공고만 보내고, 키는 이 브라우저에만 저장돼요.
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">무료 키 받기</a></p>
        <input id="gkey" type="password" autocomplete="off" placeholder="AIza…" value="${esc(i.geminiKey)}" />
      </details>
      <div class="cta">
        <button class="btn-green" id="go">시작하기</button>
        <p class="privacy">자소서와 영상은 이 컴퓨터 밖으로 나가지 않아요. <span id="stt-chip">${sttNote(S.sttMode)}</span></p>
      </div>
      ${S.error ? `<div class="err">${S.error}</div>` : ""}
      <div class="steps">
        ${step(1, "역량 정리", "채용공고에서 필요한 역량을 뽑고 자소서와 맞춰 봐요")}
        ${step(2, "자리 맞추기", "질문을 만드는 동안 카메라와 목소리를 맞춰요")}
        ${step(3, `질문 ${TOTAL}개`, `${QUESTION_SEC}초 생각하고 ${ANSWER_SEC}초 답해요. 답이 끝나면 꼬리질문이 이어져요`)}
        ${step(4, "결과", "잘한 점과 고칠 점을 정리해 드려요")}
      </div>
    </div>
  </div>`;
}

/** 시작 버튼 옆 안내: 받아쓰기가 Google을 거치는 경우만 알림 (2026-10-12 결정) */
const sttNote = (m: SttMode) => (m === "cloud" ? "받아쓰기만 Google 서버를 거쳐요." : m === "none" ? "받아쓰기는 Chrome이나 Edge에서 돼요." : "");

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

function sttCheckHtml() {
  if (S.sttMode === "none") return `<div class="stt-check"><b>받아쓰기 안 됨</b><span>${STT_MODE_TEXT.none}</span></div>`;
  const c = S.sttCheck;
  if (!c) return "";
  const tone = c.acc >= 85 ? "ok" : c.acc >= 60 ? "mid" : "bad";
  return `<div class="stt-check ${tone}"><b>받아쓰기 확인 ${c.acc}%</b>
    <span>들린 문장: “${esc(c.text || "알아듣지 못했어요")}”</span>
    ${c.error ? `<span>받아쓰기 오류: ${esc(c.error === "network" ? "인터넷 연결이 불안정해요" : c.error === "not-allowed" ? "마이크 권한이 꺼져 있어요" : c.error)}</span>` : ""}
    <span>${c.acc >= 85 ? "잘 알아듣고 있어요" : "잘 못 알아들었어요. 마이크 가까이에서 또박또박 다시 읽어 보세요"}</span>
    <button class="btn-ghost-sm" id="reread">문장 다시 읽기</button></div>`;
}

function overlayHtml() {
  const meter = `<div class="meter"><i></i><b></b></div><div class="vad-mode" id="vad-mode">${vadLabel()}</div><div class="debug" ${S.debug ? "" : "hidden"}></div>`;
  if (S.phase === "loading") {
    return `<div class="setup-card"><div class="msg">카메라를 준비하고 있어요</div><div>처음에만 몇 초 걸려요</div></div>`;
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
      </div>${prepCard()}${meter}`;
  }
  if (S.phase === "ready") {
    const warns = S.cam.warnings.map((w) => `<div>${SETUP_MESSAGES[w]}</div>`).join("");
    if (!questionsReady())
      return `<div class="setup-card"><div class="msg">준비 끝! 질문을 만들고 있어요</div>
        <div>처음이라면 조금 더 걸릴 수 있어요</div></div>${prepCard()}${meter}`;
    return `<button class="start" id="start">시작</button><div class="warn-list">${warns}</div>${sttCheckHtml()}${meter}`;
  }
  if (S.phase === "followup")
    return `<div class="qslot"><div class="meta"><span class="badge">질문 ${S.asked.length + 1} / ${TOTAL}</span><span class="badge follow">꼬리질문</span><span>준비 중</span></div>
      <p class="q">방금 답변을 듣고 이어서 물어볼게요…</p></div>${meter}`;
  // question / answer
  const q = esc(curQ());
  const label = S.phase === "question" ? "생각하는 시간" : "답변 중";
  const follow = cur()?.kind === "follow" ? `<span class="badge follow">꼬리질문</span>` : "";
  return `
    <div class="qslot"><div class="meta"><span class="badge">질문 ${S.asked.length} / ${TOTAL}</span>${follow}<span>${label}</span></div>
      <p class="q">${q}</p></div>
    <div class="topbar"><div class="timer"><svg width="84" height="84"><circle cx="42" cy="42" r="36" stroke="#e4dfd4" stroke-width="8" fill="none"/>
      <circle id="ring" cx="42" cy="42" r="36" stroke="${S.phase === "question" ? "#63646e" : "#3457f0"}" stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray="226" stroke-dashoffset="0"/></svg><span id="sec"></span></div></div>
    <div class="toasts"></div>
    ${S.phase === "answer" && S.sttMode !== "none" ? `<div class="stt-live" id="stt-live">받아쓰는 중…</div>` : ""}
    <div class="bottom-actions"><button class="btn-ghost-sm" id="skip">${S.phase === "question" ? "바로 답변 시작" : "답변 끝내기"}</button></div>
    ${meter}`;
}

const STEP_ICON: Record<StepState, string> = { wait: "○", run: "◐", done: "✓", skip: "–", fail: "!" };
function prepCard() {
  const p = S.prep;
  if (!p) return "";
  const row = (st: StepState, label: string, note = "") =>
    `<div class="prep-row ${st}"><b>${STEP_ICON[st]}</b><span>${label}${note ? `<small>${esc(note)}</small>` : ""}</span></div>`;
  const ai = llmState.kind === "loading" && p.steps.questions === "run" ? ` (${Math.round(llmState.progress * 100)}%)` : "";
  return `<div class="prep-card" id="prep-card">
    ${row(p.steps.rules, "채용공고 읽기")}
    ${row(p.steps.gemini === "skip" ? "done" : p.steps.gemini, "필요한 역량 정리")}
    ${row(p.steps.resume, "자소서와 맞춰 보기")}
    ${row(p.done ? "done" : p.steps.questions, `질문 만들기${ai}`)}
  </div>`;
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
  // 주변 소음은 가장 오래 들린 소리 종류를 붙인다 (소리 분류를 못 불러왔으면 그대로)
  const kinds: Record<string, number> = {};
  for (const r of S.results) for (const [k, v] of Object.entries(r.noiseKinds ?? {})) kinds[k] = (kinds[k] ?? 0) + v;
  const loudest = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]?.[0];
  const noiseRow = all.get("noise");
  if (noiseRow && loudest) noiseRow.label += ` (주로 ${loudest})`;
  const rows = [...all.values()].sort((a, b) => b.count - a.count);
  const total = rows.reduce((a, r) => a + r.count, 0);
  const shown = rows.reduce((a, r) => a + r.shown, 0);
  const top = rows[0]?.label ?? "없음";
  const perQ = S.results
    .map((r, i) => `<tr><td>질문 ${i + 1}${S.asked[i]?.kind === "follow" ? " <span class='badge follow'>꼬리</span>" : ""}</td><td>${r.durationS}초</td><td>${r.alerts.map((a) => `${a.label} ${a.count}`).join(", ") || "경고 없음"}</td></tr>
      <tr><td colspan="3" class="asked">${esc(S.asked[i]?.text ?? "")}${askedNote(S.asked[i])}</td></tr>
      <tr><td colspan="3" class="transcript">${S.sttMode === "none" ? "받아쓰기 안 됨" : S.transcripts[i] === undefined ? "받아쓰는 중…" : esc(S.transcripts[i] || "(받아쓴 내용 없음)")}</td></tr>`)
    .join("");
  const settings = S.mic?.settings ?? {};
  return `
  <div class="mesh"></div>
  <div class="page"><div class="wrap">
    <nav class="nav"><div class="brand">면접<b>.</b>코치</div><span class="badge">결과</span></nav>
    <h1 class="display-md">이번 연습 결과</h1>
    <div class="stats">
      <div class="stat"><div class="v">${total}</div><div class="k">경고 횟수</div></div>
      <div class="stat"><div class="v">${shown}</div><div class="k">화면에 뜬 알림</div></div>
      <div class="stat"><div class="v" style="font-size:32px;line-height:1.2">${top}</div><div class="k">가장 많이 받은 경고</div></div>
    </div>
    ${feedbackHtml()}
    ${coverageHtml()}
    <div class="card-dark">
      <h2 style="margin-top:0">경고 모아 보기</h2>
      <table><tr><th>경고</th><th>상태</th><th>횟수</th><th>지속 시간</th><th>화면 알림</th></tr>
      ${rows.map((r) => `<tr><td>${r.label}</td><td><span class="grade ${grade(r.count)}">${GRADE_TEXT[grade(r.count)]}</span></td><td>${r.count}회</td><td>${r.seconds.toFixed(1)}초</td><td>${r.shown}회</td></tr>`).join("") || `<tr><td colspan="5">경고가 없었어요</td></tr>`}
      </table>
      <p class="muted">${TOTAL}문항을 합쳐 ${WARN_COUNT - 1}회까지 좋음, ${WARN_COUNT}~${PROBLEM_COUNT - 1}회 주의, ${PROBLEM_COUNT}회부터 고칠 점이에요. 답변 중에는 가끔만 알려 드렸지만 여기에는 전부 셌어요.</p>
      ${evidenceHtml()}
      ${factsHtml()}
      ${answerCompHtml()}
      <h2>질문별</h2>
      <table>${perQ}</table>
    </div>
    <div class="actions">
      <button class="btn-primary" id="download">결과 파일 받기</button>
      <button class="btn-green" id="again">다시 하기</button>
      <button class="btn-ghost" id="new-input">다른 자소서로 하기</button>
    </div>
    ${S.debug ? "" : "<!--"}<details><summary>측정 정보</summary><pre>${JSON.stringify(
      { face: S.delegate, fps: Math.round(S.fps), mic: { autoGainControl: settings.autoGainControl, noiseSuppression: settings.noiseSuppression, sampleRate: settings.sampleRate },
        prep: S.prep && { timings: S.prep.timings, requiredBy: S.prep.requiredBy, questionsBy: S.prep.questionsBy, llm: llmState.kind, notes: S.prep.note },
        vad: { mode: S.vad?.mode, error: S.vad?.error, sileroShare: S.results.map((r) => r.vadShare) },
        noiseDb: S.voice.noiseDb?.toFixed(1), voiceDb: S.voice.voiceDb?.toFixed(1), stt: { mode: S.sttMode, check: S.sttCheck }, camera: S.cam.warnings, ua: navigator.userAgent }, null, 2)}</pre></details>${S.debug ? "" : "-->"}
  </div></div>`;
}

// ── 자소서 ↔ 답변 사실 대조 ──
const VERDICT_CLASS: Record<string, string> = { 일치: "ok", 불일치: "bad", "말 안 함": "none", "확인 필요": "warn" };

/** 받아쓰기가 다 모이면 한 번 돈다. 자소서·답변은 이 PC 안에서만 비교 */
function runFactCheck() {
  // 받아쓰기가 안 되는 브라우저도 자세·목소리 경고로 종합 피드백은 쓴다
  if (S.sttMode === "none" && S.results.length && S.feedback === null) return void runFeedback().finally(() => S.phase === "result" && render());
  if (S.facts !== null || S.sttMode === "none" || S.results.length === 0) return;
  if (S.results.some((_, i) => S.transcripts[i] === undefined)) return;
  const facts = extractFacts(S.input.resume);
  S.facts = "running";
  const t0 = performance.now();
  void checkFacts(facts, S.transcripts, { ask: jsonAsker(RECHECK_SCHEMA, 80) })
    .then((r) => (S.facts = { ...r, ms: performance.now() - t0 }))
    .catch(() => (S.facts = { rows: [], mode: "fallback", ms: 0 }))
    .then(runAnswerComp) // AI를 한 번에 하나씩 쓰도록 차례로
    .then(runFeedback)
    .finally(() => S.phase === "result" && render());
}

async function runAnswerComp() {
  if (!S.prep?.coverage.length) return;
  S.answerComp = "running";
  if (S.phase === "result") render();
  try {
    S.answerComp = await answerCompetency(S.prep.coverage, S.transcripts); // AI 판정은 검증 페이지에서만 (2026-10-26)
  } catch {
    S.answerComp = { rows: [], judgments: [] };
  }
}

async function runFeedback() {
  S.feedback = "running";
  if (S.phase === "result") render();
  const counts = new Map<string, number>();
  S.results.forEach((r) => r.alerts.forEach((a) => counts.set(a.label, (counts.get(a.label) ?? 0) + a.count)));
  const facts = typeof S.facts === "object" && S.facts ? S.facts.rows.filter((r) => !S.factOff.has(r.id)) : [];
  const comps = typeof S.answerComp === "object" && S.answerComp ? S.answerComp.rows : [];
  S.feedback = await makeFeedback(
    {
      alerts: [...counts].map(([label, count]) => ({ label, count, grade: grade(count) })),
      facts: facts.map((f) => ({ kind: f.kind, text: f.text, verdict: f.verdict, said: f.said })),
      comps: comps.map((c) => ({ name: c.name, verdict: c.verdict })),
      issues: S.asked.filter((a) => a.kind === "follow" && a.reason).map((a) => ISSUE_LABELS[a.reason!]),
    },
    jsonAsker(FEEDBACK_SCHEMA, 220),
  );
}

function feedbackHtml() {
  const head = `<h2 style="margin-top:0">종합 피드백</h2>`;
  if (S.feedback === null || S.feedback === "running") return `<div class="card-dark" style="margin-bottom:16px">${head}<div class="muted">답변을 정리하고 있어요…</div></div>`;
  const f = S.feedback;
  return `<div class="card-dark" style="margin-bottom:16px">${head}<p class="feedback">${esc(f.text)}</p></div>`;
}

const ANSWER_VERDICT_CLASS: Record<string, string> = { "둘 다": "ok", 자소서만: "warn", 답변만: "ok", "둘 다 없음": "bad" };
function answerCompHtml() {
  const head = `<h2>답변에서도 역량이 보였나요</h2>`;
  if (!S.prep?.coverage.length) return "";
  if (S.sttMode === "none") return `${head}<div class="muted">받아쓰기가 안 돼서 확인할 수 없어요.</div>`;
  if (S.answerComp === null || S.answerComp === "running") return `${head}<div class="muted">답변에서 역량을 찾고 있어요…</div>`;
  const rows = S.answerComp.rows;
  return `${head}<table><tr><th>필요한 역량</th><th>결과</th><th>답변에서 찾은 말</th></tr>
    ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td><span class="grade ${ANSWER_VERDICT_CLASS[r.verdict]}">${r.verdict}</span></td><td>${r.inAnswer ? `질문 ${r.q + 1}: “${esc(r.evidence)}”` : "<span class='muted'>찾지 못했어요</span>"}</td></tr>`).join("")}
    </table>
    <p class="muted">'자소서만'은 자소서에는 썼지만 답변에서는 드러나지 않은 역량이에요.</p>`;
}

function factsHtml() {
  const head = `<h2>자소서와 답변 맞춰 보기</h2>`;
  if (S.sttMode === "none") return `${head}<div class="muted">받아쓰기가 안 돼서 맞춰 볼 수 없어요.</div>`;
  if (S.facts === null || S.facts === "running") return `${head}<div class="muted">자소서와 답변을 맞춰 보고 있어요…</div>`;
  const { rows } = S.facts;
  if (!rows.length) return `${head}<div class="muted">자소서에서 기간, 숫자, 역할, 프로젝트 이름을 찾지 못했어요.</div>`;
  const used = rows.filter((r) => !S.factOff.has(r.id));
  const count = (v: string) => used.filter((r) => r.verdict === v).length;
  const tr = rows
    .map((r) => {
      const off = S.factOff.has(r.id);
      return `<tr class="${off ? "off" : ""}"><td><input type="checkbox" data-fact="${r.id}" ${off ? "" : "checked"} aria-label="이 항목 세기"></td>
        <td>${r.kind}</td><td><b>${esc(r.text)}</b><div class="fact-src">${esc(r.sentence)}</div></td>
        <td><span class="grade ${VERDICT_CLASS[r.verdict]}">${r.verdict}</span>${r.said ? `<div>답변: <b>${esc(r.said)}</b></div>` : ""}</td>
        <td>${r.answerSentence ? `질문 ${r.q + 1}: “${esc(r.answerSentence)}”` : `<span class="muted">${esc(r.note)}</span>`}</td></tr>`;
    })
    .join("");
  return `${head}
    <p class="facts-sum">일치 <b>${count("일치")}</b>, 불일치 <b>${count("불일치")}</b>, 말 안 함 <b>${count("말 안 함")}</b>, 확인 필요 <b>${count("확인 필요")}</b> <span class="muted">(체크한 ${used.length}개)</span></p>
    <table class="facts"><tr><th></th><th>종류</th><th>자소서</th><th>결과</th><th>답변</th></tr>${tr}</table>
    <p class="muted">체크를 풀면 그 항목은 빼고 세요.</p>`;
}

// ── 경고 장면 클립 (다시보기) ──
interface Clip { q: number; from: number; to: number; names: string[] }
const CLIP_TAIL_SEC = 2; // 경고가 끝난 뒤 이만큼 더 보여 줌

/** 경고 구간을 앞뒤 여유를 붙인 클립으로 만들고, 같은 질문에서 겹치는 클립은 하나로 합친다 */
function buildClips(): Clip[] {
  const out: Clip[] = [];
  S.results.forEach((r, q) => {
    if (!S.clips[q]) return;
    for (const e of r.events) {
      const c: Clip = { q, from: Math.max(0, e.start - CLIP_LEAD_SEC), to: Math.min(r.durationS, e.end + CLIP_TAIL_SEC), names: [e.name] };
      const last = out[out.length - 1];
      if (last && last.q === q && c.from <= last.to) {
        last.to = Math.max(last.to, c.to);
        if (!last.names.includes(e.name)) last.names.push(e.name);
      } else out.push(c);
    }
  });
  return out;
}
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function evidenceHtml() {
  if (!S.results.some((r) => r.events.length)) return "";
  if (S.results.some((_, i) => S.clips[i] === undefined)) return `<h2>경고 장면 다시보기</h2><div class="muted">영상 정리 중…</div>`;
  const clips = buildClips();
  if (!clips.length) return `<h2>경고 장면 다시보기</h2><div class="muted">녹화 영상이 없어요${S.recError ? ` (${esc(S.recError)})` : ""}</div>`;
  const total = new Map<string, number>();
  S.results.forEach((r) => r.alerts.forEach((a) => total.set(a.name, (total.get(a.name) ?? 0) + a.count)));
  const worst = (names: string[]) => names.map((n) => grade(total.get(n) ?? 0)).sort((x, y) => "okwarnbad".indexOf(y) - "okwarnbad".indexOf(x))[0];
  const cards = clips
    .map((c, k) => `<button class="clip ${worst(c.names)}" data-k="${k}">
      <span class="clip-q">질문 ${c.q + 1}${S.asked[c.q]?.kind === "follow" ? " 꼬리질문" : ""}, ${mmss(c.from)}–${mmss(c.to)}</span>
      <b>${c.names.map((n) => esc(ALERT_LABELS[n])).join(", ")}</b>
      <span class="grade ${worst(c.names)}">${GRADE_TEXT[worst(c.names)]}</span></button>`)
    .join("");
  return `<h2>경고 장면 다시보기 <span class="badge">${clips.length}개</span></h2>
    <p class="muted">경고가 뜨기 ${CLIP_LEAD_SEC}초 전부터 보여 줘요. 영상은 저장되지 않고 창을 닫으면 사라져요.</p>
    <div class="replay"><div class="player"><video id="replay" playsinline controls></video><div class="now" id="replay-now">장면을 고르거나 '전체 이어보기'를 눌러 보세요</div></div>
    <div class="clips"><button class="btn-primary" id="play-all">▶ 전체 이어보기</button>${cards}</div></div>`;
}

// 다시보기 재생기: 클립 하나 또는 전체를 순서대로, 클립 끝에서 멈추거나 다음으로 넘어감
let clipQueue: number[] = [];
let clipList: Clip[] = [];
async function playClip(k: number) {
  const c = clipList[k];
  const v = $<HTMLVideoElement>("#replay");
  if (!v) return;
  const url = S.clips[c.q]!;
  if (v.dataset.q !== String(c.q)) {
    v.src = url;
    v.dataset.q = String(c.q);
    await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    await fixDuration(v);
  }
  v.currentTime = c.from;
  v.dataset.to = String(c.to);
  app.querySelectorAll<HTMLElement>(".clip").forEach((el) => el.classList.toggle("on", el.dataset.k === String(k)));
  const now = $("#replay-now");
  if (now) now.textContent = `질문 ${c.q + 1}, ${c.names.map((n) => ALERT_LABELS[n]).join(", ")} (${mmss(c.from)}–${mmss(c.to)})`;
  void v.play();
}
function bindReplay() {
  const v = $<HTMLVideoElement>("#replay");
  if (!v) return;
  clipList = buildClips();
  clipQueue = [];
  const advance = () => {
    v.pause();
    delete v.dataset.to;
    const next = clipQueue.shift();
    if (next !== undefined) void playClip(next);
  };
  v.addEventListener("timeupdate", () => v.dataset.to && v.currentTime >= Number(v.dataset.to) - 0.05 && advance());
  v.addEventListener("ended", () => v.dataset.to && advance());
  app.querySelectorAll<HTMLButtonElement>(".clip").forEach((b) =>
    b.addEventListener("click", () => {
      clipQueue = [];
      void playClip(Number(b.dataset.k));
    }),
  );
  $("#play-all")?.addEventListener("click", () => {
    clipQueue = clipList.map((_, k) => k).slice(1);
    void playClip(0);
  });
}

function coverageHtml() {
  const p = S.prep;
  if (!p?.coverage.length) return "";
  const hit = p.coverage.filter((c) => c.found.length).length;
  return `<div class="card-dark" style="margin-bottom:16px">
    <h2 style="margin-top:0">회사가 원하는 역량과 내 자소서 <span class="badge">${p.coverage.length}개 중 ${hit}개 있음</span></h2>
    <table><tr><th>필요한 역량</th><th>채용공고에서</th><th>자소서에서</th></tr>
    ${p.coverage.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.reason)}</td><td>${c.found.length ? `${esc(c.found.join(", "))}${c.via !== "단어" && c.evidence ? `<div class="fact-src">${esc(c.evidence)}</div>` : ""}` : "<span style='color:var(--magenta)'>안 보여요</span>"}</td></tr>`).join("")}
    </table>
  </div>`;
}

function askedNote(a?: Asked) {
  if (!a) return "";
  if (a.kind === "main") return a.evidence ? `<small>자소서의 “${esc(a.evidence)}”에서 나온 질문</small>` : "";
  return `<small>짚은 부분: ${ISSUE_LABELS[a.reason!]}</small>`;
}

// ── 이벤트 ─────────────────────────────────────────────

function bindPage() {
  $("#go")?.addEventListener("click", () => {
    const posting = ($<HTMLTextAreaElement>("#posting")?.value ?? "").trim();
    const resume = ($<HTMLTextAreaElement>("#resume")?.value ?? "").trim();
    const geminiKey = ($<HTMLInputElement>("#gkey")?.value ?? "").trim();
    S.input = { posting, resume, geminiKey };
    if (posting.length < MIN_CHARS || resume.length < MIN_CHARS) {
      S.error = `채용공고와 자소서를 각각 ${MIN_CHARS}자 이상 넣어 주세요.`;
      return render();
    }
    store.set(KEY_STORE, geminiKey);
    S.prep = runPrep(S.input, (p) => {
      S.prep = p;
      if (S.phase === "ready" || (S.phase === "setup" && !$("#prep-card"))) return render();
      const card = $("#prep-card");
      if (card) card.outerHTML = prepCard();
    });
    void start();
  });
  $("#new-input")?.addEventListener("click", () => {
    resetRun();
    S.prep = null;
    S.mic?.stop();
    (S.video?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    S.video = null;
    S.cam = new CameraSetup();
    S.voice = new VoiceSetup();
    go("intro");
  });
  $("#again")?.addEventListener("click", () => {
    resetRun();
    S.cam = new CameraSetup();
    S.voice = new VoiceSetup();
    go("setup");
  });
  bindReplay();
  runFactCheck();
  app.querySelectorAll<HTMLInputElement>("input[data-fact]").forEach((el) =>
    el.addEventListener("change", () => {
      const y = window.scrollY;
      if (el.checked) S.factOff.delete(el.dataset.fact!);
      else S.factOff.add(el.dataset.fact!);
      render();
      window.scrollTo(0, y);
    }),
  );
  $("#download")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), sttMode: S.sttMode, sttCheck: S.sttCheck, results: S.results.map((r, i) => ({ ...r, asked: S.asked[i], transcript: S.transcripts[i] ?? "" })), competency: S.prep && { requiredBy: S.prep.requiredBy, coverage: S.prep.coverage, semantic: S.prep.semantic, judgments: S.prep.judgments, model: currentModel(), timings: S.prep.timings }, answerCompetency: typeof S.answerComp === "object" ? S.answerComp : null, feedback: typeof S.feedback === "object" ? S.feedback : null, factCheck: typeof S.facts === "object" && S.facts ? { mode: S.facts.mode, rows: S.facts.rows.map((f) => ({ ...f, used: !S.factOff.has(f.id) })) } : null }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `면접코치-${Date.now()}.json` });
    a.click();
  });
}

function bindOverlay() {
  $("#redo")?.addEventListener("click", () => {
    S.cam = new CameraSetup();
    S.voice = new VoiceSetup();
    S.readAttempt = -1;
    S.sttCheck = null;
    render();
  });
  $("#start")?.addEventListener("click", () => {
    resetRun();
    askMain();
    go("question");
  });
  $("#reread")?.addEventListener("click", () => {
    S.voice = new VoiceSetup();
    S.sttCheck = null;
    go("setup");
  });
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
    const base = { box: S.cam.baseBox!, gazeStd: S.cam.baseGazeStd, targets: S.cam.lookTargets() };
    const v = S.voice;
    S.coach = new AnswerCoach(base, { noiseRms: v.noiseRms!, noiseDb: v.noiseDb!, voiceDb: v.voiceDb! }, S.phaseAt, curQ());
    startStt();
    startRecording();
    void preloadEmbedder(); // 결과 화면 사실 대조용 뜻 비교 모델을 면접 중에 미리 받음
  }
  render();
}

function startStt() {
  S.stt?.stop(0);
  // 자소서의 프로젝트 이름, 숫자, 기간을 받아쓰기 힌트로 (사실 대조가 이 단어들을 비교하므로)
  const hints = extractFacts(S.input.resume).filter((f) => f.kind !== "역할").map((f) => f.text);
  S.stt = new Transcriber(S.sttMode, (text) => {
    const live = $("#stt-live");
    if (live) live.textContent = `“${text.slice(-30)}”`;
  }, hints);
  S.stt.start();
}

function startRecording() {
  const cam = S.video?.srcObject as MediaStream | null;
  if (!cam) return;
  S.rec = new AnswerRecorder();
  S.rec.start(new MediaStream([...cam.getVideoTracks(), ...(S.mic?.stream.getAudioTracks() ?? [])]));
  if (S.rec.error) S.recError = S.rec.error;
}

function endAnswer() {
  if (!S.coach) return;
  const qi = S.results.length;
  const asked = cur();
  const stt = S.stt;
  S.stt = null;
  const text = stt ? stt.stop() : Promise.resolve("");
  void text.then((t) => {
    S.transcripts[qi] = t;
    if (S.phase === "result") render();
  });
  const rec = S.rec;
  S.rec = null;
  void (rec ? rec.stop() : Promise.resolve(null)).then((url) => {
    S.clips[qi] = url;
    if (S.phase === "result") render();
  });
  S.results.push({ ...S.coach.finish(now()), sttRestarts: stt?.restarts ?? 0 });
  S.coach = null;
  if (asked.kind === "main") return void nextFollowup(asked, text, stt?.error ?? "");
  if (mainCount() < ROUNDS) {
    askMain();
    go("question");
  } else go("result");
}

/** 본질문 답변이 끝나면: 받아쓰기 마무리 → 규칙이 빈 곳 찾기 → 이 PC 안 AI가 꼬리질문 한 문장 */
async function nextFollowup(main: Asked, text: Promise<string>, sttError: string) {
  go("followup");
  const t0 = performance.now();
  const answer = await text;
  const history = loadHistory(S.input.resume);
  const f = await makeFollowup({ type: main.type, question: main.text, evidence: main.evidence, source: main.source }, answer, {
    ask: followupAsker(),
    history,
  });
  if (!answer && S.sttMode !== "none") f.error = `답변을 받아쓰지 못했어요${sttError ? ` (${sttError === "network" ? "인터넷 연결 문제" : sttError})` : " (말소리가 안 들렸거나 마이크 문제)"}`;
  saveHistory(S.input.resume, f.question);
  S.asked.push({ text: f.question, kind: "follow", type: main.type, source: f.source, evidence: main.evidence, reason: f.reason, issues: f.issues, error: f.error, ms: performance.now() - t0 });
  if (S.phase === "followup") go("question");
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
    S.vad?.stop();
    S.gate = new SileroGate();
    S.vad = startVad((p) => S.gate.feed(now(), p), onVadMode);
    S.mic = await openMic(onRms, (frame) => {
      S.sound?.push(frame); // 말소리 판정기로 넘기면 버퍼가 옮겨지므로 먼저 복사
      S.vad?.push(frame, now());
    });
    // 소리 종류 분류는 없어도 코칭이 되므로 기다리지 않고, 실패하면 조용히 뺀다
    S.sound = null;
    void startSound().then((s) => (S.sound = s)).catch((e) => console.warn("소리 분류 못 불러옴", e));
    const { lm, delegate } = await createLandmarker();
    S.lm = lm;
    S.delegate = delegate;
    runFaceLoop(S.video, lm, onFrame);
    go("setup");
  } catch (e) {
    S.mic?.stop();
    S.vad?.stop();
    (S.video?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    const name = (e as Error).name;
    S.error =
      name === "NotAllowedError" ? "카메라와 마이크 권한이 꺼져 있어요. 주소창 왼쪽 자물쇠 아이콘에서 허용해 주세요."
      : name === "NotFoundError" ? "카메라나 마이크를 찾지 못했어요."
      : `시작하지 못했어요: ${(e as Error).message}`;
    S.phase = "intro";
    render();
  }
}

// ── 매 프레임·매 소리 조각 ─────────────────────────────────────────────

/** 주변 소음 경고엔 들린 소리 종류를 붙인다 (예: 주변이 시끄러워요 (음악)) */
function alertText(k: string) {
  const kind = k === "noise" ? S.coach?.sound : null;
  return kind ? `${ALERT_LABELS[k]} (${kind})` : ALERT_LABELS[k];
}

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
    // 문장 읽기가 시작되거나 다시 읽을 때마다 받아쓰기도 새로 시작
    if (S.voice.step === "voice" && S.readAttempt !== S.voice.attempt) {
      S.readAttempt = S.voice.attempt;
      startStt();
    }
    if (S.voice.step !== before) {
      if (!S.voice.active) {
        finishReadCheck();
        return go("ready");
      }
      return render();
    }
  }
  if (S.phase === "answer") {
    const speech = S.vad?.mode === "silero" ? S.gate.at(t) : null;
    S.coach?.onAudio(t, rms, speech);
    if (S.coach?.voice?.speaking) S.stt?.speech(); // 내 말로 본 때만 (TV 소리로 받아쓰기를 깨우지 않게)
    else if (S.coach && S.sound?.ready && t - S.soundAt >= SOUND_EVERY_SEC) {
      S.coach.onSound(S.sound.classify(), Math.min(t - S.soundAt, SOUND_EVERY_SEC * 2));
      S.soundAt = t;
    }
  }
}

const VAD_LABELS: Record<VadMode, string> = {
  loading: "",
  silero: "",
  energy: "주변이 시끄러우면 말이 멈춘 걸 잘 못 알아챌 수 있어요",
};
function vadLabel() {
  return S.vad ? VAD_LABELS[S.vad.mode] : "";
}
function onVadMode(_: VadMode) {
  const el = $("#vad-mode");
  if (el) el.textContent = vadLabel();
}

function finishReadCheck() {
  const stt = S.stt;
  S.stt = null;
  S.readAttempt = -1;
  if (!stt) return;
  void stt.stop().then((text) => {
    S.sttCheck = { text, acc: accuracy(READ_SENTENCE, text), error: stt.error };
    if (S.phase === "ready") render();
  });
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
    const total = S.phase === "answer" ? ANSWER_SEC : cur()?.kind === "follow" ? FOLLOW_READ_SEC : QUESTION_SEC;
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
      box.innerHTML = S.coach.shown.map((k) => `<div class="toast ${STATUS_ALERTS.has(k) ? "status" : ""}">${alertText(k)}</div>`).join("");
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
      `말소리 판정 ${S.vad?.mode ?? "-"} ${S.vad?.error ?? ""} AI말함 ${S.gate.at(t) === null ? "-" : S.gate.at(t) ? "O" : "X"}`,
      v ? `말함 ${v.speaking ? "O" : "X"} 차이 ${v.levelGapDb?.toFixed(1) ?? "-"} 바닥소음 ${v.noiseFloorDb?.toFixed(1) ?? "-"}` : "",
    ].filter(Boolean).join("\n");
  }
}

// 얼굴이 안 잡혀 프레임이 멈춰도 타이머는 흐르게
setInterval(() => {
  if (S.phase === "question" || S.phase === "answer") tickUi();
}, 250);

// 입력 화면을 여는 순간 AI 모델을 받기 시작 (입력하는 동안 받음)
onLlmState((st) => {
  const chip = $("#llm-chip");
  if (chip) chip.textContent = llmChip(st);
  const card = $("#prep-card");
  if (card && st.kind === "loading") card.outerHTML = prepCard();
});
void preloadLlm();
void sttMode().then((m) => {
  S.sttMode = m;
  const chip = $("#stt-chip");
  if (chip) chip.textContent = sttNote(m);
});
render();
