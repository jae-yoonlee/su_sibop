// 답변 하나 동안의 실시간 코칭: 자세 규칙 + 음성 규칙 → 알림 간격 규칙 → 화면 알림, 그리고 통계.
import { FeedbackGate, type GateLog } from "./gate";
import { PostureRules, type PostureBase } from "./postureRules";
import { VoiceRules } from "./voice";
import type { FaceBox, FaceInfo } from "./face";

export const ALERT_LABELS: Record<string, string> = {
  away: "얼굴이 안 보여요",
  turn: "정면을 봐 주세요",
  down: "고개를 들어 주세요",
  center: "화면 가운데로 와 주세요",
  shift: "처음 앉은 자리로 돌아와 주세요",
  gaze: "시선을 한곳에 두세요",
  stuck: "말을 이어 가 보세요",
  quiet: "조금 더 크게 말해 주세요",
  noise: "주변이 시끄러워요",
};

export interface AnswerStats {
  question: string;
  durationS: number;
  alerts: { name: string; label: string; count: number; seconds: number; shown: number }[];
  log: GateLog[];
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

  constructor(posture: PostureBase, voice: VoiceBase | null, private start: number, private question: string) {
    this.posture = new PostureRules(posture);
    this.voice = voice ? new VoiceRules(voice, start) : null;
  }

  /** 카메라 프레임마다 */
  onFrame(t: number, angles: { yaw: number; pitch: number } | null, info: FaceInfo | null, box: FaceBox | null) {
    this.faceActive = this.posture.update(t, angles, info, box);
    this.shown = this.gate.update(t, [...this.faceActive, ...this.voiceActive]);
  }

  /** 마이크 30ms 블록마다 */
  onAudio(t: number, rms: number) {
    if (this.voice) this.voiceActive = this.voice.update(t, rms);
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
          label: ALERT_LABELS[name],
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
      log: this.gate.log.map((l) => ({ ...l, t: Math.round((l.t - this.start) * 100) / 100 })),
    };
  }
}
