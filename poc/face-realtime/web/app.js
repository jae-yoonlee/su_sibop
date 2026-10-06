// 화면은 서버(Python)가 보내는 상태를 그리기만 한다. 판정은 전부 서버가 한다.
const $ = (id) => document.getElementById(id);
const OUTCOME = { shown: "화면에 띄움", report_only: "안 띄우고 기록만", dropped: "스스로 고침", suppressed: "방금 알려서 생략" };
const POSE = { away: "얼굴이 안 보여요", shift: "몸이 한쪽으로 치우쳤어요", turn: "옆을 보고 있어요", down: "고개가 숙여졌어요" };
const STEP_ORDER = ["position", "lens", "screen"];

let selectedQuestion = null;
let report = null;      // 마지막 연습 결과 (결과 화면을 보는 중이면 값이 있음)
let lastPhase = null;
let lastCards = "";     // 같은 경고가 떠 있는 동안 다시 그리지 않게 (애니메이션이 계속 재시작됨)

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

function renderState(s) {
  if (s.phase === "loading") {
    $("loading").hidden = false;
    $("loading").textContent = s.error || "카메라를 여는 중입니다";
    setPill($("pill-camera"), s.error ? "카메라 오류" : "카메라 준비 중", s.error ? "warn" : "");
    return;
  }
  $("loading").hidden = !s.error;
  $("loading").textContent = s.error || "";
  setPill($("pill-camera"), s.error ? "카메라 오류" : "카메라 연결됨", s.error ? "warn" : "ok");
  if (s.no_audio) setPill($("pill-mic"), "마이크 없음", "warn");
  else setPill($("pill-mic"), s.speaking == null ? "마이크 확인 중" : "마이크 연결됨", s.speaking == null ? "" : "ok");

  // 영상 아래 상태 줄
  const bad = Object.keys(POSE).find((k) => (s.active || []).includes(k));
  $("m-pose").textContent = s.phase === "setup" ? "카메라 맞추는 중" : bad ? POSE[bad] : "좋아요";
  $("tile-pose").classList.toggle("bad", !!bad);
  $("m-voice").textContent = s.no_audio ? "마이크 없음" : s.speaking == null ? "준비 중" : s.speaking ? "말하는 중" : "조용함";

  const v = s.voice || {};
  $("m-rate").textContent = s.no_audio ? "-" : `${v.rate_spm ? `분당 ${Math.round(v.rate_spm)}음절` : "측정 중"} · ${v.filler_count || 0}회`;
  $("m-rate").parentElement.classList.toggle("bad", !!v.filler);

  // 영상 위 안내
  $("setup-msg").hidden = s.phase !== "setup";
  if (s.phase === "setup") $("setup-msg").textContent = s.setup.message;
  $("question-banner").hidden = s.phase !== "practice" || !s.question;
  $("question-banner").textContent = s.question || "";
  const cards = (s.cards || []).map((c) => c.label);
  if (cards.join("|") !== lastCards) {
    lastCards = cards.join("|");
    $("cards").innerHTML = "";
    for (const label of cards) {
      const el = document.createElement("div");
      el.className = "card";
      el.textContent = label;
      $("cards").appendChild(el);
    }
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
    box.innerHTML = '<div class="note">카메라 위치가 좋습니다.</div>';
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
  $("r-held").textContent = `${r.cards.reduce((a, c) => a + c.report_only, 0)}회`;

  const chart = $("r-chart");
  chart.innerHTML = "";
  const rows = [
    { name: "turn", label: "고개 돌림" },
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
  if (!r.log.length) tbody.innerHTML = '<tr><td colspan="3" class="empty">알림이 없었습니다</td></tr>';
  for (const row of r.log) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmtTime(row.t)}</td><td></td><td class="${row.outcome === "shown" ? "shown" : ""}">${OUTCOME[row.outcome] || row.outcome}</td>`;
    tr.children[1].textContent = labels[row.name] || row.name;
    tbody.appendChild(tr);
  }

  const notes = $("r-setup");
  notes.innerHTML = "";
  const tips = [];
  if (r.no_audio) tips.push("마이크 없이 연습해서 말을 멈춘 순간을 알 수 없었습니다. 경고는 일정 간격으로만 띄웠습니다.");
  for (const t of tips) {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = t;
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
    setPill($("pill-camera"), "서버 연결 끊김", "warn");
    es.close();
    setTimeout(connect, 1500);
  };
}

loadQuestions();
connect();
