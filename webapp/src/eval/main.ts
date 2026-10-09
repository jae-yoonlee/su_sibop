// 검증 페이지: ① 역량 찾기 규칙의 정확도 ② 질문 모델 비교(자동 지표 + 사람 채점지) ③ 채점 결과 합산.
// 팀 내부용. 앱과 같은 프롬프트·검사 함수를 그대로 쓴다.
import "../styles.css";
import "./eval.css";
import type { WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import { createEngine, generateQuestions } from "../prep/llm";
import { AI_DEADLINE_SEC } from "../prep/pipeline";
import {
  blindSheets, caseInput, competencyEval, csv, parseCsv, scoreAiAnswer, scoreSheets, summarize,
  type Dataset, type QuestionRun,
} from "./metrics";

// 비교 후보. 크기는 WebLLM 설정의 그래픽 메모리 요구량(16비트 연산 지원 기준).
const MODELS = [
  { base: "Qwen3-0.6B", note: "약 1.4GB · 가장 가벼움" },
  { base: "Qwen3-1.7B", note: "약 2.0GB · 지금 앱 기본값" },
  { base: "Qwen3.5-0.8B", note: "약 1.6GB · 새 세대 소형" },
  { base: "Qwen3.5-2B", note: "약 2.2GB · 지금 기본값의 유력 대체" },
  { base: "Qwen3-4B", note: "약 3.4GB · 품질 상한 확인용" },
];

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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

// ── 화면 ─────────────────────────────────────────────

function render() {
  const ds = S.ds;
  const comp = ds ? competencyEval(ds.cases) : null;
  const sum = summarize(S.runs, AI_DEADLINE_SEC * 1000);
  app.innerHTML = `
  <div class="page"><div class="wrap ev">
    <div class="nav"><div class="brand">면접 코치 <b>검증</b></div><a class="link" href="./">앱으로</a></div>
    <h1 class="display-md">모델·규칙 검증</h1>
    <p class="lead">팀 내부용입니다. 가짜 자소서로 ① 역량 찾기 규칙 ② 질문 모델을 측정하고, 결과를 표 파일로 내려받습니다.</p>

    <section class="card-dark">
      <h2>이 PC</h2>
      <p>${esc(S.device.text)}</p>
      <p class="muted">자료: ${esc(S.dsName)} · 자소서 ${ds?.cases.length ?? 0}개, 채용공고 ${ds?.postings.length ?? 0}개
        <label class="filebtn">다른 자료 불러오기<input type="file" id="dsfile" accept=".json" hidden /></label></p>
    </section>

    <section class="card-dark">
      <h2>① 역량 찾기 규칙 (AI 없음, 바로 계산)</h2>
      ${comp ? `
      <p>자소서에서 찾은 역량이 정답 라벨과 얼마나 맞는지: <b>정확도(찾은 것 중 맞은 비율) ${pct(comp.precision)}</b> · <b>재현율(있어야 할 것 중 찾은 비율) ${pct(comp.recall)}</b></p>
      <p class="muted">정답 라벨은 자료를 만든 사람이 붙인 1차 값입니다. 다른 사람이 따로 라벨을 붙여 비교하기 전까지는 참고용입니다.</p>
      <table><thead><tr><th>역량</th><th>맞음</th><th>잘못 찾음</th><th>놓침</th><th>정확도</th><th>재현율</th></tr></thead><tbody>
      ${comp.scores.map((s) => `<tr><td>${s.name}</td><td>${s.tp}</td><td>${s.fp}</td><td>${s.fn}</td><td>${pct(s.precision)}</td><td>${pct(s.recall)}</td></tr>`).join("")}
      </tbody></table>
      <details><summary>자소서별로 놓친 것·잘못 찾은 것</summary>
      <table><tbody>${comp.rows.filter((r) => r.missed.length || r.extra.length).map((r) => `<tr><td>${r.id}</td><td>놓침: ${r.missed.join(", ") || "-"}</td><td>잘못 찾음: ${r.extra.join(", ") || "-"}</td></tr>`).join("")}</tbody></table>
      </details>
      <button class="btn-primary" id="dlcomp">역량 결과 CSV</button>` : "<p>자료를 불러오는 중…</p>"}
    </section>

    <section class="card-dark">
      <h2>② 질문 모델 비교</h2>
      <p class="muted">모델마다 처음 한 번은 내려받기 때문에 오래 걸립니다 (와이파이 권장). 측정 중에는 이 탭을 앞에 두고 다른 무거운 프로그램을 끄세요. 규칙 질문은 항상 같이 만들어 기준선으로 씁니다.</p>
      <div class="models">
        ${MODELS.map((m) => {
          const ok = S.device.gpu === "ok" && S.available.has(modelId(m.base));
          return `<label class="model ${ok ? "" : "off"}"><input type="checkbox" data-m="${m.base}" ${S.pick.has(m.base) && ok ? "checked" : ""} ${ok && !S.running ? "" : "disabled"} />
            <b>${m.base}</b><span>${m.note}${ok ? "" : " · 이 PC에선 불가"}</span></label>`;
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
      <table><thead><tr><th>모델</th><th>실행</th><th>불러오기</th><th>JSON 성공</th><th>AI 질문 채택</th><th>근거 문장 정확 복사</th><th>생성 시간(중간값)</th><th>최대</th><th>${AI_DEADLINE_SEC}초 안</th></tr></thead><tbody>
      ${sum.map((r) => `<tr><td>${esc(r.model)}</td><td>${r.runs}</td><td>${r.model === "규칙" ? "-" : sec(S.loadMs[r.model])}</td><td>${r.model === "규칙" ? "-" : pct(r.jsonRate)}</td><td>${r.model === "규칙" ? "-" : pct(r.aiRate)}</td><td>${r.model === "규칙" ? "-" : pct(r.evidenceRate)}</td><td>${sec(r.medianMs)}</td><td>${sec(r.maxMs)}</td><td>${pct(r.inDeadline)}</td></tr>`).join("")}
      ${Object.entries(S.errors).map(([m, e]) => `<tr><td>${esc(m)}</td><td colspan="8" class="warn">실패: ${esc(e)}</td></tr>`).join("")}
      </tbody></table>
      <p class="muted">AI 질문 채택 = 질문 3개 중 형식·근거 검사를 통과해 앱에서 실제로 쓰였을 비율. 나머지는 규칙 질문으로 대체됩니다.</p>
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
      const d = JSON.parse(await f.text()) as Dataset;
      if (!Array.isArray(d.cases) || !Array.isArray(d.postings)) throw new Error("cases·postings 목록이 없어요");
      S.ds = d;
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

  $("dlcomp")?.addEventListener("click", () => {
    const c = competencyEval(S.ds!.cases);
    download(`역량찾기_${stamp()}.csv`, csv([
      ["역량", "맞음", "잘못 찾음", "놓침", "정확도", "재현율"],
      ...c.scores.map((s) => [s.name, s.tp, s.fp, s.fn, pct(s.precision), pct(s.recall)]),
      ["전체", "", "", "", pct(c.precision), pct(c.recall)],
    ]));
  });
  $("dlsum")?.addEventListener("click", () => {
    const head = ["모델", "실행 수", "불러오기(초)", "JSON 성공", "AI 질문 채택", "근거 정확 복사", "생성 중간값(초)", "최대(초)", `${AI_DEADLINE_SEC}초 안`, "PC"];
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
          say(`${id} · ${c.id} #${run}: ${sec(ms)}, AI 질문 ${sc.aiCount}/3`);
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
  ].filter(Boolean).join(" · ");
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
