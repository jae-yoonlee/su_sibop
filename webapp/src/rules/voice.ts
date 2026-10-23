// 음성 규칙. 말함 판정(speech_state.EnergyVad), 침묵·작은 목소리(voice_rules.VoiceRules), 주변 소음(웹에서 추가).
import {
  BLOCK_SEC, MIN_ON_SEC, NOISE_HOLD_SEC, NOISE_MAX_DB, NOISE_PERCENTILE, NOISE_RISE_DB, NOISE_SETUP_SEC, NOISE_WINDOW_SEC,
  OFF_HOLD_SEC, OFF_RATIO, ON_RATIO, QUIET_HOLD, QUIET_MIN_SPEECH, QUIET_OFF_DB, QUIET_ON_DB, QUIET_WINDOW,
  MOUTH_MOVE_MIN, SILENCE_RESET_SEC, SPEECH_FLOOR_BELOW_VOICE_DB, STUCK_SEC, VAD_OFF_HOLD_SEC, VAD_OFF_P, VAD_ON_P, VAD_STALE_SEC, VOICE_END_SILENCE_SEC,
  VOICE_MAX_DB, VOICE_MIN_DB, VOICE_SETUP_SEC,
} from "./constants";
import { EventTracker } from "./events";
import { median, quantile, toDb } from "./stats";

/** 소음의 몇 배인지로 말함/안 말함을 정한다. noise는 세팅 때 잰 RMS.
 *  voiceDb(세팅 때 잰 내 목소리)가 있으면 그보다 20dB 넘게 작은 소리(숨소리·잡음)는 말로 보지 않는다. */
export class EnergyVad {
  speaking = false;
  private aboveSince: number | null = null;
  private belowSince: number | null = null;
  private onRms: number;

  constructor(private noise: number, voiceDb: number | null = null, private minOn = MIN_ON_SEC) {
    const floor = voiceDb === null ? 0 : 10 ** ((voiceDb - SPEECH_FLOOR_BELOW_VOICE_DB) / 20);
    this.onRms = Math.max(noise * ON_RATIO, floor);
  }

  feed(t: number, rms: number): boolean {
    if (!this.speaking) {
      if (rms > this.onRms) {
        this.aboveSince ??= t;
        if (t - this.aboveSince >= this.minOn) [this.speaking, this.belowSince] = [true, null];
      } else this.aboveSince = null;
    } else if (rms < this.noise * OFF_RATIO) {
      this.belowSince ??= t;
      if (t - this.belowSince >= OFF_HOLD_SEC) [this.speaking, this.aboveSince] = [false, null];
    } else this.belowSince = null;
    return this.speaking;
  }
}

/** Silero가 준 '말소리일 확률'(32ms마다)을 말함/안 말함으로. 0.5 넘으면 켜고, 0.35 아래로 0.3초 이어지면 끈다. */
export class SileroGate {
  speaking = false;
  lastT: number | null = null;
  private lowSince: number | null = null;

  feed(t: number, p: number): boolean {
    this.lastT = t;
    if (p > VAD_ON_P) [this.speaking, this.lowSince] = [true, null];
    else if (this.speaking && p < VAD_OFF_P) {
      this.lowSince ??= t;
      if (t - this.lowSince >= VAD_OFF_HOLD_SEC) [this.speaking, this.lowSince] = [false, null];
    } else this.lowSince = null;
    return this.speaking;
  }

  /** 최근 판정이 살아 있으면 말함 여부, 끊겼으면 null (그땐 음량으로 판정) */
  at(t: number): boolean | null {
    return this.lastT !== null && t - this.lastT <= VAD_STALE_SEC ? this.speaking : null;
  }
}

