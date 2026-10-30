// 자소서 통째로 묻기 (B: 규칙이 놓친 역량 추가, C: 규칙이 잘못 찾은 역량 빼기) — 2026-10-30
// 문장 하나가 아니라 자소서 전체를 주고, 역량 10개마다 "행동으로 보여 주나?"의 yes 확률을 받는다.
// 예시는 judge.ts의 새로 지은 예시(검증 자료 문장 아님), 기준은 eval/라벨기준.md의 일반 기준만 쓴다.
// 사용법 (webapp 폴더에서):
//   npx vite-node scripts/ollama-whole.ts -- [--model exaone3.5:2.4b] [--limit 3]
// 결과: _work/whole_<모델>.json (질문 하나마다 저장, 다시 실행하면 이어서 함)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
mkdirSync("_work", { recursive: true }); // 결과는 webapp/_work/ (git에 안 올라감)
import { COMPETENCIES } from "../src/prep/competency";
import { CONFUSE, EXAMPLES, EXAMPLES_YES2, NCS_DEF, yesProb, type Msg } from "../src/prep/judge";
import { byContext } from "../src/eval/metrics";

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODEL = opt("--model", "exaone3.5:2.4b");
const LIMIT = Number(opt("--limit", "0"));
const HOST = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, "")}` : "http://127.0.0.1:11434";
const OUT = `_work/whole_${MODEL.replace(/[^\w.-]/g, "_")}${LIMIT ? `_맛보기${LIMIT}` : ""}.json`;
const ds = JSON.parse(readFileSync(new URL("../../data/eval/cases_holdout.json", import.meta.url), "utf8"));
const cases = LIMIT ? ds.cases.slice(0, LIMIT) : ds.cases;

// 라벨 기준 (eval/라벨기준.md + 화면 라벨지의 일반 기준)
const RULE: Record<string, string> = {
  communication: "말이나 글로 상대가 알아듣게 전하거나, 끝까지 듣고 되물어 확인한 행동이 있어야 yes.",
  math: "수를 모으고 나누고 비교하거나 계산한 행동이 있어야 yes. 결과를 숫자로 말한 것만으로는 no.",
  problem: "문제를 알아채고 원인을 찾거나 방법을 바꿔 결과가 나아진 행동이 있어야 yes.",
  self: "스스로 무언가를 배우거나 익힌 내용이 있어야 yes. 습관, 각오, 바람만으로는 no.",
  resource: "시간, 돈, 물건, 사람을 계획해 나누고 아낀 행동이 있어야 yes.",
  interpersonal: "역할 조율, 갈등 해결, 상대를 챙긴 행동이 있어야 yes. 같이 일한 사실만으로는 no.",
  information: "필요한 정보를 찾고 모아 비교하거나 정리해 쓴 행동이 있어야 yes.",
  technology: "도구, 장비, 기술을 이해하고 골라 적용한 행동이 있어야 yes.",
  organization: "정해진 절차, 양식, 보고와 인계 흐름에 맞춰 일한 행동이 있어야 yes. 손님, 매출 같은 말만으로는 no.",
  ethics: "맡은 일을 끝까지 지키거나 절차, 약속, 안전을 지킨 행동이 있어야 yes. '맡았다'만으로는 no.",
};
const name = (id: string) => COMPETENCIES.find((c) => c.id === id)!.name;
const q = (id: string, text: string) => `역량: ${name(id)} (${NCS_DEF[id]})\n기준: ${RULE[id]}\n자기소개서:\n"""\n${text}\n"""\n이 자기소개서 어딘가에 이 역량에 맞는 행동이 실제로 나오나요?`;

export function wholeMessages(id: string, resume: string): Msg[] {
  // 예시도 짧은 자소서 꼴: 맞음 문장 + 관계없는 문장, 아님 = 생각뿐 + 다른 역량의 행동
  const filler = "학교 축제 때 부스를 운영했습니다.";
  const shots: [string, "yes" | "no"][] = [
    [`${filler} ${EXAMPLES[id].yes}`, "yes"],
    [`${EXAMPLES[id].no} ${EXAMPLES[CONFUSE[id]].yes}`, "no"],
    [`${EXAMPLES_YES2[id]} 앞으로도 열심히 하겠습니다.`, "yes"],
  ];
  return [
    { role: "system", content: "자기소개서 전체를 읽고, 주어진 역량을 보여 주는 실제 행동이 한 번이라도 나오면 yes, 없으면 no. 역량 이름만 있거나 생각·바람·각오뿐이거나 다른 역량의 행동뿐이면 no. yes 또는 no 한 단어로만 답하세요." },
    ...shots.flatMap(([s, a]): Msg[] => [{ role: "user", content: q(id, s) }, { role: "assistant", content: a }]),
    { role: "user", content: q(id, resume) },
  ];
}

async function ask(messages: Msg[]) {
  const res = await fetch(`${HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 10 }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const c = (await res.json()).choices?.[0];
  const top = (c?.logprobs?.content?.[0]?.top_logprobs ?? []) as { token: string; logprob: number }[];
  let p = yesProb(top);
  const w = (c?.message?.content ?? "").trim().toLowerCase();
  if (p == null && w) p = /^(yes|예|네)/.test(w) ? 1 : /^(no|아니)/.test(w) ? 0 : null;
  return { p, raw: `${w} | ${top.slice(0, 4).map((t) => `${t.token}:${Math.exp(t.logprob).toFixed(2)}`).join(" ")}` };
}

