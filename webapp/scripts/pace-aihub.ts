// 실제 면접 답변(AI Hub 129 채용면접, 원천 wav 일부)으로 앱의 빠른 말 경고를 그대로 흉내 낸다. 데이터는 저장소에 넣지 않는다.
// 준비: 답변 wav + 라벨 JSON → FLEURS 모양(dev.tsv, audio/dev) → scripts/pace-prep.py 로 빠르기별 소리 + Silero 확률.
// 실행: npx vite-node scripts/pace-aihub.ts <prep 폴더>
// 같은 사람의 다른 답변 A를 '문장 읽기' 대신 기준으로 쓴다 (A의 정답 음절 수로 보정 = 앱이 문장 읽기로 하는 일).
// 그 기준으로 답변 B 전체를 PaceRule에 그대로 넣어 경고가 한 번이라도 뜨는지 본다.
// 화자 번호가 라벨에 없어서, 파일 번호가 10 이내로 붙어 있으면 같은 사람으로 가정했다.
import { readFileSync } from "node:fs";
import { PaceRule, SyllableCounter, hangulSyllables, paceBase } from "../src/rules/pace";
import { SileroGate } from "../src/rules/voice";

interface Item { id: string; file: string; text: string; p: number[] }
const dir = process.argv[2];
const FRAME = 512;
const DT = FRAME / 16000;
const load = (tempo: string) => JSON.parse(readFileSync(`${dir}/items_${tempo}.json`, "utf8")) as Item[];
const wav = (f: string) => { const b = readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

/** 답변 하나를 앱 순서대로: Silero → 말함 → 음절 → PaceRule */
function play(it: Item, base: ReturnType<typeof paceBase>, noFloor = false) {
  const x = wav(it.file);
  const gate = new SileroGate();
  const syl = new SyllableCounter();
  const rule = new PaceRule(base);
  if (noFloor && base) (rule as { limit: number }).limit = base.sps * 1.2;
  let count = 0, speech = 0, fastSec = 0;
  for (let i = 0; i < it.p.length; i++) {
    const t = (i + 1) * DT;
    const voiced = gate.feed(t, it.p[i]);
    const n = syl.push(x.slice(i * FRAME, (i + 1) * FRAME), voiced);
    count += n;
    if (voiced) speech += DT;
    if (rule.update(t, DT, voiced, n)) fastSec += DT;
  }
  rule.tracker.finish(it.p.length * DT);
  return { count, speech, alerts: rule.tracker.events.length, fastSec };
}

const data = Object.fromEntries(["1.0", "1.25", "1.5"].map((t) => [t, load(t)]));
const ids = data["1.0"].map((it) => Number(it.id)).sort((a, b) => a - b);
const group = new Map<number, number>();
let g = 0;
ids.forEach((id, i) => { if (i && id - ids[i - 1] > 10) g++; group.set(id, g); });

const r10 = new Map(data["1.0"].map((it) => [it.id, play(it, null)]));
const trueSps = (it: Item) => hangulSyllables(it.text) / r10.get(it.id)!.speech;
const pct = (a: number, b: number) => `${a}/${b} = ${((a / b) * 100).toFixed(0)}%`;

for (const noFloor of [false, true]) {
  console.log(`\n${noFloor ? "최소 기준(5.5) 없이" : "앱 그대로 (기준 × 1.2, 최소 5.5음절/초)"}`);
  for (const tempo of ["1.0", "1.25", "1.5"]) {
    let pairs = 0, any = 0, slowerPairs = 0, slowerAlarm = 0, sec = 0, dur = 0;
    for (const a of data["1.0"])
      for (const b of data[tempo]) {
        if (a.id === b.id || group.get(Number(a.id)) !== group.get(Number(b.id))) continue;
        const ra = r10.get(a.id)!;
        const base = paceBase(ra.count, ra.speech, hangulSyllables(a.text));
        const res = play(b, base, noFloor);
        pairs++;
        if (res.alerts) any++;
        sec += res.fastSec;
        dur += b.p.length * DT;
        // 1.0배에서 B가 실제로 A보다 빠르지 않은(정답 빠르기 1.1배 미만) 쌍의 경고 = 오경보
        const bb = data["1.0"].find((x) => x.id === b.id)!;
        if (tempo === "1.0" && trueSps(bb) < trueSps(a) * 1.1) { slowerPairs++; if (res.alerts) slowerAlarm++; }
      }
    console.log(`  B를 ${tempo}배로: 경고 뜬 답변 ${pct(any, pairs)}, 경고 켜진 시간 ${((sec / dur) * 100).toFixed(1)}%` +
      (tempo === "1.0" ? ` | 실제로 빠르지 않은 쌍 중 경고(오경보) ${pct(slowerAlarm, slowerPairs)}` : ""));
  }
}

// 음절 수 정확도 (답변 전체, 보정 1개를 모든 답변에 적용하면 얼마나 맞나: 한 번 빼고 나머지로 보정)
const all = data["1.0"].map((it) => ({ truth: hangulSyllables(it.text), est: r10.get(it.id)!.count, speech: r10.get(it.id)!.speech }));
const err = all.map((r, i) => {
  const rest = all.filter((_, j) => j !== i);
  const c = rest.reduce((s, x) => s + x.truth, 0) / rest.reduce((s, x) => s + x.est, 0);
  return (r.est * c - r.truth) / r.truth;
});
console.log(`\n답변 ${all.length}개 음절 수 (한 개 빼고 보정): 평균 절대 오차 ${((err.reduce((s, e) => s + Math.abs(e), 0) / err.length) * 100).toFixed(1)}%, ±10% 안 ${pct(err.filter((e) => Math.abs(e) <= 0.1).length, err.length)}`);
console.log(`같은 사람 묶음 ${g + 1}개 (2개 이상인 묶음 ${[...new Set(group.values())].filter((k) => [...group.values()].filter((v) => v === k).length > 1).length}개)`);
