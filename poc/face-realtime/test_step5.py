"""5단계 테스트: 쉴 때만 경고(FeedbackGate), 카메라 위치 맞추기(CameraSetup), 음량 VAD. 실행: pytest -q"""
import pytest

import feedback_gate as fg
from camera_setup import CameraSetup, position_issue
from feedback_gate import FeedbackGate
from speech_state import EnergyVad

FPS = 30
DT = 1 / FPS


class GateFeeder:
    """가짜 프레임으로 FeedbackGate를 돌리는 도우미"""

    def __init__(self, **kw):
        self.gate, self.t, self.shown = FeedbackGate(**kw), 0.0, []
        self.ever_shown = []

    def run(self, sec, active=(), speaking=None):
        for _ in range(round(sec * FPS)):
            self.t += DT
            self.shown = self.gate.update(self.t, list(active), speaking)
            self.ever_shown += [k for k in self.shown if k not in self.ever_shown]
        return self.shown


def outcomes(gate):
    return [(name, outcome, reason) for _, name, outcome, reason in gate.log]


# --- 쉴 때만 띄우기 ---
def test_no_card_while_speaking():
    f = GateFeeder()
    f.run(1, speaking=True)
    assert f.run(5, active=["turn"], speaking=True) == []
    assert "turn" in f.gate.pending


def test_card_appears_in_short_pause():
    f = GateFeeder()
    f.run(2, active=["turn"], speaking=True)
    assert f.run(0.6, active=["turn"], speaking=False) == []   # 멈춘 직후는 아직
    assert f.run(0.2, active=["turn"], speaking=False) == ["turn"]  # 0.7초 지나면 표시


def test_no_new_card_after_long_silence():
    """1.5초 넘게 조용하면 생각 중일 수 있어 새로 띄우지 않는다"""
    f = GateFeeder()
    f.run(1, speaking=True)
    f.run(2, speaking=False)                      # 이미 2초째 조용함
    assert f.run(3, active=["turn"], speaking=False) == []


def test_resolved_before_pause_is_dropped():
    f = GateFeeder()
    f.run(2, active=["turn"], speaking=True)
    f.run(1, active=[], speaking=True)            # 말하는 사이 정면으로 돌아옴
    f.run(1, speaking=False)
    assert f.ever_shown == []
    assert ("turn", "dropped", "RESOLVED") in outcomes(f.gate)


def test_pending_expires_after_8_seconds():
    f = GateFeeder()
    f.run(9, active=["turn"], speaking=True)
    assert ("turn", "report_only", "EXPIRED") in outcomes(f.gate)
    assert f.gate.pending == {}


def test_card_hides_when_speech_resumes():
    f = GateFeeder()
    f.run(1, active=["turn"], speaking=True)
    assert f.run(0.8, active=["turn"], speaking=False) == ["turn"]
    assert f.run(0.1, active=["turn"], speaking=True) == []


def test_card_hides_after_two_seconds():
    f = GateFeeder(no_audio=True)
    assert f.run(0.1, active=["turn"]) == ["turn"]
    assert f.run(1.8, active=["turn"]) == ["turn"]
    assert f.run(0.2, active=["turn"]) == []


def test_global_cooldown_and_same_type_cooldown():
    f = GateFeeder(no_audio=True)
    f.run(0.1, active=["turn"])
    f.run(3, active=[])
    f.run(3, active=["down"])                     # 20초 쿨다운 중이라 대기 → 만료
    assert "down" not in f.ever_shown
    f.run(20)
    f.run(0.1, active=["turn"])                   # 같은 종류는 45초 쿨다운
    assert ("turn", "suppressed", "TYPE_COOLDOWN") in outcomes(f.gate)


def test_budget_two_cards_per_minute(monkeypatch):
    monkeypatch.setattr(fg, "GLOBAL_COOLDOWN", 0.0)
    monkeypatch.setattr(fg, "TYPE_COOLDOWN", 0.0)
    f = GateFeeder(no_audio=True)
    for _ in range(3):
        f.run(2.5, active=["turn"])
        f.run(0.5, active=[])
    shown = [row for row in outcomes(f.gate) if row[1] == "shown"]
    assert len(shown) == 2


def test_status_alert_shows_immediately_even_while_speaking():
    f = GateFeeder()
    assert f.run(0.1, active=["away"], speaking=True) == ["away"]


def test_priority_turn_before_down():
    f = GateFeeder()
    f.run(1, active=["down", "turn"], speaking=True)
    assert f.run(0.8, active=["down", "turn"], speaking=False) == ["turn"]


# --- 카메라 위치 ---
@pytest.mark.parametrize("box,issue", [
    (None, "no_face"),
    ({"cx": 0.5, "cy": 0.5, "w": 0.10}, "too_far"),
    ({"cx": 0.5, "cy": 0.5, "w": 0.60}, "too_close"),
    ({"cx": 0.2, "cy": 0.5, "w": 0.30}, "move_right"),
    ({"cx": 0.8, "cy": 0.5, "w": 0.30}, "move_left"),
    ({"cx": 0.5, "cy": 0.2, "w": 0.30}, "too_high"),
    ({"cx": 0.5, "cy": 0.8, "w": 0.30}, "too_low"),
    ({"cx": 0.5, "cy": 0.5, "w": 0.30}, None),
])
def test_position_issue(box, issue):
    assert position_issue(box) == issue


