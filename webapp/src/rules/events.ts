// 경고가 켜져 있던 구간 기록 (리포트·통계용). 각 규칙 클래스의 _track_events와 같음.
export interface AlertEvent {
  name: string;
  start: number;
  end: number;
}

export class EventTracker {
  events: AlertEvent[] = [];
  private open = new Map<string, number>();

  track(active: Iterable<string>, t: number) {
    const now = new Set(active);
    for (const k of now) if (!this.open.has(k)) this.open.set(k, t);
    for (const [k, start] of [...this.open]) {
      if (!now.has(k)) {
        this.events.push({ name: k, start, end: t });
        this.open.delete(k);
      }
    }
  }

  finish(t: number) {
    this.track([], t);
  }
}
