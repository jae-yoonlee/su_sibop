// 강제선택 판정 측정 (2026-10-30). 새 자소서 20개(cases_holdout.json)의 문장마다 "가장 잘 드러난 역량 하나 또는 없음"을 PC 안 Ollama 모델에게 묻는다.
// 지금 yes/no 방식과 같은 칸 단위 기준(cells.ts)으로 채점해 나란히 보여 준다.
// 사용법 (webapp 폴더에서, Ollama 실행 중):
//   npx vite-node scripts/ollama-fc.ts -- --model qwen3:1.7b
//   npx vite-node scripts/ollama-fc.ts -- --model exaone3.5:7.8b
//   npx vite-node scripts/ollama-fc.ts -- --score-only        (Ollama 없이, 저장된 결과와 기존 yes/no 결과만 채점)
// 결과: _work/fc_<모델>.json (문장 하나 끝날 때마다 저장, 다시 실행하면 이어서 함), _work/fc_요약.md
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { COMPETENCIES, findCompetencies } from "../src/prep/competency";
import { combined } from "../src/prep/judge";
import { fcMessages, fcProbs, fcScores, judgeFC, type FcSentence } from "../src/prep/judgeFC";
import { bootstrap, cellAuc, count, crossCount, type Cell } from "../src/eval/cells";
import type { Msg } from "../src/prep/judge";

mkdirSync("_work", { recursive: true });
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODEL = opt("--model", "qwen3:1.7b");
const HOST = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, "")}` : "http://127.0.0.1:11434";
const OLD = "../eval/results/2026-10-29_역량판정_일반화";
const fileOf = (m: string) => `_work/fc_${m.replace(/[^\w.-]/g, "_")}.json`;

const ds = JSON.parse(readFileSync("../data/eval/cases_holdout.json", "utf8")) as { cases: { id: string; resume: string; labels: string[] }[] };
const IDS = COMPETENCIES.map((c) => c.id);
const rulesOf = new Map(ds.cases.map((c) => [c.id, findCompetencies(c.resume, true).map((h) => h.id)]));

type Top = { token: string; logprob: number };
const post = async (path: string, body: object) => {
  const res = await fetch(`${HOST}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

async function ask(messages: Msg[]) {
  // Ollama 자체 API: think:false로 qwen3의 생각 단계를 끈다 (안 끄면 첫 토큰이 <think>)
  const d = await post("/api/chat", { model: MODEL, messages, stream: false, think: false, logprobs: true, top_logprobs: 20, options: { temperature: 0, num_predict: 1 } });
  let top = (d.logprobs?.[0]?.top_logprobs ?? []) as Top[];
  let word = (d.message?.content ?? "").trim();
  if (!top.length) {
    // 예전 Ollama: OpenAI 호환 주소에서만 확률을 준다 (ollama-eval.ts와 같은 방식)
    const o = await post("/v1/chat/completions", { model: MODEL, messages, max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 });
    top = (o.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? []) as Top[];
    word = (o.choices?.[0]?.message?.content ?? "").trim();
  }
  return { probs: fcProbs(top.length ? top : [{ token: word, logprob: 0 }]), raw: `${word} | ${top.slice(0, 6).map((t) => `${t.token}:${Math.exp(t.logprob).toFixed(2)}`).join(" ")}` };
}

async function run() {
  const out = fileOf(MODEL);
  const done: Record<string, FcSentence[]> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).cases : {};
  const t0 = Date.now();
  const probe = await ask(fcMessages("매일 저녁 한 시간씩 파이썬 강의를 듣고 연습 문제를 풀었습니다."));
  console.log(`연결 확인 (${MODEL}, ${((Date.now() - t0) / 1000).toFixed(1)}초): ${probe.raw}  ← 자기개발(D)이 높으면 정상`);
  if (!probe.probs) throw new Error("보기 글자(A~J, X)로 답하지 않았어요. 모델 이름을 확인해 주세요.");
  for (const c of ds.cases) {
    if (done[c.id]) continue;
    const s = Date.now();
    done[c.id] = await judgeFC(c.resume, ask);
    writeFileSync(out, JSON.stringify({ model: MODEL, cases: done }, null, 1));
    console.log(`${c.id} 끝 (문장 ${done[c.id].length}개, ${((Date.now() - s) / 1000).toFixed(0)}초)`);
  }
}

// ── 채점 ──
const cell = (caseId: string, id: string, score: number): Cell => {
  const c = ds.cases.find((x) => x.id === caseId)!;
  return { caseId, id, score, gold: c.labels.includes(id), rule: rulesOf.get(caseId)!.includes(id) };
};

