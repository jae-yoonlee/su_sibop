// 알림 간격 규칙. feedback_gate.FeedbackGate를 옮기되, 2026-10-06 결정대로 '쉴 때만 띄우기'는 빼고 바로 띄운다.
// 간격 규칙(전체 20초, 같은 종류 45초, 1분 최대 2개)은 유지. 못 띄운 경고도 모두 log에 남아 통계로 간다.
import {
  BUDGET_MAX, BUDGET_WINDOW, CARD_SEC, GLOBAL_COOLDOWN, PENDING_MAX_SEC, QUEUE_MAX, TYPE_COOLDOWN,
} from "./constants";

export type Outcome = "shown" | "suppressed" | "report_only" | "dropped";
export interface GateLog {
  t: number;
  name: string;
  outcome: Outcome;
  reason: string;
}

// 측정이 안 되는 상태(얼굴 안 보임)와 침묵은 간격 규칙 없이 바로 띄운다.
export const STATUS_ALERTS = new Set(["away", "stuck"]);
// 여러 경고가 대기 중이면 앞쪽부터 띄운다.
export const PRIORITY = ["turn", "down", "center", "quiet", "noise", "gaze", "shift"];

export class FeedbackGate {
  log: GateLog[] = [];
  private pending = new Map<string, number>();
  private prevActive = new Set<string>();
  private card: { name: string; at: number } | null = null;
  private lastShown: number | null = null;
  private typeLast = new Map<string, number>();
  private recent: number[] = [];
  private statusSeen = new Set<string>();

  private record(t: number, name: string, outcome: Outcome, reason: string) {
    this.log.push({ t: Math.round(t * 100) / 100, name, outcome, reason });
  }

  private blocked(t: number): string | null {
    if (this.lastShown !== null && t - this.lastShown < GLOBAL_COOLDOWN) return "GLOBAL_COOLDOWN";
    while (this.recent.length && t - this.recent[0] > BUDGET_WINDOW) this.recent.shift();
    if (this.recent.length >= BUDGET_MAX) return "BUDGET_EXHAUSTED";
    return null;
  }

  /** active: 지금 기준에 걸린 경고들. 반환: 지금 화면에 띄울 경고들. */
  update(t: number, active: Iterable<string>): string[] {
    const now = new Set(active);
    const shown = [...now].filter((k) => STATUS_ALERTS.has(k));
    for (const k of shown) if (!this.statusSeen.has(k)) this.record(t, k, "shown", "STATUS");
    this.statusSeen = new Set(shown);
    const coaching = new Set([...now].filter((k) => !STATUS_ALERTS.has(k)));

    for (const k of coaching) {
      if (this.prevActive.has(k)) continue; // 같은 상태가 이어지는 동안 다시 넣지 않음
      const last = this.typeLast.get(k);
      if (last !== undefined && t - last < TYPE_COOLDOWN) this.record(t, k, "suppressed", "TYPE_COOLDOWN");
      else if (this.pending.size >= QUEUE_MAX) this.record(t, k, "report_only", "QUEUE_FULL");
      else if (!this.pending.has(k)) this.pending.set(k, t);
    }
    this.prevActive = coaching;

    for (const [k, since] of [...this.pending]) {
      if (!coaching.has(k)) {
        this.pending.delete(k);
        this.record(t, k, "dropped", "RESOLVED");
      } else if (t - since > PENDING_MAX_SEC) {
        this.pending.delete(k);
        this.record(t, k, "report_only", "EXPIRED");
      }
    }

    if (this.card) {
      if (t - this.card.at >= CARD_SEC) this.card = null;
      else return [...shown, this.card.name];
    }
    if (this.pending.size && this.blocked(t) === null) {
      const rank = (k: string) => (PRIORITY.includes(k) ? PRIORITY.indexOf(k) : PRIORITY.length);
      const name = [...this.pending.keys()].sort((a, b) => rank(a) - rank(b) || this.pending.get(a)! - this.pending.get(b)!)[0];
      this.pending.delete(name);
      this.card = { name, at: t };
      this.lastShown = t;
      this.typeLast.set(name, t);
      this.recent.push(t);
      this.record(t, name, "shown", "REALTIME");
      shown.push(name);
    }
    return shown;
  }

  finish(t: number) {
    for (const k of this.pending.keys()) this.record(t, k, "report_only", "SESSION_ENDED");
    this.pending.clear();
  }
}
