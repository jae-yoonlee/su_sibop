// 말 빠르기 (음절 방식). 받아쓰기 글은 말이 빠져서(2026-10-27 실사용: 41초 답변 → 25단어) 쓰지 않는다.
// 한국어는 음절마다 모음이 하나라 여러 주파수 대역에서 소리가 함께 솟는다 → 그 봉우리를 음절로 센다.
// 방법: Wang & Narayanan 2007의 '대역 간 상관' 방식을 실시간으로. 대역 하나의 소리 크기(de Jong & Wempe 2009)는
// FLEURS 한국어로 재 보니 1.5배 빠른 말에서 음절이 21% 사라져 빠르기 변화를 못 따라갔다 (scripts/pace-eval.ts, PR 설명 참고).
// 말 빠르기 = 최근 몇 초 동안 센 음절 ÷ 그동안 말한 시간(말소리 판정이 '말함'인 시간). 침묵은 빼므로 쉬엄쉬엄 말해도 빠르면 잡는다.
import {
  FAST_ABS_SPS, FAST_HOLD_SEC, FAST_MIN_SPS, FAST_OFF_RATIO, FAST_RATIO, PACE_CALIB_RANGE, PACE_MIN_SPEECH_SEC, PACE_WINDOW_SEC,
  SYL_BANDS, SYL_HIGH_HZ, SYL_HOP_SEC, SYL_LOW_HZ, SYL_MIN_GAP_SEC, SYL_PROM_STD, SYL_STD_SEC, SYL_TEMPORAL,
} from "./constants";
import { EventTracker } from "./events";
import { median } from "./stats";

const SR = 16000;

/** 2차 필터 하나 (RBJ 공식) */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b: number[];
  private a: number[];

  constructor(kind: "high" | "low", hz: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * hz) / SR;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + alpha;
    const b = kind === "low" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    this.b = b.map((v) => v / a0);
    this.a = [(-2 * c) / a0, (1 - alpha) / a0];
  }

  step(x: number) {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    [this.x2, this.x1, this.y2, this.y1] = [this.x1, x, this.y1, y];
    return y;
  }
}

export interface SyllableOpts {
  bands: number; // lowHz~highHz를 이만큼의 대역으로 (로그 간격)
  lowHz: number;
  highHz: number;
  hopSec: number;
  temporal: number; // 대역마다 최근 이만큼의 칸을 기하평균 (짧은 잡음 튐 무시)
  promStd: number; // 앞뒤 골짜기보다 (최근 점수 표준편차 × 이 값)만큼 높아야 봉우리
  minGapSec: number; // 봉우리 사이 최소 간격
  stdSec: number; // 표준편차를 잴 최근 시간
}

export const SYL_DEFAULTS: SyllableOpts = {
  bands: SYL_BANDS, lowHz: SYL_LOW_HZ, highHz: SYL_HIGH_HZ, hopSec: SYL_HOP_SEC, temporal: SYL_TEMPORAL,
  promStd: SYL_PROM_STD, minGapSec: SYL_MIN_GAP_SEC, stdSec: SYL_STD_SEC,
};

/** 16kHz 소리 조각을 받아 음절을 센다. 말함으로 판정된 순간의 봉우리만 센다. */
export class SyllableCounter {
  count = 0;
  private filters: [Biquad, Biquad][];
  private acc: number[];
  private accN = 0;
  private hop: number;
  private logs: number[][] = []; // 대역별 최근 temporal칸의 log 크기
  private n = 0;
  private valley = Infinity;
  private cand: { e: number; n: number; voiced: boolean } | null = null;
  private lastPeak = -Infinity;
  private recent: number[] = []; // 최근 점수 (표준편차용)
  private sum = 0;
  private sumSq = 0;
  private readonly o: SyllableOpts;

  constructor(opts: Partial<SyllableOpts> = {}) {
    this.o = { ...SYL_DEFAULTS, ...opts };
    const { bands, lowHz, highHz } = this.o;
    const edge = (i: number) => lowHz * (highHz / lowHz) ** (i / bands);
    this.filters = Array.from({ length: bands }, (_, i) => [new Biquad("high", edge(i)), new Biquad("low", edge(i + 1))]);
    this.acc = new Array(bands).fill(0);
    this.logs = Array.from({ length: bands }, () => []);
    this.hop = Math.round(this.o.hopSec * SR);
  }

