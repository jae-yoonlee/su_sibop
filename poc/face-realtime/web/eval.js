// 평가용 지시 화면: 지시를 순서대로 보여 주고, 바뀔 때마다 서버에 알린다(eval_mark).
// 시각은 서버가 찍는다. 녹화·분석·채점도 전부 서버(Python)가 한다.
const $ = (id) => document.getElementById(id);
const syllables = (text) => (text.match(/[가-힣]/g) || []).length;  // 한글 한 글자 = 한 음절

const DOTS = { center: [50, 50], left: [4, 50], right: [96, 50], up: [50, 6], down: [50, 94] };  // 화면 % 위치
const ROUNDS = 3;        // 1바퀴째는 사람별 기준 잡기, 나머지로 채점
const GAZE_SEC = 3;
const PACES = ["느리게", "보통으로", "빠르게"];
const TEXTS = [
  "저는 대학에서 컴퓨터 공학을 전공했고, 졸업 작품으로 실시간 면접 연습 도구를 만들었습니다. 그 과정에서 문제를 작게 나누어 해결하는 습관을 길렀습니다.",
  "팀에서 의견이 갈렸을 때는 먼저 서로의 근거를 끝까지 듣고, 작은 실험으로 확인한 뒤에 결정했습니다. 덕분에 일정 안에 결과물을 낼 수 있었습니다.",
];
const SENTENCES = [
  "저는 맡은 일을 끝까지 책임지는 사람입니다.",
  "지난 학기에는 팀 프로젝트의 조장을 맡았습니다.",
  "처음에는 일정이 계속 밀려서 어려웠습니다.",
  "그래서 매일 아침 짧은 회의를 열었습니다.",
  "각자 할 일을 작게 나누어 정리했습니다.",
  "그 결과 마감 사흘 전에 개발을 끝냈습니다.",
  "발표에서는 가장 높은 점수를 받았습니다.",
  "이 경험으로 소통의 중요성을 배웠습니다.",
];

// 지시 하나: { name, note, msg, sub, dot, sec, space }. name이 있는 지시만 정답(truth.csv)으로 남는다.
const TASKS = {
  gaze() {
    const steps = [{ msg: "고개는 그대로 두고, 눈으로만 빨간 점을 따라가세요", sec: 4 }];
    for (let r = 1; r <= ROUNDS; r++)
      for (const d of ["left", "right", "up", "down"])
        for (const dot of ["center", d]) steps.push({ name: `gaze_${dot}`, note: `round=${r}`, dot, sec: GAZE_SEC });
    return steps;
  },
  rate() {
    const steps = [];
    for (const pace of PACES)
      for (const text of TEXTS) {
        steps.push({ msg: `준비: 다음 글을 ${pace} 읽습니다`, sub: text, sec: 4 });
        steps.push({ name: "read", note: `pace=${pace};syll=${syllables(text)}`, space: true, sec: 90,
                     msg: `${pace} 소리 내어 읽으세요. 끝나면 바로 스페이스`, sub: text });
      }
    return steps;
  },
  filler() {
    const steps = [{ msg: "문장은 평소처럼 읽고, 큰 글자가 나오면 그 소리를 1초쯤 길게 내세요", sec: 5 }];
    SENTENCES.forEach((s, i) => {
      steps.push({ name: "read", msg: "읽으세요", sub: s, sec: 6 });
      steps.push({ name: "filler", note: `sound=${i % 2 ? "어" : "음"}`, msg: i % 2 ? "어———" : "음———",
                   sub: "지금 1초쯤 길게 소리 내세요", sec: 3 });
    });
    return steps;
  },
};

let finishStep = null;   // 지금 지시를 끝내는 함수
let spaceEnds = false;
let aborted = false;

async function command(action, extra = {}) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const out = await res.json();
  $("error").hidden = out.ok;
  $("error").textContent = out.ok ? "" : out.error;
  return out;
}

function show(step) {
  $("msg").textContent = step.msg || "";
  $("sub").textContent = step.sub || "";
  $("dot").hidden = !step.dot;
  if (step.dot) [$("dot").style.left, $("dot").style.top] = DOTS[step.dot].map((p) => `${p}%`);
  const bar = $("bar");
  bar.style.transition = "none";
  bar.style.width = "0";
  bar.offsetWidth;  // 다시 그리게 해서 애니메이션을 처음부터
  bar.style.transition = `width ${step.sec}s linear`;
  bar.style.width = "100%";
}

function wait(step) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, step.sec * 1000);
    spaceEnds = !!step.space;
    finishStep = () => { clearTimeout(timer); resolve(); };
  });
}

async function run(task) {
  const started = await command("eval_start", { task });
  if (!started.ok) return;
  aborted = false;
  $("report").hidden = true;
  $("menu").hidden = true;
  $("stage").hidden = false;
  try { await document.documentElement.requestFullscreen(); } catch { /* 전체 화면을 못 써도 진행 */ }
  for (const step of TASKS[task]()) {
    if (aborted) break;
    show(step);
    command("eval_mark", { name: step.name || "", note: step.note || "" });
    await wait(step);
  }
  finishStep = null;
  const out = await command("eval_stop");
  if (document.fullscreenElement) document.exitFullscreen();
  $("stage").hidden = true;
  $("menu").hidden = false;
  if (out.ok) {
    $("report").hidden = false;
    const warn = started.no_audio && task !== "gaze" ? "마이크가 없어 소리가 녹음되지 않았습니다.\n\n" : "";
    $("report").textContent = `${warn}저장한 곳: ${out.dir}\n\n${out.report}`;
  }
}

document.addEventListener("keydown", (e) => {
  if (!finishStep) return;
  if (e.key === "Escape") { aborted = true; finishStep(); }
  if (e.key === " " && spaceEnds) { e.preventDefault(); finishStep(); }
});
// 전체 화면에서는 Esc가 키 입력으로 오지 않고 전체 화면만 풀린다
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && finishStep) { aborted = true; finishStep(); }
});
document.querySelectorAll(".tasks button").forEach((b) => (b.onclick = () => run(b.dataset.task)));
