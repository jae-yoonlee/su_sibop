"""5단계: 쉴 때만 경고 띄우기 (피드백 타이밍 정책)

CoachRules가 "지금 조건에 걸린 경고"를 매 프레임 알려 주면, FeedbackGate가 그중
무엇을 언제 화면에 보여줄지 정한다.

- 말하는 중에는 새 경고를 띄우지 않고 '대기'시킨다.
- 말을 멈춘 뒤 0.7~1.5초 사이(짧은 숨 고르기)에만 띄운다. 1.5초 넘게 조용하면 생각 중일 수 있어 새로 띄우지 않는다.
- 대기 중에 상태가 풀리면(정면으로 돌아오면) 띄우지 않고 버린다.
- 8초 안에 띄울 틈이 없으면 버리고 리포트에만 남긴다.
- 한 번에 카드 1개, 전체 쿨다운 20초, 같은 종류 45초, 최근 60초에 최대 2개.
- 카드는 2초 보여주고, 그 사이 다시 말하기 시작하면 바로 내린다.
- '화면 안으로 들어와 주세요'처럼 측정 자체가 안 되는 상태 안내는 코칭이 아니라서 바로 띄운다.

음성 입력이 없으면(no_audio) 쉬는 순간을 알 수 없으므로 쿨다운·예산만 적용하고 바로 띄운다.
기준값은 기획서 4.6절의 초기값이며 사용자 실험으로 조정할 값이다.
"""
from collections import deque

PAUSE_MIN_SEC = 0.7     # 말을 멈춘 뒤 이 시간이 지나야 띄움 (말이 다시 이어질 수 있어서)
PAUSE_MAX_SEC = 1.5     # 이 시간보다 오래 조용하면 생각 중일 수 있어 새로 띄우지 않음
PENDING_MAX_SEC = 8.0   # 대기 경고의 유효 시간
CARD_SEC = 2.0          # 카드 노출 시간
GLOBAL_COOLDOWN = 20.0  # 카드를 띄운 뒤 다음 카드까지 최소 간격
TYPE_COOLDOWN = 45.0    # 같은 종류 카드 사이 최소 간격
BUDGET_WINDOW = 60.0
BUDGET_MAX = 2          # 최근 60초에 띄울 수 있는 카드 수
QUEUE_MAX = 2           # 대기열 최대 길이 (넘치면 리포트로)
STATUS_ALERTS = {"away"}  # 측정 불가 상태 안내: 타이밍 규칙 없이 바로 표시


class FeedbackGate:
    def __init__(self, priority=("turn", "down"), no_audio=False):
        self.priority = list(priority)
        self.no_audio = no_audio
        self.pending = {}         # 이름 → 대기 시작 시각
        self.prev_active = set()
        self.card = None          # (이름, 띄운 시각)
        self.last_shown = None    # 마지막 카드를 띄운 시각
        self.type_last = {}       # 종류별 마지막 표시 시각
        self.recent = deque()     # 최근 60초 표시 시각
        self.speaking = False
        self.silence_since = None  # 마지막으로 말을 멈춘 시각 (한 번도 말하지 않았으면 None)
        self.log = []             # (시각, 이름, 결과, 이유) — 리포트용

    def _record(self, t, name, outcome, reason):
        self.log.append((round(t, 2), name, outcome, reason))

    def _update_speech(self, t, speaking):
        if speaking is None:
            return
        if self.speaking and not speaking:
            self.silence_since = t
        self.speaking = speaking

    def in_pause_window(self, t):
        """지금이 '짧게 숨 고르는 순간'인지"""
        if self.no_audio:
            return True
        if self.speaking or self.silence_since is None:
            return False
        return PAUSE_MIN_SEC <= t - self.silence_since <= PAUSE_MAX_SEC

    def _blocked_reason(self, t):
        if self.last_shown is not None and t - self.last_shown < GLOBAL_COOLDOWN:
            return "GLOBAL_COOLDOWN"
        while self.recent and t - self.recent[0] > BUDGET_WINDOW:
            self.recent.popleft()
        if len(self.recent) >= BUDGET_MAX:
            return "BUDGET_EXHAUSTED"
        return None

    def update(self, t, active, speaking=None):
        """active: CoachRules.update()가 돌려준 경고 이름 목록. speaking: True/False/None(모름).
        반환: 지금 화면에 띄울 경고 이름 목록."""
        self._update_speech(t, speaking)
        active = set(active)
        shown = [k for k in active if k in STATUS_ALERTS]
        coaching = active - STATUS_ALERTS

        # 새로 걸린 경고만 대기열에 넣는다 (같은 상태가 이어지는 동안 다시 넣지 않음)
        for k in coaching - self.prev_active:
            if self.type_last.get(k) is not None and t - self.type_last[k] < TYPE_COOLDOWN:
                self._record(t, k, "suppressed", "TYPE_COOLDOWN")
            elif len(self.pending) >= QUEUE_MAX:
                self._record(t, k, "report_only", "QUEUE_FULL")
            else:
                self.pending.setdefault(k, t)
        self.prev_active = coaching

        # 풀렸거나 오래된 대기 경고 정리
        for k, since in list(self.pending.items()):
            if k not in coaching:
                del self.pending[k]
                self._record(t, k, "dropped", "RESOLVED")
            elif t - since > PENDING_MAX_SEC:
                del self.pending[k]
                self._record(t, k, "report_only", "EXPIRED")

        # 떠 있는 카드: 시간이 다 됐거나 다시 말하기 시작하면 내림
        if self.card:
            name, at = self.card
            if t - at >= CARD_SEC or (not self.no_audio and self.speaking):
                self.card = None
            else:
                return shown + [name]

        if self.pending and self.in_pause_window(t) and self._blocked_reason(t) is None:
            name = min(self.pending, key=lambda k: (self._rank(k), self.pending[k]))
            del self.pending[name]
            self.card = (name, t)
            self.last_shown = t
            self.type_last[name] = t
            self.recent.append(t)
            self._record(t, name, "shown", "PAUSE_WINDOW" if not self.no_audio else "NO_AUDIO")
            shown.append(name)
        return shown

    def _rank(self, name):
        return self.priority.index(name) if name in self.priority else len(self.priority)

    def finish(self, t):
        for k in list(self.pending):
            self._record(t, k, "report_only", "SESSION_ENDED")
        self.pending.clear()
