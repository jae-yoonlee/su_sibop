// 검증 페이지: ① 역량 찾기 규칙의 정확도 ② 질문 모델 비교(자동 지표 + 사람 채점지) ③ 채점 결과 합산.
// 팀 내부용. 앱과 같은 프롬프트·검사 함수를 그대로 쓴다.
import "../styles.css";
import "./eval.css";
import type { WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import { createEngine, currentModel, generateQuestions, preloadLlm, yesNoAsker, yesNoAskerFor } from "../prep/llm";
import { judgeIds, type Judgment } from "../prep/judge";
import { COMPETENCIES } from "../prep/competency";
const COMPETENCY_IDS = COMPETENCIES.map((c) => c.id);
import { AI_DEADLINE_SEC } from "../prep/pipeline";
import { findAll, semScores } from "../prep/semantic";
import { embedError } from "../report/embed";
import { esc, MAX_DATASET_BYTES, parseDataset } from "../safe";
import {
  blindSheets, byContext, byWords, caseInput, competencyEval, csv, splitCases, parseCsv, scoreAiAnswer, scoreSheets, summarize,
  type Dataset, type QuestionRun,
} from "./metrics";

// 비교 후보. 크기는 WebLLM 설정의 그래픽 메모리 요구량(16비트 연산 지원 기준).
const MODELS = [
  { base: "Qwen3-0.6B", note: "약 1.4GB, 가장 가벼움" },
  { base: "Qwen3-1.7B", note: "약 2.0GB, 지금 앱 기본값" },
  { base: "Qwen3.5-0.8B", note: "약 1.6GB, 새 세대 소형" },
  { base: "Qwen3.5-2B", note: "약 2.2GB, 지금 기본값의 유력 대체" },
  { base: "Qwen3-4B", note: "약 3.4GB, 품질 상한 확인용" },
  { base: "Qwen3.5-4B", note: "약 3.9GB, 새 세대 중형" },
];

const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "–");
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}초` : "–");
const app = document.querySelector<HTMLDivElement>("#app")!;

const S = {
  ds: null as Dataset | null,
  dsName: "기본 가짜 자료 (data/eval/cases.json)",
  device: { gpu: "확인 중", f16: false, text: "" },
  available: new Set<string>(),
  pick: new Set(["Qwen3-1.7B", "Qwen3.5-2B"]),
  runsPer: 1,
  caseLimit: 20,
  running: false,
  log: [] as string[],
  runs: [] as QuestionRun[],
  loadMs: {} as Record<string, number>,
  errors: {} as Record<string, string>,
  sem: null as null | "running" | { found: Map<string, string[]>; mode: "model" | "fallback"; ms: number }, // 뜻 비교 포함 결과
  judgeModel: "", // 비우면 앱 기본 모델
  judge: null as null | string | { found: Map<string, string[]>; judgments: (Judgment & { caseId: string })[]; model: string; ms: number }, // AI 판정 포함 결과 (문자열 = 진행 상황)
  scored: null as ReturnType<typeof scoreSheets> | null,
  scoreErr: "",
};

function download(name: string, text: string, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const modelId = (base: string) => `${base}-${S.device.f16 ? "q4f16_1" : "q4f32_1"}-MLC`;

// ── 역량 찾기 방식 비교: 단어만 / +문맥 규칙 / +뜻 비교. 규칙을 맞출 때 본 절반과 안 본 절반을 따로 ──
function methodsHtml() {
  const { dev, test } = splitCases(S.ds!.cases);
  const sem = typeof S.sem === "object" && S.sem ? S.sem : null;
  const rows: [string, Parameters<typeof competencyEval>[1], Map<string, string[]> | undefined][] = [
    ["단어 사전만 (예전)", byWords, undefined],
    ["단어 + 문맥 규칙 (지금 앱)", byContext, undefined],
  ];
  const judge = typeof S.judge === "object" && S.judge ? S.judge : null;
  if (judge) rows.push([`단어 + 문맥 + AI 판정 (${judge.model})`, byContext, judge.found]);
  if (sem) rows.push([`단어 + 문맥 + 뜻 비교 (${sem.mode === "model" ? "의미 모델" : "모델 못 받음 → 문맥까지만"})`, byContext, sem.found]);
  const cell = (cs: typeof dev, f: (typeof rows)[0][1], m?: Map<string, string[]>) => {
    const r = competencyEval(cs, f, m);
    return `<td>${pct(r.precision)}</td><td><b>${pct(r.recall)}</b></td>`;
  };
  return `
    <h3>찾는 방식별 비교</h3>
    <p class="muted">문맥 규칙은 1, 3, 5…번째 자소서만 보고 만들었습니다. 그래서 <b>2, 4, 6…번째(안 본 절반)</b> 점수가 실제 실력에 가깝습니다. 두 쪽 차이가 크면 규칙이 본 자료에만 맞춰진 것입니다.</p>
    <table><thead><tr><th>방식</th><th>본 절반 정확도</th><th>본 절반 재현율</th><th>안 본 절반 정확도</th><th>안 본 절반 재현율</th></tr></thead><tbody>
    ${rows.map(([name, f, m]) => `<tr><td>${name}</td>${cell(dev, f, m)}${cell(test, f, m)}</tr>`).join("")}
    </tbody></table>
    ${judge ? `<p class="muted">AI 판정 ${judge.judgments.length}문장, ${sec(judge.ms)} <button class="btn-primary" id="dljudge">AI 판정 원본 JSON</button></p>` : `<label>판정 모델 <select id="judgeModel" ${typeof S.judge === "string" ? "disabled" : ""}><option value="">앱 기본 모델</option>${MODELS.filter((m) => S.available.has(modelId(m.base))).map((m) => `<option value="${m.base}" ${S.judgeModel === m.base ? "selected" : ""}>${m.base} (${m.note.split(",")[0]})</option>`).join("")}</select></label>
      <button class="btn-green" id="judgerun" ${typeof S.judge === "string" ? "disabled" : ""}>${typeof S.judge === "string" ? esc(S.judge) : "애매한 문장 AI 판정까지 측정"}</button> `}
    ${sem ? `<p class="muted">뜻 비교 ${sec(sem.ms)}${sem.mode === "fallback" ? `, 모델 오류: ${esc(embedError || "알 수 없음")}` : ""}</p>` : `<button class="btn-green" id="semrun" ${S.sem === "running" ? "disabled" : ""}>${S.sem === "running" ? "뜻 비교 중… (처음엔 모델 약 150MB 받음)" : "뜻 비교까지 측정"}</button>`}`;
}

async function runSemantic() {
  S.sem = "running";
  render();
  const t0 = performance.now();
  const found = new Map<string, string[]>();
  let mode: "model" | "fallback" = "model";
  for (const c of S.ds!.cases) {
    const r = await findAll(c.resume);
    found.set(c.id, r.ids);
    if (r.mode === "fallback") mode = "fallback";
  }
  S.sem = { found, mode, ms: performance.now() - t0 };
  render();
}

/** 규칙이 약하게만 잡은 문장을 PC 안 AI에게 물어, yes면 그 역량을 찾은 것으로 친다 (앱과 같은 모델, 같은 질문) */
async function runJudge() {
  S.judge = "AI 불러오는 중…";
  render();
  let ask = null;
  let model = "";
  let own: Awaited<ReturnType<typeof createEngine>> | null = null; // 판정용으로 따로 띄운 모델 (끝나면 내림)
  if (S.judgeModel) {
    model = modelId(S.judgeModel);
    const e = await createEngine(model, (r) => {
      S.judge = `${S.judgeModel} 불러오는 중… ${Math.round(r.progress * 100)}%`;
      render();
    }).catch((err) => (alert(`모델을 못 불러왔어요: ${(err as Error).message}`), null));
    own = e;
    ask = e && yesNoAskerFor(e);
  } else {
    ask = (await preloadLlm()) && yesNoAsker();
    model = currentModel();
  }
  if (!ask) {
    S.judge = null;
    alert("이 PC에서는 AI를 쓸 수 없어요 (WebGPU 필요)");
    return render();
  }
  const t0 = performance.now();
  const found = new Map<string, string[]>();
  const judgments: (Judgment & { caseId: string })[] = [];
  for (const [i, c] of S.ds!.cases.entries()) {
    S.judge = `AI 판정 중… ${i + 1}/${S.ds!.cases.length}`;
    render();
    const ids = byContext(c.resume);
    const rest = COMPETENCY_IDS.filter((id) => !ids.includes(id));
    const js = await judgeIds(rest, c.resume, ask, 12, await semScores(c.resume, rest)); // 앱처럼 뜻 비교 후보도 같이
    judgments.push(...js.map((j) => ({ ...j, caseId: c.id })));
    found.set(c.id, [...ids, ...new Set(js.filter((j) => j.yes).map((j) => j.id))]);
  }
  S.judge = { found, judgments, model, ms: performance.now() - t0 };
  await own?.unload();
  render();
}

// ── 화면 ─────────────────────────────────────────────

function render() {
  const ds = S.ds;
  const comp = ds ? competencyEval(ds.cases) : null;
  const sum = summarize(S.runs, AI_DEADLINE_SEC * 1000);
  app.innerHTML = `
  <div class="page"><div class="wrap ev">
    <div class="nav"><div class="brand">면접 코치 <b>검증</b></div><a class="link" href="./">앱으로</a></div>
    <h1 class="display-md">모델과 규칙 검증</h1>
    <p class="lead">팀 내부용입니다. 가짜 자소서로 ① 역량 찾기 규칙 ② 질문 모델을 측정하고, 결과를 표 파일로 내려받습니다.</p>

    <section class="card-dark">
      <h2>이 PC</h2>
      <p>${esc(S.device.text)}</p>
      <p class="muted">자료: ${esc(S.dsName)}, 자소서 ${ds?.cases.length ?? 0}개, 채용공고 ${ds?.postings.length ?? 0}개
        <label class="filebtn">다른 자료 불러오기<input type="file" id="dsfile" accept=".json" hidden /></label></p>
    </section>

    <section class="card-dark">
      <h2>① 역량 찾기 규칙 (AI 없음, 바로 계산)</h2>
      ${comp ? `
      <p>자소서에서 찾은 역량이 정답 라벨과 얼마나 맞는지: <b>정확도(찾은 것 중 맞은 비율) ${pct(comp.precision)}</b>, <b>재현율(있어야 할 것 중 찾은 비율) ${pct(comp.recall)}</b></p>
      <p class="muted">정답 라벨은 자료를 만든 사람이 붙인 1차 값입니다. 다른 사람이 따로 라벨을 붙여 비교하기 전까지는 참고용입니다.</p>
      <table><thead><tr><th>역량</th><th>맞음</th><th>잘못 찾음</th><th>놓침</th><th>정확도</th><th>재현율</th></tr></thead><tbody>
      ${comp.scores.map((s) => `<tr><td>${s.name}</td><td>${s.tp}</td><td>${s.fp}</td><td>${s.fn}</td><td>${pct(s.precision)}</td><td>${pct(s.recall)}</td></tr>`).join("")}
      </tbody></table>
      <details><summary>자소서별로 놓친 것과 잘못 찾은 것</summary>
      <table><tbody>${comp.rows.filter((r) => r.missed.length || r.extra.length).map((r) => `<tr><td>${esc(r.id)}</td><td>놓침: ${esc(r.missed.join(", ") || "-")}</td><td>잘못 찾음: ${esc(r.extra.join(", ") || "-")}</td></tr>`).join("")}</tbody></table>
      </details>
      <button class="btn-primary" id="dlcomp">역량 결과 CSV</button>
      ${methodsHtml()}` : "<p>자료를 불러오는 중…</p>"}
    </section>

    <section class="card-dark">
      <h2>② 질문 모델 비교</h2>
      <p class="muted">모델마다 처음 한 번은 내려받기 때문에 오래 걸립니다 (와이파이 권장). 측정 중에는 이 탭을 앞에 두고 다른 무거운 프로그램을 끄세요. 규칙 질문은 항상 같이 만들어 기준선으로 씁니다.</p>
      <div class="models">
        ${MODELS.map((m) => {
          const ok = S.device.gpu === "ok" && S.available.has(modelId(m.base));
          return `<label class="model ${ok ? "" : "off"}"><input type="checkbox" data-m="${m.base}" ${S.pick.has(m.base) && ok ? "checked" : ""} ${ok && !S.running ? "" : "disabled"} />
            <b>${m.base}</b><span>${m.note}${ok ? "" : ", 이 PC에선 불가"}</span></label>`;
        }).join("")}
      </div>
      <div class="opts">
        <label>자소서 <select id="nCase" ${S.running ? "disabled" : ""}>${[5, 10, 20].map((n) => `<option ${n === S.caseLimit ? "selected" : ""}>${n}</option>`).join("")}</select>개</label>
        <label>자소서마다 <select id="nRun" ${S.running ? "disabled" : ""}>${[1, 2, 3].map((n) => `<option ${n === S.runsPer ? "selected" : ""}>${n}</option>`).join("")}</select>번 (같은 입력에도 답이 달라지는지)</label>
        <button class="btn-green" id="start" ${S.running || !ds ? "disabled" : ""}>측정 시작</button>
      </div>
      ${S.device.gpu !== "ok" && S.device.gpu !== "확인 중" ? `<p class="warn">이 브라우저에서는 그래픽 가속(WebGPU)을 쓸 수 없어 AI 측정이 안 됩니다 (규칙 질문만 만들어집니다). 최신 Chrome이나 Edge로 열어 주세요.</p>` : ""}
      ${S.log.length ? `<pre class="log">${esc(S.log.slice(-12).join("\n"))}</pre>` : ""}
      ${sum.length ? `
      <table><thead><tr><th>모델</th><th>실행</th><th>불러오기</th><th>JSON 성공</th><th>AI 질문 채택</th><th>근거 반영</th><th>생성 시간(중간값)</th><th>최대</th><th>${AI_DEADLINE_SEC}초 안</th></tr></thead><tbody>
      ${sum.map((r) => `<tr><td>${esc(r.model)}</td><td>${r.runs}</td><td>${r.model === "규칙" ? "-" : sec(S.loadMs[r.model])}</td><td>${r.model === "규칙" ? "-" : pct(r.jsonRate)}</td><td>${r.model === "규칙" ? "-" : pct(r.aiRate)}</td><td>${r.model === "규칙" ? "-" : pct(r.evidenceRate)}</td><td>${sec(r.medianMs)}</td><td>${sec(r.maxMs)}</td><td>${pct(r.inDeadline)}</td></tr>`).join("")}
      ${Object.entries(S.errors).map(([m, e]) => `<tr><td>${esc(m)}</td><td colspan="8" class="warn">실패: ${esc(e)}</td></tr>`).join("")}
      </tbody></table>
      <p class="muted">AI 질문 채택 = 질문 3개 중 형식 검사를 통과해 앱에서 실제로 쓰였을 비율 (나머지는 규칙 질문). 근거 반영 = 규칙이 골라 준 자소서 문장의 내용을 AI 질문이 실제로 쓴 비율.</p>
      <div class="btns">
        <button class="btn-primary" id="dlsum">요약 CSV</button>
        <button class="btn-primary" id="dlsheet">사람 채점지 CSV (모델 숨김)</button>
        <button class="btn-primary" id="dlkey">채점 정답 키 CSV</button>
        <button class="btn-primary" id="dlraw">전체 원본 JSON</button>
      </div>` : ""}
    </section>

    <section class="card-dark">
      <h2>③ 사람 채점 합산</h2>
      <p class="muted">채점지 점수 칸을 1~5로 채워 엑셀에서 <b>CSV UTF-8</b>로 저장한 뒤, 정답 키와 함께 넣으세요.</p>
      <div class="opts">
        <label class="filebtn">채점한 파일<input type="file" id="fsheet" accept=".csv" hidden /></label>
        <label class="filebtn">정답 키<input type="file" id="fkey" accept=".csv" hidden /></label>
      </div>
      ${S.scoreErr ? `<p class="warn">${esc(S.scoreErr)}</p>` : ""}
      ${S.scored ? `<table><thead><tr><th>모델</th><th>채점한 질문</th><th>구체성</th><th>자소서 연결</th><th>자연스러움</th></tr></thead><tbody>
        ${S.scored.result.map((r) => `<tr><td>${esc(r.model)}</td><td>${r.scored}</td>${r.means.map((m) => `<td>${Number.isFinite(m) ? m.toFixed(2) : "–"}</td>`).join("")}</tr>`).join("")}
      </tbody></table>${S.scored.unknown ? `<p class="warn">정답 키에 없는 코드 ${S.scored.unknown}개는 뺐습니다.</p>` : ""}` : ""}
    </section>
  </div></div>`;
  bind();
}

const files: { sheet?: string; key?: string } = {}; // 채점 합산용 두 파일 (화면을 다시 그려도 유지)

function bind() {
  const $ = (id: string) => document.getElementById(id);
  $("dsfile")?.addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      if (f.size > MAX_DATASET_BYTES) throw new Error("파일이 너무 커요 (20MB 이하)");
      const d = parseDataset(await f.text());
      S.ds = d;
      S.sem = null;
      S.dsName = f.name;
    } catch (err) {
      alert(`자료를 읽지 못했어요: ${(err as Error).message}`);
    }
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[data-m]").forEach((el) =>
    el.addEventListener("change", () => (el.checked ? S.pick.add(el.dataset.m!) : S.pick.delete(el.dataset.m!))),
  );
  $("nCase")?.addEventListener("change", (e) => (S.caseLimit = Number((e.target as HTMLSelectElement).value)));
  $("nRun")?.addEventListener("change", (e) => (S.runsPer = Number((e.target as HTMLSelectElement).value)));
  $("start")?.addEventListener("click", () => void runAll());
  $("semrun")?.addEventListener("click", () => void runSemantic());
  $("judgerun")?.addEventListener("click", () => void runJudge());
  $("judgeModel")?.addEventListener("change", (e) => (S.judgeModel = (e.target as HTMLSelectElement).value));
  $("dljudge")?.addEventListener("click", () => {
    const j = S.judge as Exclude<typeof S.judge, string | null>;
    const label = new Map(S.ds!.cases.map((c) => [c.id, c.labels]));
    download(`AI판정_${stamp()}.json`, JSON.stringify({ model: j.model, ms: Math.round(j.ms), judgments: j.judgments.map((x) => ({ ...x, gold: label.get(x.caseId)?.includes(x.id) ?? null })) }, null, 2), "application/json");
  });

  $("dlcomp")?.addEventListener("click", () => {
    const c = competencyEval(S.ds!.cases);
    download(`역량찾기_${stamp()}.csv`, csv([
      ["역량", "맞음", "잘못 찾음", "놓침", "정확도", "재현율"],
      ...c.scores.map((s) => [s.name, s.tp, s.fp, s.fn, pct(s.precision), pct(s.recall)]),
      ["전체", "", "", "", pct(c.precision), pct(c.recall)],
    ]));
  });
  $("dlsum")?.addEventListener("click", () => {
    const head = ["모델", "실행 수", "불러오기(초)", "JSON 성공", "AI 질문 채택", "근거 반영", "생성 중간값(초)", "최대(초)", `${AI_DEADLINE_SEC}초 안`, "PC"];
    download(`질문모델_요약_${stamp()}.csv`, csv([head, ...summarize(S.runs, AI_DEADLINE_SEC * 1000).map((r) => [
      r.model, r.runs, r.model === "규칙" ? "" : ((S.loadMs[r.model] ?? NaN) / 1000).toFixed(1), pct(r.jsonRate), pct(r.aiRate), pct(r.evidenceRate),
      (r.medianMs / 1000).toFixed(1), (r.maxMs / 1000).toFixed(1), pct(r.inDeadline), S.device.text,
    ])]));
  });
  $("dlsheet")?.addEventListener("click", () => download(`채점지_${stamp()}.csv`, csv(blindSheets(S.runs, S.ds!).sheet)));
  $("dlkey")?.addEventListener("click", () => download(`채점정답키_${stamp()}.csv`, csv(blindSheets(S.runs, S.ds!).key)));
  $("dlraw")?.addEventListener("click", () =>
    download(`질문모델_원본_${stamp()}.json`, JSON.stringify({ device: S.device, loadMs: S.loadMs, errors: S.errors, runs: S.runs }, null, 2), "application/json"));

  const onFile = (k: "sheet" | "key") => async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const text = await f.text();
    if (text.includes("�")) {
      S.scoreErr = "글자가 깨졌어요. 엑셀에서 '다른 이름으로 저장 → CSV UTF-8'로 다시 저장해 주세요.";
      return render();
    }
    files[k] = text;
    S.scoreErr = "";
    if (files.sheet && files.key) {
      try {
        S.scored = scoreSheets(parseCsv(files.sheet), parseCsv(files.key));
      } catch (err) {
        S.scoreErr = (err as Error).message;
      }
    }
    render();
  };
  $("fsheet")?.addEventListener("change", onFile("sheet"));
  $("fkey")?.addEventListener("change", onFile("key"));
}

// ── 측정 ─────────────────────────────────────────────

const say = (t: string) => {
  S.log.push(t);
  render();
};

async function runAll() {
  const ds = S.ds!;
  const cases = ds.cases.slice(0, S.caseLimit);
  S.running = true;
  S.runs = S.runs.filter((r) => r.model !== "규칙");
  for (const c of cases) {
    const { fallback } = caseInput(ds, c);
    S.runs.push({ caseId: c.id, model: "규칙", run: 1, ms: 0, jsonOk: true, aiCount: 0, evidenceGiven: 0, evidenceExact: 0, questions: fallback, raw: "" });
  }
  for (const base of MODELS.map((m) => m.base).filter((b) => S.pick.has(b) && S.device.gpu === "ok" && S.available.has(modelId(b)))) {
    const id = modelId(base);
    S.runs = S.runs.filter((r) => r.model !== id);
    delete S.errors[id];
    let engine: WebWorkerMLCEngine | null = null;
    const t0 = performance.now();
    try {
      say(`${id} 불러오는 중…`);
      let last = 0;
      engine = await createEngine(id, (r) => {
        if (performance.now() - last > 1500) {
          last = performance.now();
          S.log[S.log.length - 1] = `${id} 불러오는 중… ${Math.round(r.progress * 100)}%`;
          render();
        }
      });
      S.loadMs[id] = performance.now() - t0;
      say(`${id} 준비 (${sec(S.loadMs[id])})`);
      for (const c of cases) {
        const { coverage, fallback } = caseInput(ds, c);
        for (let run = 1; run <= S.runsPer; run++) {
          const t = performance.now();
          let raw = "";
          try {
            raw = await generateQuestions(engine, c.resume, coverage);
          } catch (e) {
            raw = `ERROR: ${(e as Error).message}`;
          }
          const ms = performance.now() - t;
          const sc = scoreAiAnswer(raw, c.resume, fallback);
          S.runs.push({ caseId: c.id, model: id, run, ms, raw, ...sc });
          say(`${id}, ${c.id} #${run}: ${sec(ms)}, AI 질문 ${sc.aiCount}/3`);
        }
      }
    } catch (e) {
      S.errors[id] = (e as Error).message;
      say(`${id} 실패: ${(e as Error).message}`);
    } finally {
      await engine?.unload().catch(() => undefined); // 다음 모델을 위해 그래픽 메모리 비우기
    }
  }
  S.running = false;
  say("끝. 아래 버튼으로 결과를 내려받으세요.");
}

