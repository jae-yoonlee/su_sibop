// 화면은 서버(Python)가 보내는 상태를 그리기만 한다. 판정은 전부 서버가 한다.
const $ = (id) => document.getElementById(id);
const OUTCOME = {
  shown: "알려 드림",
  report_only: "결과에만 기록",
  dropped: "말하는 사이 스스로 고침",
  suppressed: "같은 내용이라 생략",
};
const STEP_ORDER = ["position", "lens", "screen"];

let selectedQuestion = null;
let report = null;      // 마지막 연습 결과 (결과 화면을 보는 중이면 값이 있음)
let lastPhase = null;

async function command(action, extra = {}) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const out = await res.json();
  showError(out.ok ? null : out.error);
  return out;
}

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg || "";
}

function showView(name) {
  for (const v of ["setup", "ready", "practice", "result"]) $(`view-${v}`).hidden = v !== name;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setPill(el, text, kind) {
  el.textContent = text;
  el.className = `pill ${kind || ""}`;
}

function setChip(id, text, kind) {
  $(`${id}-text`).textContent = text;
  $(id).className = `chip ${kind || ""}`;
}

function renderState(s) {
  if (s.phase === "loading") {
    $("loading").hidden = false;
    $("loading").textContent = s.error || "카메라를 여는 중입니다";
    setPill($("pill-camera"), s.error ? "카메라 문제" : "카메라 준비 중", s.error ? "warn" : "");
    return;
  }
  $("loading").hidden = !s.error;
  $("loading").textContent = s.error || "";
  setPill($("pill-camera"), s.error ? "카메라 문제" : "카메라 연결됨", s.error ? "warn" : "ok");
  if (s.no_audio) setPill($("pill-mic"), "마이크 없음", "warn");
  else setPill($("pill-mic"), s.speaking == null ? "마이크 준비 중" : "마이크 연결됨", s.speaking == null ? "" : "ok");

  // 아래 상태 줄
  if (s.phase === "setup") setChip("s-face", "자리 잡는 중", "");
  else setChip("s-face", s.posture, s.posture === "좋아요" ? "good" : "bad");
  if (s.no_audio) setChip("s-voice", "마이크 없음", "");
  else if (s.speaking == null) setChip("s-voice", "준비 중", "");
  else setChip("s-voice", s.speaking ? "말하는 중" : "쉬는 중", s.speaking ? "good" : "");
  if (s.phase !== "practice") setChip("s-wait", "연습 중에만 알려요", "");
  else if (s.cards && s.cards.length) setChip("s-wait", "지금 확인해 주세요", "bad");
  else if (s.pending && s.pending.length) setChip("s-wait", "숨 고를 때 알려 드릴게요", "");
  else setChip("s-wait", "잘하고 있어요", "good");

  // 영상 위 안내
  $("setup-msg").hidden = s.phase !== "setup";
  if (s.phase === "setup") $("setup-msg").textContent = s.setup.message;
  $("question-banner").hidden = s.phase !== "practice" || !s.question;
  $("question-banner").textContent = s.question || "";
  const card = (s.cards || [])[0];
  $("alert").hidden = !card;
  $("video-wrap").classList.toggle("alerting", !!card && card.name !== "away");
  if (card) {
    $("alert").className = card.name === "away" ? "alert status" : "alert";
    $("alert-title").textContent = card.title;
    $("alert-detail").textContent = card.detail;
  }

  // 오른쪽 패널
  if (s.phase === "setup") {
    report = null;
    showView("setup");
    const now = STEP_ORDER.indexOf(s.setup.step);
    document.querySelectorAll(".steps li").forEach((li) => {
      const i = STEP_ORDER.indexOf(li.dataset.step);
      li.className = i < now ? "done" : i === now ? "now" : "";
    });
    $("btn-skip").hidden = s.setup.step !== "position";
  } else if (s.phase === "practice") {
    showView("practice");
    $("practice-q").textContent = s.question || "질문 없이 연습 중";
    $("timer").textContent = fmtTime(s.elapsed_s || 0);
  } else if (report) {
    showView("result");
  } else {
    showView("ready");
    if (lastPhase !== "ready") renderWarnings(s.setup.warnings);
  }
  lastPhase = s.phase;
}

function renderWarnings(warnings) {
  const box = $("setup-warnings");
  box.innerHTML = "";
  if (!warnings.length) {
    box.innerHTML = '<div class="note good">카메라 위치가 좋아요.</div>';
    return;
  }
  for (const w of warnings) {
    const el = document.createElement("div");
    el.className = "note warn";
    el.textContent = w;
    box.appendChild(el);
  }
}

async function loadQuestions() {
  const { questions } = await (await fetch("/api/questions")).json();
  const list = $("questions");
  for (const q of questions) {
    const li = document.createElement("li");
    li.textContent = q;
    li.onclick = () => selectQuestion(q, li);
    list.appendChild(li);
  }
}

function selectQuestion(q, li) {
  selectedQuestion = q;
  document.querySelectorAll(".questions li").forEach((x) => x.classList.toggle("selected", x === li));
  if (li) $("custom-q").value = "";
  $("btn-start").disabled = !q;
}

function renderReport(r) {
  $("r-question").textContent = r.question || "질문 없이 연습";
  $("r-duration").textContent = fmtTime(r.duration_s);
  $("r-shown").textContent = `${r.cards.reduce((a, c) => a + c.shown, 0)}회`;

  const chart = $("r-chart");
  chart.innerHTML = "";
  const rows = [
    { name: "turn", label: "옆을 봄" },
    { name: "down", label: "고개 숙임" },
    { name: "away", label: "화면 밖" },
  ].map((row) => ({ ...row, seconds: (r.held_s.find((h) => h.name === row.name) || {}).seconds || 0 }));
  const max = Math.max(...rows.map((x) => x.seconds), 1);
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "bar-row";
    const width = row.seconds ? `${(row.seconds / max) * 100}%` : "";
    el.innerHTML = `<span class="name"></span><div class="bar-track"><div class="bar ${row.seconds ? "" : "zero"}" style="width:${width}"></div></div><span class="val">${row.seconds.toFixed(1)}초</span>`;
    el.querySelector(".name").textContent = row.label;
    chart.appendChild(el);
  }

  const tbody = $("r-log");
  tbody.innerHTML = "";
  const labels = Object.fromEntries(r.cards.map((c) => [c.name, c.label]));
  if (!r.log.length) tbody.innerHTML = '<tr><td colspan="3" class="empty">고칠 점이 없었어요</td></tr>';
  for (const row of r.log) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmtTime(row.t)}</td><td></td><td class="${row.outcome === "shown" ? "shown" : ""}">${OUTCOME[row.outcome] || row.outcome}</td>`;
    tr.children[1].textContent = labels[row.name] || row.name;
    tbody.appendChild(tr);
  }

  const notes = $("r-setup");
  notes.innerHTML = "";
  if (r.no_audio) {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = "마이크 없이 연습해서 숨 고르는 순간을 알 수 없었어요. 알림은 일정한 간격으로만 보여 드렸어요.";
    notes.appendChild(el);
  }
}

$("btn-skip").onclick = () => command("skip_position");
$("btn-redo").onclick = () => command("redo_setup");
$("btn-start").onclick = () => command("start", { question: selectedQuestion });
$("btn-stop").onclick = async () => {
  const out = await command("stop");
  if (out.ok && out.report) {
    report = out.report;
    renderReport(report);
    showView("result");
  }
};
$("btn-again").onclick = () => {
  report = null;
  showView("ready");
};
$("custom-q").oninput = (e) => {
  const q = e.target.value.trim();
  selectQuestion(q || null, null);
};

function connect() {
  const es = new EventSource("/events");
  es.onmessage = (e) => renderState(JSON.parse(e.data));
  es.onerror = () => {
    setPill($("pill-camera"), "프로그램 연결 끊김", "warn");
    es.close();
    setTimeout(connect, 1500);
  };
}

loadQuestions();
connect();
