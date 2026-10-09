// 음성 규칙. 말함 판정(speech_state.EnergyVad), 침묵·작은 목소리(voice_rules.VoiceRules), 주변 소음(웹에서 추가).
import {
  BLOCK_SEC, MIN_ON_SEC, NOISE_HOLD_SEC, NOISE_MAX_DB, NOISE_PERCENTILE, NOISE_RISE_DB, NOISE_SETUP_SEC, NOISE_WINDOW_SEC,
  OFF_HOLD_SEC, OFF_RATIO, ON_RATIO, QUIET_HOLD, QUIET_MIN_SPEECH, QUIET_OFF_DB, QUIET_ON_DB, QUIET_WINDOW,
  STUCK_COOLDOWN, STUCK_SEC, VOICE_MAX_DB, VOICE_MIN_DB, VOICE_SETUP_SEC,
} from "./constants";
import { EventTracker } from "./events";
import { median, quantile, toDb } from "./stats";

/** 소음의 몇 배인지로 말함/안 말함을 정한다. noise는 세팅 때 잰 RMS. */
export class EnergyVad {
  speaking = false;
  private aboveSince: number | null = null;
  private belowSince: number | null = null;

  constructor(private noise: number) {}

  feed(t: number, rms: number): boolean {
    if (!this.speaking) {
      if (rms > this.noise * ON_RATIO) {
        this.aboveSince ??= t;
        if (t - this.aboveSince >= MIN_ON_SEC) [this.speaking, this.belowSince] = [true, null];
      } else this.aboveSince = null;
    } else if (rms < this.noise * OFF_RATIO) {
      this.belowSince ??= t;
      if (t - this.belowSince >= OFF_HOLD_SEC) [this.speaking, this.aboveSince] = [false, null];
    } else this.belowSince = null;
    return this.speaking;
  }
}

export type VoiceSetupStep = "noise" | "voice" | "done";
export type VoiceSetupMessage = "noise" | "noise_high" | "voice" | "voice_low" | "voice_high" | "done";
export const VOICE_SETUP_MESSAGES: Record<VoiceSetupMessage, string> = {
  noise: "조용히 잠깐만 계세요. 주변 소리를 재고 있어요",
  noise_high: "소리가 들려서 다시 재요. 말하지 말고 조용히 계세요",
  voice: "아래 문장을 평소 면접 목소리로 읽어 주세요",
  voice_low: "목소리가 작아요. 조금만 크게 다시 읽어 주세요",
  voice_high: "목소리가 너무 커요. 조금만 작게 다시 읽어 주세요",
  done: "목소리 기준 완료!",
};

/** 조용히 있기(소음 측정) → 문장 읽기(내 목소리 기준). 결과는 이후 규칙의 기준이 된다. */
export class VoiceSetup {
  step: VoiceSetupStep = "noise";
  message: VoiceSetupMessage = "noise";
  noiseRms: number | null = null;
  noiseDb: number | null = null;
  voiceDb: number | null = null;
  level = 0; // 진행도 0~1 (화면 막대)
  private samples: number[] = [];
  private spoken: number[] = [];
  private vad: EnergyVad | null = null;

  get active() {
    return this.step !== "done";
  }

  feed(t: number, rms: number) {
    if (this.step === "noise") {
      this.samples.push(rms);
      this.level = Math.min(1, (this.samples.length * BLOCK_SEC) / NOISE_SETUP_SEC);
      if (this.samples.length * BLOCK_SEC >= NOISE_SETUP_SEC) {
        const rms = median(this.samples);
        this.samples = [];
        if (toDb(rms) > NOISE_MAX_DB) {
          this.message = "noise_high";
          return;
        }
        this.noiseRms = Math.max(rms, 1e-4);
        this.noiseDb = toDb(this.noiseRms);
        this.vad = new EnergyVad(this.noiseRms);
        this.step = "voice";
        this.message = "voice";
      }
      return;
    }
    if (this.step !== "voice") return;
    if (this.vad!.feed(t, rms)) this.spoken.push(toDb(rms));
    this.level = Math.min(1, (this.spoken.length * BLOCK_SEC) / VOICE_SETUP_SEC);
    if (this.spoken.length * BLOCK_SEC < VOICE_SETUP_SEC) return;
    const db = median(this.spoken);
    this.spoken = [];
    if (db < VOICE_MIN_DB) this.message = "voice_low";
    else if (db > VOICE_MAX_DB) this.message = "voice_high";
    else {
      this.voiceDb = db;
      this.step = "done";
      this.message = "done";
    }
  }
}

