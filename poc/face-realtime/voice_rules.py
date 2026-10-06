"""7단계: 음성 경고 규칙 (목소리 작음, 길게 막힘)

마이크 음성 감지(speech_state.py)가 주는 '말하는 중인가'와 음량(dB)만 쓴다. 음성 인식은 필요 없다.
순간 소리에 흔들리지 않게 두 경고 모두 '일정 시간 이어질 때만' 켠다 (판정 기준서 2절의 초기값).

- 길게 막힘(stuck): 답변을 한 번이라도 시작한 뒤, 말 없음이 4초 이상 이어짐.
  조용한 순간에 뜨는 경고라서 FeedbackGate의 '쉬는 순간' 규칙 대신 바로 띄운다.
  같은 침묵 동안 한 번만, 그리고 앞 경고에서 30초가 지나야 다시 켠다.
- 목소리 작음(quiet): 말하는 구간 음량이 내 기준보다 6dB 낮은 상태가 10초.
  내 기준 = 이번 연습에서 처음 말한 8초의 음량 중앙값. 최근 10초 동안 말한 구간의 중앙값이
  기준보다 6dB 낮은 상태가 5초 이어지면 켠다 (작아진 뒤 약 10초). 기준 -4dB까지 회복해야 끈다 (켜고 끄는 기준을 달리 둬 깜빡임 방지).

- 말 빠름(fast): 최근 10초 말 속도(speech_rate.py, 분당 음절)가 400 이상이거나 내 기준보다 25% 이상 빠름.
  내 기준 = 처음 말한 20초 동안의 속도 중앙값. 그 20초 동안은 켜지 않는다. 기준 +10% 아래로 내려와야 끈다.

마이크가 없으면(speaking=None) 아무 경고도 켜지 않는다.
"""
from collections import deque
from statistics import median

STUCK_SEC = 4.0          # 답변 중 이만큼 말이 없으면 '길게 막힘'
STUCK_COOLDOWN = 30.0    # 막힘 경고 사이 최소 간격
BASELINE_SEC = 8.0       # 처음 말한 이 시간의 음량으로 내 기준을 잡음
QUIET_WINDOW = 10.0      # 최근 이 시간 동안 말한 구간으로 비교
QUIET_MIN_SPEECH = 3.0   # 창 안에 이만큼은 말해야 판정 (몇 마디로 판정하지 않음)
QUIET_ON_DB = 6.0        # 기준보다 이만큼 작으면 켬
QUIET_OFF_DB = 4.0       # 기준과의 차이가 이만큼 이하로 줄면 끔
FAST_SPM = 400.0         # 분당 음절이 이 이상이면 빠름 (아나운서 약 355)
FAST_ON_RATIO = 1.25     # 또는 내 기준의 이 배수 이상이면 빠름
FAST_OFF_RATIO = 1.10    # 내 기준의 이 배수 아래로 내려오면 끔
RATE_BASELINE_SEC = 20.0 # 처음 말한 이 시간의 속도로 내 기준을 잡음
QUIET_HOLD = 5.0         # 중앙값이 낮은 상태가 이만큼 이어져야 켬 (창 절반 + 이 시간 ≈ 10초)

VOICE_ALERTS = {
    "stuck": "다음 말을 이어 가 보세요",
    "quiet": "조금 더 크게 말해 주세요!",
    "fast": "너무 빠릅니다!",
}
VOICE_STATUS_ALERTS = {"stuck"}  # 쉬는 순간 규칙 없이 바로 띄우는 경고


class VoiceRules:
    def __init__(self):
        self.started = False        # 한 번이라도 말했는지 (말하기 전 생각하는 시간은 막힘이 아님)
        self.silence_since = None
        self.stuck_fired = False    # 지금 침묵에서 이미 막힘 경고를 켰는지
        self.last_stuck = None
        self.baseline_db = None
        self._base_samples = []     # 기준 측정용 dB
        self._base_sec = 0.0
        self._window = deque()      # (t, dt, db) — 말하는 프레임만
        self.quiet = False
        self._low_since = None
        self.rate_baseline = None   # 내 평소 말 속도 (분당 음절)
        self._rate_samples = []
        self._spoken = 0.0          # 지금까지 말한 시간
        self.fast = False
        self.level_gap_db = None    # 기준 대비 현재 차이 (음수 = 작아짐)
        self._last_t = None
        self.events = []            # (이름, 시작, 끝) — 리포트용
        self._open = {}

    def update(self, t, speaking, db=None, rate=None):
        """speaking: True/False/None, db: 이번 프레임 마이크 음량(dBFS), rate: 최근 말 속도(분당 음절, 모르면 None).
        반환: 켜진 경고 이름 목록."""
        dt = 0.0 if self._last_t is None else max(0.0, t - self._last_t)
        self._last_t = t
        if speaking is None:
            return self._track(t, [])

        active = []
        if speaking:
            self.started = True
            self._spoken += dt
            self.silence_since, self.stuck_fired = None, False
            if db is not None:
                self._feed_level(t, dt, db)
        elif self.started:
            if self.silence_since is None:
                self.silence_since = t
            cooled = self.last_stuck is None or t - self.last_stuck >= STUCK_COOLDOWN
            if t - self.silence_since >= STUCK_SEC and (self.stuck_fired or cooled):
                if not self.stuck_fired:
                    self.stuck_fired, self.last_stuck = True, t
                active.append("stuck")
        if self.quiet:
            active.append("quiet")
        if rate is not None:
            self._feed_rate(rate)
        if self.fast:
            active.append("fast")
        return self._track(t, active)

    def _feed_rate(self, rate):
        if self.rate_baseline is None:
            self._rate_samples.append(rate)
            if self._spoken >= RATE_BASELINE_SEC:
                self.rate_baseline = median(self._rate_samples)
        elif rate >= FAST_SPM or rate >= self.rate_baseline * FAST_ON_RATIO:
            self.fast = True
        elif rate < self.rate_baseline * FAST_OFF_RATIO:
            self.fast = False

    def _feed_level(self, t, dt, db):
        if self.baseline_db is None:
            self._base_samples.append(db)
            self._base_sec += dt
            if self._base_sec >= BASELINE_SEC:
                self.baseline_db = median(self._base_samples)
            return
        self._window.append((t, dt, db))
        while self._window and t - self._window[0][0] > QUIET_WINDOW:
            self._window.popleft()
        if sum(d for _, d, _ in self._window) < QUIET_MIN_SPEECH:
            return
        self.level_gap_db = median(x for _, _, x in self._window) - self.baseline_db
        if not self.quiet:
            if self.level_gap_db > -QUIET_ON_DB:
                self._low_since = None
            elif self._low_since is None:
                self._low_since = t
            elif t - self._low_since >= QUIET_HOLD:
                self.quiet = True
        elif self.quiet and self.level_gap_db >= -QUIET_OFF_DB:
            self.quiet, self._low_since = False, None

    def _track(self, t, active):
        for name in active:
            self._open.setdefault(name, t)
        for name in [k for k in self._open if k not in active]:
            self.events.append((name, self._open.pop(name), t))
        return active

    def finish(self, t):
        self._track(t, [])

    def summary(self):
        return {
            "baseline_db": None if self.baseline_db is None else round(self.baseline_db, 1),
            "stuck_count": sum(1 for n, _, _ in self.events if n == "stuck"),
            "quiet_s": round(sum(e - s for n, s, e in self.events if n == "quiet"), 1),
            "fast_s": round(sum(e - s for n, s, e in self.events if n == "fast"), 1),
        }
