// 음절 세기(src/rules/pace.ts) 정확도 측정. 데이터는 저장소에 넣지 않는다.
// 준비: scripts/pace-prep.py 로 FLEURS ko_kr dev (Google, CC BY 4.0, 낭독 226문장)를 빠르기별(0.8·1.0·1.25·1.5배) 소리 + Silero 확률로 만든 뒤
// 실행: npx vite-node scripts/pace-eval.ts <prep 폴더> [--grid]
// 정답 음절 수 = 문장의 한글 글자 수 (숫자·영문이 든 문장은 뺌). 말한 시간 = 앱과 같은 Silero 판정(SileroGate)으로 '말함'인 시간.
import { readFileSync } from "node:fs";
import { SyllableCounter, hangulSyllables, type SyllableOpts } from "../src/rules/pace";
import { SileroGate } from "../src/rules/voice";
import { FAST_RATIO } from "../src/rules/constants";

interface Item { id: string; file: string; text: string; gender: string; p: number[] }
const dir = process.argv[2];
const grid = process.argv.includes("--grid");
const TEMPOS = ["1.0", "0.8", "1.25", "1.5"];
const FRAME = 512;
const FRAME_SEC = FRAME / 16000;

const load = (tempo: string) =>
  (JSON.parse(readFileSync(`${dir}/items_${tempo}.json`, "utf8")) as Item[]).filter((it) => !/[0-9A-Za-z]/.test(it.text));