// ── 시작 ─────────────────────────────────────────────

async function init() {
  render();
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<{ features: Set<string>; info?: { vendor?: string; architecture?: string; description?: string } } | null> };
    deviceMemory?: number;
  };
  const adapter = nav.gpu ? await nav.gpu.requestAdapter().catch(() => null) : null;
  S.device.gpu = adapter ? "ok" : "없음";
  S.device.f16 = !!adapter?.features.has("shader-f16");
  const info = adapter?.info;
  S.device.text = [
    adapter ? `그래픽: ${[info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") || "확인 불가"}${S.device.f16 ? " (16비트 지원)" : " (16비트 미지원 → 32비트 모델)"}` : "그래픽 가속(WebGPU) 없음",
    `CPU 스레드 ${navigator.hardwareConcurrency ?? "?"}`,
    nav.deviceMemory ? `메모리 약 ${nav.deviceMemory}GB 이상` : "",
    navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "",
  ].filter(Boolean).join(", ");
  try {
    const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
    S.available = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
  } catch {
    /* 목록을 못 받으면 모두 비활성 */
  }
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}eval/cases.json`);
    S.ds = (await r.json()) as Dataset;
  } catch {
    S.dsName = "기본 자료를 못 불러왔어요. '다른 자료 불러오기'로 넣어 주세요.";
  }
  render();
}
void init();