const ids = COMPETENCIES.map((c) => c.id);
const done: Record<string, { p: number | null; raw: string; ms: number }> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).answers ?? {} : {};
const save = (final = false) =>
  writeFileSync(OUT, JSON.stringify({
    model: MODEL, final, answers: done,
    runs: cases.map((c: any) => ({ caseId: c.id, labels: c.labels, rules: byContext(c.resume), whole: Object.fromEntries(ids.map((id) => [id, done[`${c.id}|${id}`]?.p ?? null])) })),
  }, null, 1));

async function main() {
  const t0 = Date.now();
  const probe = await ask(wholeMessages("self", "카페에서 일했습니다. 손님이 몰리는 시간을 버티려고 매일 퇴근 후 라떼 아트 영상을 보며 따라 연습해 한 달 만에 익혔습니다."));
  console.log(`연결 확인 (${MODEL}, ${((Date.now() - t0) / 1000).toFixed(1)}초): yes 확률 ${probe.p?.toFixed(2) ?? "못 읽음"} [${probe.raw}]`);
  // 역량별로 묶어 보냄 (앞부분 설명·예시를 Ollama가 재사용)
  const todo = ids.flatMap((id) => cases.map((c: any) => ({ id, c }))).filter(({ id, c }) => !(`${c.id}|${id}` in done));
  console.log(`질문 ${ids.length * cases.length}개 중 남은 것 ${todo.length}개`);
  const start = Date.now();
  for (const [i, { id, c }] of todo.entries()) {
    const t = Date.now();
    try {
      done[`${c.id}|${id}`] = { ...(await ask(wholeMessages(id, c.resume))), ms: Date.now() - t };
    } catch (e) {
      console.log(`오류: ${(e as Error).message} → 같은 명령을 다시 실행하면 이어서 합니다`);
      save();
      process.exit(1);
    }
    if (i % 5 === 0 || i === todo.length - 1) {
      save();
      const per = (Date.now() - start) / (i + 1);
      console.log(`${i + 1}/${todo.length}  ${c.id} ${id}  p=${done[`${c.id}|${id}`].p?.toFixed(2) ?? "-"}  (하나에 ${(per / 1000).toFixed(1)}초, 남은 시간 약 ${Math.round((per * (todo.length - i - 1)) / 60000)}분)`);
    }
  }
  save(true);
  console.log(`끝. 결과 파일: webapp/${OUT}`);
}
main();