  /** voiced: 이 조각 동안 말함 판정. 반환: 이 조각에서 새로 센 음절 수 */
  push(frame: Float32Array, voiced: boolean): number {
    const before = this.count;
    const f = this.filters;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i];
      for (let b = 0; b < f.length; b++) {
        const y = f[b][1].step(f[b][0].step(x));
        this.acc[b] += y * y;
      }
      if (++this.accN >= this.hop) {
        this.onHop(voiced);
        this.acc.fill(0);
        this.accN = 0;
      }
    }
    return this.count - before;
  }

  /** 대역마다 최근 몇 칸의 기하평균 → 대역 쌍마다 곱의 제곱근을 더한 점수 (여러 대역에서 함께 솟을 때만 커짐) */
  private score(): number {
    const t = this.logs.map((l, b) => {
      l.push(0.5 * Math.log(this.acc[b] / this.accN + 1e-12));
      if (l.length > this.o.temporal) l.shift();
      return Math.exp(l.reduce((a, v) => a + v, 0) / l.length);
    });
    let s = 0;
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) s += Math.sqrt(t[i] * t[j]);
    return s;
  }

  private onHop(voiced: boolean) {
    this.n++;
    const e = this.score();
    this.recent.push(e);
    this.sum += e;
    this.sumSq += e * e;
    if (this.recent.length > this.o.stdSec / this.o.hopSec) {
      const old = this.recent.shift()!;
      this.sum -= old;
      this.sumSq -= old * old;
    }
    const m = this.sum / this.recent.length;
    const prom = this.o.promStd * Math.sqrt(Math.max(0, this.sumSq / this.recent.length - m * m));
    if (this.cand === null) {
      if (e > this.valley) this.cand = { e, n: this.n, voiced };
      else this.valley = e;
      return;
    }
    if (e >= this.cand.e) {
      this.cand = { e, n: this.n, voiced };
      return;
    }
    if (this.cand.e - e < prom) return;
    // 봉우리에서 prom만큼 내려왔으면 확정
    const c = this.cand;
    const gapOk = (c.n - this.lastPeak) * this.o.hopSec >= this.o.minGapSec;
    if (c.voiced && c.e - this.valley >= prom && gapOk) {
      this.count++;
      this.lastPeak = c.n;
    }
    this.valley = e;
    this.cand = null;
  }
}

/** 문장 읽기 때 잰 내 말 빠르기. calib = (문장의 실제 음절 수 ÷ 센 음절 수): 사람·마이크마다 세는 버릇을 바로잡는다 */
export interface PaceBase {
  sps: number; // 바로잡은 뒤 음절/초
  calib: number;
}

/** 문장 읽기 동안 센 음절과 말한 시간으로 기준을 만든다. 너무 적게 말했으면 null */
export function paceBase(syllables: number, speechSec: number, knownSyllables: number): PaceBase | null {
  if (syllables < 5 || speechSec < 1.5) return null;
  const [lo, hi] = PACE_CALIB_RANGE;
  const calib = Math.min(hi, Math.max(lo, knownSyllables / syllables));
  return { sps: (syllables * calib) / speechSec, calib };
}

/** 글의 음절 수 (한글 한 글자 = 한 음절). 숫자·영문은 세지 않는다 */
export const hangulSyllables = (s: string) => (s.match(/[가-힣]/g) ?? []).length;

/** 최근 PACE_WINDOW_SEC 동안의 말 빠르기가 기준보다 FAST_HOLD_SEC 넘게 빠르면 'fast' */
export class PaceRule {
  readonly tracker = new EventTracker();
  /** 지금 말 빠르기 (바로잡은 음절/초). 말한 시간이 모자라면 null */
  sps: number | null = null;
  readonly limit: number;
  private win: { t: number; dt: number; syl: number }[] = [];
  private overSince: number | null = null;
  private fast = false;
  private samples: number[] = []; // 답변 중 말 빠르기 (리포트 중앙값용)
  syllables = 0;
  speechSec = 0;

  constructor(readonly base: PaceBase | null) {
    this.limit = base ? Math.max(base.sps * FAST_RATIO, FAST_MIN_SPS) : FAST_ABS_SPS;
  }

  /** 소리 조각(32ms)마다: dt 동안 말했는지, 그동안 센 음절 수 */
  update(t: number, dt: number, voiced: boolean, syl: number): boolean {
    const calib = this.base?.calib ?? 1;
    this.syllables += syl;
    if (voiced) this.speechSec += dt;
    this.win.push({ t, dt: voiced ? dt : 0, syl });
    while (this.win.length && t - this.win[0].t > PACE_WINDOW_SEC) this.win.shift();
    const speech = this.win.reduce((a, w) => a + w.dt, 0);
    if (speech < PACE_MIN_SPEECH_SEC) {
      this.sps = null;
      this.overSince = null;
    } else {
      this.sps = (this.win.reduce((a, w) => a + w.syl, 0) * calib) / speech;
      if (voiced) this.samples.push(this.sps);
      if (!this.fast) {
        this.overSince = this.sps >= this.limit ? (this.overSince ?? t) : null;
        if (this.overSince !== null && t - this.overSince >= FAST_HOLD_SEC) this.fast = true;
      } else if (this.sps < this.limit * FAST_OFF_RATIO) [this.fast, this.overSince] = [false, null];
    }
    if (this.sps === null) this.fast = false;
    this.tracker.track(this.fast ? ["fast"] : [], t);
    return this.fast;
  }

  /** 답변 전체의 말 빠르기 중앙값 (바로잡은 음절/초) */
  get typicalSps(): number | null {
    return this.samples.length ? median(this.samples) : null;
  }
}