export type VoiceAlert = "stuck" | "quiet" | "noise";

export class VoiceRules {
  readonly tracker = new EventTracker();
  speaking = false;
  levelGapDb: number | null = null;
  noiseFloorDb: number | null = null;
  private vad: EnergyVad;
  private silenceSince: number;
  private stuckFired = false;
  private lastStuck: number | null = null;
  private lastT: number | null = null;
  private window: { t: number; dt: number; db: number }[] = []; // 말하는 블록만
  private all: { t: number; db: number }[] = []; // 모든 블록 (바닥 소음)
  private quiet = false;
  private lowSince: number | null = null;
  private noisySince: number | null = null;

  /** start: 답변 시작 시각. 답변 시작부터 말이 없어도 침묵으로 센다 (질문 읽는 30초가 생각할 시간). */
  constructor(private base: { noiseRms: number; noiseDb: number; voiceDb: number }, start: number) {
    this.vad = new EnergyVad(base.noiseRms);
    this.silenceSince = start;
  }

  update(t: number, rms: number): VoiceAlert[] {
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const db = toDb(rms);
    this.speaking = this.vad.feed(t, rms);
    const active: VoiceAlert[] = [];

    if (this.speaking) {
      [this.silenceSince, this.stuckFired] = [t, false];
      this.feedLevel(t, dt, db);
    } else {
      const cooled = this.lastStuck === null || t - this.lastStuck >= STUCK_COOLDOWN;
      if (t - this.silenceSince >= STUCK_SEC && (this.stuckFired || cooled)) {
        if (!this.stuckFired) [this.stuckFired, this.lastStuck] = [true, t];
        active.push("stuck");
      }
    }
    if (this.quiet) active.push("quiet");
    if (this.noisy(t, db)) active.push("noise");
    this.tracker.track(active, t);
    return active;
  }

  private feedLevel(t: number, dt: number, db: number) {
    this.window.push({ t, dt, db });
    while (this.window.length && t - this.window[0].t > QUIET_WINDOW) this.window.shift();
    if (this.window.reduce((a, w) => a + w.dt, 0) < QUIET_MIN_SPEECH) return;
    this.levelGapDb = median(this.window.map((w) => w.db)) - this.base.voiceDb;
    if (!this.quiet) {
      if (this.levelGapDb > -QUIET_ON_DB) this.lowSince = null;
      else if (this.lowSince === null) this.lowSince = t;
      else if (t - this.lowSince >= QUIET_HOLD) this.quiet = true;
    } else if (this.levelGapDb >= -QUIET_OFF_DB) [this.quiet, this.lowSince] = [false, null];
  }

  /** 최근 몇 초 음량의 하위 10%(말 사이 빈틈)가 세팅 때 소음보다 크게 올라가면 주변이 시끄러운 것 */
  private noisy(t: number, db: number) {
    this.all.push({ t, db });
    while (this.all.length && t - this.all[0].t > NOISE_WINDOW_SEC) this.all.shift();
    if (t - this.all[0].t < NOISE_WINDOW_SEC * 0.8) return false;
    this.noiseFloorDb = quantile(this.all.map((a) => a.db), NOISE_PERCENTILE);
    const loud = this.noiseFloorDb - this.base.noiseDb >= NOISE_RISE_DB;
    this.noisySince = loud ? (this.noisySince ?? t) : null;
    return this.noisySince !== null && t - this.noisySince >= NOISE_HOLD_SEC;
  }
}
