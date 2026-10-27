// 답변 하나 동안의 실시간 코칭: 자세 규칙 + 음성 규칙 → 알림 간격 규칙 → 화면 알림, 그리고 통계.
import { FeedbackGate, type GateLog } from "./gate";
import { PostureRules, type PostureBase } from "./postureRules";
import { VoiceRules } from "./voice";
import type { FaceBox, FaceInfo } from "./face";
import { MOUTH_STALE_SEC, MOUTH_WINDOW_SEC } from "./constants";

export const ALERT_LABELS: Record<string, string> = {
  away: "얼굴이 안 보여요",
  turn: "정면을 봐 주세요",
  down: "고개를 들어 주세요",
  center: "화면 가운데로 와 주세요",
  shift: "처음 앉은 자리로 돌아와 주세요",
  look: "카메라나 질문을 봐 주세요",
  gaze: "시선을 한곳에 두세요",
  stuck: "말을 이어 가 보세요",
  quiet: "조금 더 크게 말해 주세요",
  noise: "주변이 시끄러워요",
};

// 결과 화면·피드백용 이름: 조언이 아니라 무슨 문제였는지 (2026-10-27 사용자 요청 "시선을 한곳에 두세요 → 시선 분산")
export const ALERT_PROBLEMS: Record<string, string> = {
  away: "얼굴 벗어남",
  turn: "고개 돌림",
  down: "고개 숙임",
  center: "화면 가운데 벗어남",
  shift: "자리 이동",
  look: "다른 곳 응시",
  gaze: "시선 분산",
  stuck: "말 끊김",
  quiet: "작은 목소리",
  noise: "주변 소음",
};

export interface AnswerStats {
  question: string;
  durationS: number;
  alerts: { name: string; label: string; count: number; seconds: number; shown: number }[];
  events: { name: string; start: number; end: number }[]; // 경고 구간 (답변 시작 기준 초) → 녹화 영상에서 그 순간 재생
  log: GateLog[];
  shiftBy: { x: number; y: number; size: number }; // 자리 이동으로 본 시간(초), 축별
  vadShare: number | null; // 말함 판정 중 Silero로 한 비율 (0~1, 나머지는 음량 판정)
  sttRestarts?: number; // 말소리 판정을 보고 받아쓰기를 다시 켠 횟수
  otherVoiceS: number; // 말소리는 들렸지만 입이 안 움직여 남의 소리로 본 시간(초)
  noiseKinds: Record<string, number>; // '주변 소음' 경고 중 들린 소리 종류별 초
  irisShare: number | null; // 눈동자 방향을 홍채 점으로 잰 프레임 비율 (나머지는 표정 점수)
}

export interface VoiceBase {
  noiseRms: number;
  noiseDb: number;
  voiceDb: number;
}

export class AnswerCoach {
  readonly posture: PostureRules;
  readonly voice: VoiceRules | null;
  readonly gate = new FeedbackGate();
  shown: string[] = [];
  private faceActive: string[] = [];
  private voiceActive: string[] = [];
  private jaw: { t: number; v: number }[] = [];
  private frames = 0;
  private irisFrames = 0;
  /** 마지막으로 분류한 주변 소리 종류 (경고 문구에 붙임) */
  sound: string | null = null;
  private noiseKinds: Record<string, number> = {};

  constructor(posture: PostureBase, voice: VoiceBase | null, private start: number, private question: string) {
    this.posture = new PostureRules(posture);
    this.voice = voice ? new VoiceRules(voice, start) : null;
  }

  /** 카메라 프레임마다 */
  onFrame(t: number, angles: { yaw: number; pitch: number } | null, info: FaceInfo | null, box: FaceBox | null) {
    if (info) {
      this.frames++;
      if (info.gazeSrc === "iris") this.irisFrames++;
      this.jaw.push({ t, v: info.jaw });
    }
    while (this.jaw.length && t - this.jaw[0].t > MOUTH_WINDOW_SEC) this.jaw.shift();
    this.faceActive = this.posture.update(t, angles, info, box);
    this.shown = this.gate.update(t, [...this.faceActive, ...this.voiceActive]);
  }

  /** 마이크 30ms 블록마다 */
  onAudio(t: number, rms: number, vad: boolean | null = null) {
    if (this.voice) this.voiceActive = this.voice.update(t, rms, vad, this.mouthMove(t));
  }

  /** 최근 입 벌림 점수의 (최대-최소). 얼굴 프레임이 끊겼거나 모자라면 null */
  mouthMove(t: number): number | null {
    const j = this.jaw;
    if (j.length < 5 || t - j[j.length - 1].t > MOUTH_STALE_SEC || j[j.length - 1].t - j[0].t < MOUTH_WINDOW_SEC * 0.6) return null;
    let lo = 1, hi = 0;
    for (const p of j) [lo, hi] = [Math.min(lo, p.v), Math.max(hi, p.v)];
    return hi - lo;
  }

  /** 소리 분류 결과 (내가 말하지 않을 때 1초마다). 소음 경고 중이면 종류별로 센다 */
  onSound(kind: string | null, sec: number) {
    this.sound = kind;
    if (kind && this.voiceActive.includes("noise")) this.noiseKinds[kind] = (this.noiseKinds[kind] ?? 0) + sec;
  }

  finish(t: number): AnswerStats {
    this.posture.tracker.finish(t);
    this.voice?.tracker.finish(t);
    this.gate.finish(t);
    const events = [...this.posture.tracker.events, ...(this.voice?.tracker.events ?? [])];
    const alerts = Object.keys(ALERT_LABELS)
      .map((name) => {
        const ev = events.filter((e) => e.name === name);
        return {
          name,
          label: ALERT_PROBLEMS[name],
          count: ev.length,
          seconds: Math.round(ev.reduce((a, e) => a + e.end - e.start, 0) * 10) / 10,
          shown: this.gate.log.filter((l) => l.name === name && l.outcome === "shown").length,
        };
      })
      .filter((a) => a.count > 0);
    return {
      question: this.question,
      durationS: Math.round((t - this.start) * 10) / 10,
      alerts,
      events: events
        .filter((e) => e.name in ALERT_LABELS)
        .map((e) => ({ name: e.name, start: Math.round((e.start - this.start) * 10) / 10, end: Math.round((e.end - this.start) * 10) / 10 }))
        .sort((a, b) => a.start - b.start),
      log: this.gate.log.map((l) => ({ ...l, t: Math.round((l.t - this.start) * 100) / 100 })),
      shiftBy: Object.fromEntries(Object.entries(this.posture.shiftBy).map(([k, v]) => [k, Math.round(v * 10) / 10])) as AnswerStats["shiftBy"],
      otherVoiceS: Math.round((this.voice?.otherVoiceSec ?? 0) * 10) / 10,
      noiseKinds: this.noiseKinds,
      irisShare: this.frames ? Math.round((this.irisFrames / this.frames) * 100) / 100 : null,
      vadShare: this.voice?.blocks ? Math.round((this.voice.sileroBlocks / this.voice.blocks) * 100) / 100 : null,
    };
  }
}