function fcCells(file: string): Cell[] {
  const d = JSON.parse(readFileSync(file, "utf8")).cases as Record<string, FcSentence[]>;
  return ds.cases.filter((c) => d[c.id]).flatMap((c) => {
    const best = fcScores(d[c.id]);
    return IDS.map((id) => cell(c.id, id, best.get(id)!.score));
  });
}

/** 기존 yes/no 결과(여진 10/29): 칸 점수 = 그 역량 후보 문장 중 가장 높은 합친 점수, 후보가 없으면 -무한 */
function yesNoCells(file: string): Cell[] {
  const d = JSON.parse(readFileSync(file, "utf8"));
  return d.runs.filter((r: any) => r.set === "시험용").flatMap((r: any) =>
    IDS.map((id) => {
      const vs = r.v2.filter((j: any) => j.id === id).map((j: any) => combined(j)).filter((v: number | null) => v != null) as number[];
      return cell(r.caseId, id, vs.length ? Math.max(...vs) : -Infinity);
    }),
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ci = ([a, b]: [number, number], f = (x: number) => x.toFixed(2)) => `${f(a)}~${f(b)}`;
const style = (cs: Cell[], half: 1 | 2) => cs.filter((c) => (Number(c.caseId.slice(1)) <= 10) === (half === 1));

function rows(name: string, cs: Cell[]) {
  const all = crossCount(cs);
  const r = [`| ${name} | ${all.tp} | ${all.fp} | ${all.fn} | ${pct(all.precision)} | ${pct(all.recall)} | ${pct(all.f1)} (${ci(bootstrap(cs, (s) => crossCount(s).f1), pct)}) | ${cellAuc(cs).toFixed(2)} (${ci(bootstrap(cs, cellAuc))}) | ${cellAuc(style(cs, 1)).toFixed(2)} / ${cellAuc(style(cs, 2)).toFixed(2)} |`];
  return r;
}

function score() {
  const cs0 = ds.cases.flatMap((c) => IDS.map((id) => cell(c.id, id, -Infinity)));
  const rule = count(cs0, Infinity);
  const allYes = count(cs0, -Infinity);
  const lines = [
    `# 역량 판정: 강제선택 vs yes/no (새 자소서 20개, 칸 200개, 정답 54칸)`,
    ``,
    `- 문턱은 자소서를 홀짝으로 나눠 한쪽에서 정하고 다른 쪽에서 잼 (두 번 바꿔 합침). 괄호는 자소서 단위 부트스트랩 95% 구간.`,
    `- 칸 AUC: 칸(자소서×역량)마다 점수 하나(규칙이 찾은 칸은 최고점). 후보에 안 뽑힌 정답 칸도 포함하므로 10/29 보고서의 후보 문장 AUC와 값이 다름.`,
    `- 정밀도 = "있음"이라고 한 것 중 맞은 비율 (10/29 보고서의 "정확도"와 같은 값).`,
    ``,
    `| 방식 | 맞음 | 틀림 | 놓침 | 정밀도 | 재현율 | F1 (95% 구간) | 칸 AUC (95% 구간) | 칸 AUC 자소서체 / 말투 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    `| 규칙만 (지금 앱) | ${rule.tp} | ${rule.fp} | ${rule.fn} | ${pct(rule.precision)} | ${pct(rule.recall)} | ${pct(rule.f1)} (${ci(bootstrap(cs0, (s) => count(s, Infinity).f1), pct)}) | – | – |`,
    `| 전부 "있음" | ${allYes.tp} | ${allYes.fp} | 0 | ${pct(allYes.precision)} | 100% | ${pct(allYes.f1)} | 0.50 | – |`,
  ];
  for (const f of ["결과_qwen_비교.json", "결과_exaone2.4b_문장별.json", "결과_exaone7.8b_문장별.json"]) {
    const p = `${OLD}/${f}`;
    if (!existsSync(p)) continue;
    try {
      lines.push(...rows(`yes/no ${f.replace(/^결과_|\.json$/g, "")}`, yesNoCells(p)));
    } catch {
      /* 형식이 다른 파일은 건너뜀 */
    }
  }
  for (const f of readdirSync("_work").filter((x) => /^fc_.*\.json$/.test(x))) {
    const cs = fcCells(`_work/${f}`);
    if (cs.length === 200) lines.push(...rows(`강제선택 ${f.replace(/^fc_|\.json$/g, "")}`, cs));
    else console.log(`${f}: 아직 ${cs.length / 10}/20개라 표에서 뺌`);
  }
  writeFileSync("_work/fc_요약.md", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

(async () => {
  if (!args.includes("--score-only")) {
    try {
      await run();
    } catch (e) {
      console.log(`멈춤: ${(e as Error).message} → 다시 실행하면 이어서 합니다`);
      process.exit(1);
    }
  }
  score();
})();