export type VoiceSetupStep = "noise" | "voice" | "done";
export type VoiceSetupMessage = "noise" | "noise_high" | "voice" | "voice_low" | "voice_high" | "done";
export const VOICE_SETUP_MESSAGES: Record<VoiceSetupMessage, string> = {
  noise: "주변 소리를 재고 있어요. 스피커 소리는 끄고 잠깐 조용히 계세요",
  noise_high: "소리가 들려서 다시 재요. 말하지 말고 조용히 계세요",
  voice: "아래 문장을 평소 면접 목소리로 끝까지 읽어 주세요. 다 읽고 잠깐 멈추면 넘어가요",
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
  private silentSince: number | null = null;
  private vad: EnergyVad | null = null;
  attempt = 0; // 문장 읽기 시도 번호 (다시 읽을 때마다 +1, 받아쓰기도 같이 새로 시작)

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
    if (this.vad!.feed(t, rms)) {
      this.spoken.push(toDb(rms));
      this.silentSince = null;
    } else if (this.spoken.length) this.silentSince ??= t;
    const voiced = this.spoken.length * BLOCK_SEC;
    this.level = Math.min(1, voiced / VOICE_SETUP_SEC);
    if (voiced < VOICE_SETUP_SEC) return;
    // 문장을 끝까지 읽고 멈출 때까지 기다린다
    if (this.silentSince === null || t - this.silentSince < VOICE_END_SILENCE_SEC) return;
    const db = median(this.spoken);
    this.spoken = [];
    this.silentSince = null;
    if (db < VOICE_MIN_DB) {
      this.message = "voice_low";
      this.attempt++;
    } else if (db > VOICE_MAX_DB) {
      this.message = "voice_high";
      this.attempt++;
    } else {
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
  private lastT: number | null = null;
  private window: { t: number; dt: number; db: number }[] = []; // 말하는 블록만
  private all: { t: number; db: number }[] = []; // 모든 블록 (바닥 소음)
  private quiet = false;
  private lowSince: number | null = null;
  private noisySince: number | null = null;
  private vadOnSince: number | null = null;
  /** 이번 답변에서 Silero로 판정한 블록 비율 (나머지는 음량 판정) */
  sileroBlocks = 0;
  blocks = 0;
  /** 말소리는 들렸지만 입이 안 움직여서 내 말로 안 본 시간(초) */
  otherVoiceSec = 0;

  /** start: 답변 시작 시각. 답변 시작부터 말이 없어도 침묵으로 센다 (질문 읽는 30초가 생각할 시간). */
  constructor(private base: { noiseRms: number; noiseDb: number; voiceDb: number }, start: number) {
    this.vad = new EnergyVad(base.noiseRms, base.voiceDb, SILENCE_RESET_SEC);
    this.silenceSince = start;
  }

  /** vad: Silero의 말함 판정 (없으면 null → 음량만으로 판정). 큰 소음은 음량이 커도 Silero가 말이 아니라고 본다.
   *  mouth: 최근 입 움직임 폭 (얼굴이 없으면 null). 말소리인데 입이 안 움직이면 남의 목소리로 본다. */
  update(t: number, rms: number, vad: boolean | null = null, mouth: number | null = null): VoiceAlert[] {
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const db = toDb(rms);
    const energy = this.vad.feed(t, rms); // 모델이 끊겼다 돌아와도 바로 이어 쓸 수 있게 항상 돌린다
    this.blocks++;
    const voiced = vad ?? energy;
    const other = voiced && mouth !== null && mouth < MOUTH_MOVE_MIN;
    if (vad !== null) this.sileroBlocks++;
    if (other) {
      // 침묵을 끊지 않고, 바닥 소음 계산에는 넣는다
      this.otherVoiceSec += dt;
      [this.speaking, this.vadOnSince, vad] = [false, null, false];
    } else if (vad === null) this.speaking = energy;
    else {
      // 말소리이면서 내 목소리보다 20dB 넘게 작지 않아야 (멀리서 들리는 말소리 제외). 0.3초 이어져야 침묵이 끊김.
      const on = vad && db > this.base.voiceDb - SPEECH_FLOOR_BELOW_VOICE_DB;
      this.vadOnSince = on ? (this.vadOnSince ?? t) : null;
      if (!on) this.speaking = false;
      else if (t - this.vadOnSince! >= SILENCE_RESET_SEC) this.speaking = true;
    }
    const active: VoiceAlert[] = [];

    // 침묵은 5초 넘을 때마다 매번 센다 (예전엔 30초 안에 두 번째 침묵은 세지도 띄우지도 않았음)
    if (this.speaking) {
      this.silenceSince = t;
      this.feedLevel(t, dt, db);
    } else if (t - this.silenceSince >= STUCK_SEC) active.push("stuck");
    if (this.quiet) active.push("quiet");
    if (this.noisy(t, db, vad === true)) active.push("noise");
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
  private noisy(t: number, db: number, speech: boolean) {
    // Silero가 말소리라고 본 블록은 빼고 잰다 (음량 판정일 땐 하위 10%가 말 사이 빈틈 역할)
    if (!speech) this.all.push({ t, db });
    while (this.all.length && t - this.all[0].t > NOISE_WINDOW_SEC) this.all.shift();
    if (!this.all.length || t - this.all[0].t < NOISE_WINDOW_SEC * 0.8) return this.held(t);
    this.noiseFloorDb = quantile(this.all.map((a) => a.db), NOISE_PERCENTILE);
    const loud = this.noiseFloorDb - this.base.noiseDb >= NOISE_RISE_DB;
    this.noisySince = loud ? (this.noisySince ?? t) : null;
    return this.held(t);
  }

  private held(t: number) {
    return this.noisySince !== null && t - this.noisySince >= NOISE_HOLD_SEC;
  }
}