const data = Object.fromEntries(TEMPOS.map((t) => [t, load(t)]));
const audio = new Map<string, Float32Array>();
const wav = (f: string) => {
  if (!audio.has(f)) {
    const b = readFileSync(f);
    audio.set(f, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
  }
  return audio.get(f)!;
};

/** 앱과 같은 순서: 조각마다 Silero 확률 → 말함 판정 → 음절 세기. from~to 초 구간만 센다 */
function run(it: Item, opts: Partial<SyllableOpts>, from = 0, to = Infinity) {
  const x = wav(it.file);
  const gate = new SileroGate();
  const syl = new SyllableCounter(opts);
  let count = 0, speech = 0;
  for (let i = 0; i < it.p.length; i++) {
    const t = (i + 1) * FRAME_SEC;
    const voiced = gate.feed(t, it.p[i]);
    const n = syl.push(x.slice(i * FRAME, (i + 1) * FRAME), voiced);
    if (t > from && t <= to) {
      count += n;
      if (voiced) speech += FRAME_SEC;
    }
  }
  return { count, speech };
}

// 문장 번호로 반은 기준값 고르기(tune), 반은 시험(test)
const isTune = (id: string) => Number(id) % 2 === 0;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
const pearson = (a: number[], b: number[]) => {
  const [ma, mb] = [mean(a), mean(b)];
  const cov = mean(a.map((v, i) => (v - ma) * (b[i] - mb)));
  return cov / Math.sqrt(mean(a.map((v) => (v - ma) ** 2)) * mean(b.map((v) => (v - mb) ** 2)));
};

function score(items: Item[], opts: Partial<SyllableOpts>, calib = 1) {
  const rows = items.map((it) => {
    const r = run(it, opts);
    const truth = hangulSyllables(it.text);
    return { truth, est: r.count * calib, speech: r.speech };
  }).filter((r) => r.speech > 1);
  const err = rows.map((r) => (r.est - r.truth) / r.truth);
  return {
    n: rows.length,
    bias: mean(err),
    mape: mean(err.map(Math.abs)),
    within10: rows.filter((_, i) => Math.abs(err[i]) <= 0.1).length / rows.length,
    r: pearson(rows.map((r) => r.est / r.speech), rows.map((r) => r.truth / r.speech)),
    calib: mean(rows.map((r) => r.truth)) / mean(rows.map((r) => r.est / calib)),
    trueSps: rows.map((r) => r.truth / r.speech),
  };
}

const base = data["1.0"];
const tune = base.filter((it) => isTune(it.id));
const test = base.filter((it) => !isTune(it.id));
let best: Partial<SyllableOpts> = {};
if (grid) {
  let bestMape = Infinity;
  for (const promStd of [0.2, 0.4, 0.6])
    for (const minGapSec of [0.05, 0.08])
      for (const temporal of [1, 3, 5])
        for (const bands of [4, 8]) {
          const opts = { promStd, minGapSec, temporal, bands };
          const s0 = score(tune, opts);
          const s = score(tune, opts, s0.calib); // 전체 보정 뒤 남는 오차로 비교
          if (s.mape < bestMape) [bestMape, best] = [s.mape, opts];
        }
  console.log("tune 최적", best, "MAPE", bestMape.toFixed(3));
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const raw = score(test, best);
const tuneCal = score(tune, best).calib;
const cal = score(test, best, tuneCal);
console.log(`\n시험 문장 ${raw.n}개 (FLEURS ko dev, 낭독)`);
console.log(`보정 없이: 음절 수 평균 치우침 ${pct(raw.bias)}, 평균 절대 오차 ${pct(raw.mape)}, ±10% 안 ${pct(raw.within10)}, 빠르기 상관 r=${raw.r.toFixed(2)}`);
console.log(`tune 반에서 구한 보정 ×${tuneCal.toFixed(2)} 적용: 치우침 ${pct(cal.bias)}, 평균 절대 오차 ${pct(cal.mape)}, ±10% 안 ${pct(cal.within10)}`);
const all = score(base, best);
const sps = all.trueSps.sort((a, b) => a - b);
console.log(`정답 빠르기(음절/말한 초) 분포: 10%=${sps[Math.floor(sps.length * 0.1)].toFixed(2)} 중앙=${med(sps).toFixed(2)} 90%=${sps[Math.floor(sps.length * 0.9)].toFixed(2)}`);

// 빠르기를 바꾼 소리(음높이 유지, ffmpeg atempo)에서 잰 빠르기가 그만큼 바뀌나
console.log("\n빠르기 바꾼 소리: 잰 빠르기 비율 (1.0배 대비, 중앙값)");
// '정답 기준'은 음절 수는 그대로이고 말한 시간만 바뀐 비율: 쉼 뒤 0.3초 꼬리 때문에 정확히 1.25·1.5가 되지는 않는다
const key = (it: Item) => it.file.split("_").pop()!;
const r10 = new Map(base.map((it) => [key(it), run(it, best)]));
for (const tempo of ["0.8", "1.25", "1.5"]) {
  const ratios: number[] = [], ideal: number[] = [];
  for (const it of data[tempo]) {
    const [a, b] = [run(it, best), r10.get(key(it))!];
    if (!b.count || a.speech < 1) continue;
    ratios.push(a.count / a.speech / (b.count / b.speech));
    ideal.push(b.speech / a.speech);
  }
  ratios.sort((p, q) => p - q);
  console.log(`  ${tempo}배: 잰 비율 ${med(ratios).toFixed(2)} (10%~90%: ${ratios[Math.floor(ratios.length * 0.1)].toFixed(2)}~${ratios[Math.floor(ratios.length * 0.9)].toFixed(2)}), 정답 기준 ${med(ideal).toFixed(2)}`);
}

// 경고 흉내: 앞 6초(=문장 읽기 기준)로 기준을 재고, 나머지를 빠르기별로 재서 기준 × 배수 넘으면 '빠름'.
// 1.0배에서 '빠름'은 오경보, 1.25·1.5배에서 '빠름'은 맞게 잡은 것
const BASE_SEC = 6;
const ratios = [1.1, 1.15, FAST_RATIO, 1.3];
console.log(`\n경고 흉내 (앞 ${BASE_SEC}초 기준, 나머지 구간이 기준 × 배수 이상이면 빠름). 배수: ${ratios.join(" / ")}`);
for (const tempo of TEMPOS) {
  const f = Number(tempo);
  const hit = ratios.map(() => 0);
  let n = 0;
  for (const it of data[tempo]) {
    const orig = base.find((b) => key(b) === key(it))!;
    const b = run(orig, best, 0, BASE_SEC);
    const r = run(it, best, BASE_SEC / f);
    if (b.speech < 3 || r.speech < 3) continue;
    n++;
    ratios.forEach((x, i) => { if (r.count / r.speech >= (b.count / b.speech) * x) hit[i]++; });
  }
  console.log(`  ${tempo}배 (${n}문장): ${hit.map((h) => pct(h / n)).join(" / ")}`);
}
