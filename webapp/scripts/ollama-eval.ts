// PC 안 Ollama 모델로 역량 판정 측정 (2026-10-30)
// 검증 페이지 "예전 vs 새 방식 비교"(Qwen3-1.7B) JSON의 같은 후보 문장을 Ollama 모델에게 그대로 묻는다 → 모델만 바뀐 공정 비교.
// 사용법 (webapp 폴더에서):
//   npx vite-node scripts/ollama-eval.ts -- <검증 페이지에서 받은 비교 JSON> [--model exaone3.5:2.4b] [--limit 3] [--sets 시험용,조정용]
// 결과: _work/ollama_<모델>.json (질문 하나 끝날 때마다 저장, 다시 실행하면 이어서 함)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
mkdirSync("_work", { recursive: true }); // 결과는 webapp/_work/ (git에 안 올라감)
import { judgeMessagesV2, logit, yesProb, type Msg } from "../src/prep/judge";

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const src = args.find((a) => a.endsWith(".json"));
if (!src) {
  console.log("검증 페이지에서 받은 비교 JSON 경로를 넣어 주세요. 예: npx vite-node scripts/ollama-eval.ts -- /mnt/c/Users/yjgim/Downloads/AI판정비교_2026-10-30-01-56.json");
  process.exit(1);
}
const MODEL = opt("--model", "exaone3.5:2.4b");
const LIMIT = Number(opt("--limit", "0")); // 0 = 전부
const SETS = opt("--sets", "시험용,조정용").split(",");
const HOST = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, "")}` : "http://127.0.0.1:11434";
const OUT = `_work/ollama_${MODEL.replace(/[^\w.-]/g, "_")}${LIMIT ? `_맛보기${LIMIT}` : ""}.json`;

type J = { id: string; sentence: string; cues: string[]; weak: number; sem: number | null };
const base = JSON.parse(readFileSync(src, "utf8"));
const runs: any[] = SETS.flatMap((s) => {
  const rs = base.runs.filter((r: any) => r.set === s);
  return LIMIT ? rs.slice(0, LIMIT) : rs;
});

// 저장된 답 (이어하기)
const key = (set: string, caseId: string, j: J) => `${set}|${caseId}|${j.id}|${j.sentence}`;
const done: Record<string, { p: number | null; raw: string; ms: number }> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).answers ?? {} : {};

async function ask(messages: Msg[]): Promise<{ p: number | null; raw: string }> {
  const res = await fetch(`${HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 10 }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  const c = d.choices?.[0];
  const top = (c?.logprobs?.content?.[0]?.top_logprobs ?? []) as { token: string; logprob: number }[];
  let p = yesProb(top);
  const word = (c?.message?.content ?? "").trim().toLowerCase();
  if (p == null && word) p = /^(yes|예|네)/.test(word) ? 1 : /^(no|아니)/.test(word) ? 0 : null; // 확률을 못 받으면 답만
  return { p, raw: `${word} | ${top.map((t) => `${t.token}:${Math.exp(t.logprob).toFixed(2)}`).join(" ")}` };
}

function save(final = false) {
  const outRuns = runs.map((r) => ({
    ...r,
    v2: r.v2.map((j: J) => {
      const a = done[key(r.set, r.caseId, j)];
      return { ...j, p: a?.p ?? null, pcf: 0.5, z: a?.p == null ? null : logit(a.p), ms: a?.ms ?? 0 };
    }),
  }));
  writeFileSync(OUT, JSON.stringify({ model: MODEL, source: src, final, answers: done, runs: outRuns }, null, 1));
}

async function main() {
  // 0) 연결과 확률 확인
  const t0 = Date.now();
  const probe = await ask(judgeMessagesV2("self", "매일 저녁 한 시간씩 파이썬 강의를 듣고 연습 문제를 풀었습니다."));
  console.log(`연결 확인 (${MODEL}, ${((Date.now() - t0) / 1000).toFixed(1)}초): yes 확률 ${probe.p == null ? "못 읽음" : probe.p.toFixed(2)}  [${probe.raw}]`);
  if (!probe.raw.includes(":")) console.log("※ 확률(logprobs)이 안 와서 yes/no 답만 씁니다. AUC는 거칠게 나옵니다.");

  // 1) 할 일: 역량별로 묶어서 (앞부분 설명·예시를 Ollama가 재사용해 빨라짐), 시험용 먼저
  const todo = runs.flatMap((r) => r.v2.map((j: J) => ({ r, j }))).filter(({ r, j }) => !(key(r.set, r.caseId, j) in done));
  const order = (s: string) => SETS.indexOf(s);
  todo.sort((a, b) => order(a.r.set) - order(b.r.set) || a.j.id.localeCompare(b.j.id));
  const total = runs.reduce((n, r) => n + r.v2.length, 0);
  console.log(`질문 ${total}개 중 남은 것 ${todo.length}개`);

  const start = Date.now();
  for (const [i, { r, j }] of todo.entries()) {
    const t = Date.now();
    let a: { p: number | null; raw: string };
    try {
      a = await ask(judgeMessagesV2(j.id, j.sentence));
    } catch (e) {
      console.log(`오류: ${(e as Error).message} → 잠시 뒤 다시 실행하면 이어서 합니다`);
      save();
      process.exit(1);
    }
    done[key(r.set, r.caseId, j)] = { ...a, ms: Date.now() - t };
    if (i % 5 === 0 || i === todo.length - 1) {
      save();
      const per = (Date.now() - start) / (i + 1);
      const left = Math.round((per * (todo.length - i - 1)) / 60000);
      console.log(`${i + 1}/${todo.length}  ${r.set} ${r.caseId} ${j.id}  p=${a.p == null ? "-" : a.p.toFixed(2)}  (하나에 ${(per / 1000).toFixed(1)}초, 남은 시간 약 ${left}분)`);
    }
  }
  save(true);
  console.log(`끝. 결과 파일: webapp/${OUT}`);
}
main();
