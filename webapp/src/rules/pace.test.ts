import { describe, expect, it } from "vitest";
import { PaceRule, SyllableCounter, hangulSyllables, paceBase } from "./pace";
import { AnswerCoach } from "./session";

const SR = 16000;
/** 1kHz 소리를 초당 rate번 켰다 껐다 (음절 흉내). sec초 길이 */
function syllables(rate: number, sec: number) {
  const x = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const env = Math.sin(Math.PI * rate * t) ** 2; // 1/rate초마다 봉우리 1개
    x[i] = 0.3 * env * Math.sin(2 * Math.PI * 1000 * t);
  }
  return x;
}
const frames = (x: Float32Array) => Array.from({ length: Math.floor(x.length / 512) }, (_, i) => x.slice(i * 512, (i + 1) * 512));

describe("음절 세기", () => {
  it.each([3, 5, 7])("초당 %d번 솟는 소리를 그 수만큼 셈", (rate) => {
    const c = new SyllableCounter();
    for (const f of frames(syllables(rate, 4))) c.push(f, true);
    expect(c.count).toBeGreaterThanOrEqual(rate * 4 - 2);
    expect(c.count).toBeLessThanOrEqual(rate * 4 + 1);
  });

  it("말함이 아닐 때 솟은 소리는 세지 않음", () => {
    const c = new SyllableCounter();
    for (const f of frames(syllables(5, 2))) c.push(f, false);
    expect(c.count).toBe(0);
  });

  it("최소 간격보다 촘촘한 봉우리는 하나로", () => {
    const c = new SyllableCounter();
    for (const f of frames(syllables(40, 2))) c.push(f, true); // 25ms마다 봉우리 = 80개
    expect(c.count).toBeLessThanOrEqual(2 / 0.05 + 1);
  });

  it("한글 글자 수 = 음절 수", () => {
    expect(hangulSyllables("안녕하세요. 오늘 면접에서 제 경험을 차분하고 또렷하게 말씀드리겠습니다.")).toBe(31);
    expect(hangulSyllables("AI 2개")).toBe(1);
  });
});

describe("말 빠르기 기준", () => {
  it("문장 음절 수로 세는 버릇을 바로잡음", () => {
    const b = paceBase(25, 5, 31)!;
    expect(b.calib).toBeCloseTo(1.24);
    expect(b.sps).toBeCloseTo(6.2);
  });
  it("보정값은 범위 안으로 자르고, 너무 짧으면 기준 없음", () => {
    expect(paceBase(10, 5, 31)!.calib).toBe(1.6);
    expect(paceBase(3, 5, 31)).toBeNull();
    expect(paceBase(20, 1, 31)).toBeNull();
  });
});

describe("빠른 말 경고", () => {
  const DT = 0.032;
  /** rate 음절/초로 sec초 말하기 (조각마다 음절을 고르게 나눔) */
  function speak(r: PaceRule, from: number, sec: number, rate: number) {
    let acc = 0, on = false;
    for (let t = from; t < from + sec; t += DT) {
      acc += rate * DT;
      const n = Math.floor(acc);
      acc -= n;
      on = r.update(t, DT, true, n);
    }
    return on;
  }

  it("기준보다 1.2배 넘게 빠른 말이 3초 넘게 이어져야 켜짐", () => {
    const r = new PaceRule({ sps: 5, calib: 1 }); // 기준 6.0
    expect(r.limit).toBeCloseTo(6);
    expect(speak(r, 0, 10, 5.5)).toBe(false);
    expect(speak(r, 10, 12, 7.5)).toBe(true);
    expect(r.tracker.events.length).toBe(0); // 아직 켜져 있음
    expect(speak(r, 22, 10, 4.5)).toBe(false);
    r.tracker.finish(40);
    expect(r.tracker.events.map((e) => e.name)).toEqual(["fast"]);
  });

  it("원래 느린 사람은 최소 기준(5.5)까지는 안 띄움", () => {
    const r = new PaceRule({ sps: 3.5, calib: 1 });
    expect(r.limit).toBe(5.5);
    expect(speak(r, 0, 12, 5)).toBe(false);
  });

  it("침묵은 빠르기 계산에서 빠짐 (쉬엄쉬엄 빨리 말해도 잡음)", () => {
    const r = new PaceRule({ sps: 5, calib: 1 });
    let on = false;
    for (let s = 0; s < 30; s += 3) {
      on = speak(r, s, 2, 8) || on; // 2초 빠르게
      for (let t = s + 2; t < s + 3; t += DT) r.update(t, DT, false, 0); // 1초 쉼
    }
    expect(on).toBe(true);
  });

  it("말한 시간이 모자라면 재지 않음", () => {
    const r = new PaceRule(null);
    expect(speak(r, 0, 3, 9)).toBe(false);
    expect(r.sps).toBeNull();
  });

  it("보정값을 곱해서 잼", () => {
    const r = new PaceRule({ sps: 5, calib: 1.5 }); // 센 음절 5개/초 → 7.5
    speak(r, 0, 8, 5);
    expect(r.sps).toBeCloseTo(7.5, 0);
  });
});

describe("답변 코칭에 빠른 말 연결", () => {
  it("소리 조각을 받아 통계에 말 빠르기를 남김", () => {
    const coach = new AnswerCoach({ box: { cx: 0.5, cy: 0.45, w: 0.3 }, gazeStd: 0.02 }, { noiseRms: 1e-3, noiseDb: -60, voiceDb: -25, pace: { sps: 5, calib: 1 } }, 0, "q");
    const x = syllables(5, 6);
    let t = 0;
    for (const f of frames(x)) {
      t += 0.032;
      coach.onAudio(t, 0.05);
      coach.onSamples(t, f);
    }
    const s = coach.finish(t);
    expect(s.pace.syllables).toBeGreaterThan(20);
    expect(s.pace.limit).toBe(6);
    expect(s.pace.base).toEqual({ sps: 5, calib: 1 });
  });
});