GOOD_BOX = {"cx": 0.5, "cy": 0.5, "w": 0.30}


def run_setup(setup, sec, t, yaw=0.0, pitch=0.0, box=GOOD_BOX, face=True):
    for _ in range(round(sec * FPS)):
        t += DT
        info = {"yaw": yaw, "pitch": pitch, "roll": 0.0} if face else None
        setup.feed(t, info, box if face else None)
    return t


def test_setup_ignores_gaze_shift_between_steps():
    """렌즈 단계가 끝난 직후 아직 렌즈를 보고 있던 프레임이 화면 기준에 섞이면 안 된다"""
    s = CameraSetup()
    t = run_setup(s, 1.2, 0.0)
    t = run_setup(s, 2.8, t, pitch=4.0)
    assert s.step == "screen"
    t = run_setup(s, 0.5, t, pitch=4.0)              # 아직 렌즈를 보는 중
    run_setup(s, 2.5, t, pitch=12.0)
    assert s.baseline["pitch"] == pytest.approx(12.0)


def test_setup_full_flow_uses_screen_as_front():
    s = CameraSetup()
    t = run_setup(s, 1.2, 0.0)                       # 위치 OK 1초 → 렌즈 단계
    assert s.step == "lens"
    t = run_setup(s, 2.8, t, pitch=4.0)              # 렌즈 보기 (시선 옮길 0.7초 + 2초)
    assert s.step == "screen"
    t = run_setup(s, 2.8, t, pitch=12.0)             # 화면 보기 (렌즈보다 아래)
    assert not s.active
    # 화면을 보는 자세(Pitch 12°)가 0°가 되므로 평소처럼 화면을 봐도 '숙임'이 아님
    assert s.apply({"yaw": 0.0, "pitch": 12.0, "roll": 0.0})["pitch"] == pytest.approx(0.0)
    assert s.warnings == []


def test_setup_warns_camera_low_and_screen_gap():
    s = CameraSetup()
    t = run_setup(s, 1.2, 0.0)
    t = run_setup(s, 2.8, t, pitch=14.0)             # 렌즈를 보려고 14° 숙임 → 카메라가 낮음
    run_setup(s, 2.8, t, pitch=28.0)                 # 화면은 더 아래
    assert s.warnings == ["camera_low", "screen_gap"]


def test_setup_waits_while_position_is_wrong():
    s = CameraSetup()
    run_setup(s, 3, 0.0, box={"cx": 0.5, "cy": 0.5, "w": 0.10})
    assert s.step == "position" and s.message == "too_far"


def test_setup_skip_position():
    s = CameraSetup()
    s.skip_position()
    assert s.step == "lens"


def test_setup_lens_rejects_moving_head():
    s = CameraSetup()
    t = run_setup(s, 1.2, 0.0)
    for i in range(round(3 * FPS)):                  # 좌우로 계속 흔들림
        t += DT
        s.feed(t, {"yaw": 8.0 if i % 10 < 5 else -8.0, "pitch": 0.0, "roll": 0.0}, GOOD_BOX)
    assert s.step == "lens"


def test_setup_lens_rejects_turned_head():
    s = CameraSetup()
    t = run_setup(s, 1.2, 0.0)
    run_setup(s, 3, t, yaw=25.0)
    assert s.step == "lens"


def test_setup_face_lost_resets_window():
    s = CameraSetup()
    t = run_setup(s, 1.2, 0.0)
    t = run_setup(s, 2.2, t)                         # 0.7초 대기 + 1.5초 유지
    t = run_setup(s, 0.2, t, face=False)
    assert s.message == "no_face"
    run_setup(s, 1.0, t)                             # 다시 2초를 채워야 함
    assert s.step == "lens"


# --- 음량 VAD ---
def feed_vad(vad, sec, rms, t):
    for _ in range(round(sec / 0.03)):
        t += 0.03
        vad.feed(t, rms)
    return t


def test_energy_vad_on_off_with_hysteresis():
    v = EnergyVad()
    t = feed_vad(v, 1.1, 0.01, 0.0)                  # 소음 측정
    assert v.noise == pytest.approx(0.01)
    t = feed_vad(v, 0.1, 0.05, t)                    # 0.15초 미만 → 아직 말 아님
    assert not v.speaking
    t = feed_vad(v, 0.2, 0.05, t)
    assert v.speaking
    t = feed_vad(v, 0.2, 0.005, t)                   # 0.3초 미만 조용 → 아직 말함
    assert v.speaking
    feed_vad(v, 0.2, 0.005, t)
    assert not v.speaking


def test_energy_vad_ignores_short_tap():
    v = EnergyVad()
    t = feed_vad(v, 1.1, 0.01, 0.0)
    t = feed_vad(v, 0.06, 0.2, t)                    # 책상 두드림
    feed_vad(v, 0.5, 0.01, t)
    assert not v.speaking
