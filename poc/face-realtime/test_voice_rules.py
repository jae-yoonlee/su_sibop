"""7단계 테스트: 음성 경고 규칙. 마이크 없이 돈다. 실행: pytest -q"""
from voice_rules import VoiceRules

FPS = 30
DT = 1 / FPS


class Feeder:
    def __init__(self):
        self.r, self.t, self.seen = VoiceRules(), 0.0, set()

    def run(self, sec, speaking, db=-20.0):
        out = []
        for _ in range(round(sec * FPS)):
            self.t += DT
            out = self.r.update(self.t, speaking, db)
            self.seen.update(out)
        return out


def test_no_stuck_before_first_word():
    f = Feeder()
    assert f.run(10, False) == []                  # 질문 듣고 생각하는 시간은 막힘 아님


def test_stuck_after_4s_silence_then_clears():
    f = Feeder()
    f.run(3, True)
    assert f.run(3.5, False) == []
    assert f.run(1, False) == ["stuck"]
    assert f.run(0.5, True) == []                  # 다시 말하면 바로 꺼짐


def test_short_pauses_never_stuck():
    f = Feeder()
    for _ in range(10):
        f.run(2, True)
        f.run(2.5, False)
    assert "stuck" not in f.seen


def test_stuck_cooldown():
    f = Feeder()
    f.run(2, True)
    f.run(5, False)                                # 1번째 막힘
    f.run(2, True)
    assert f.run(5, False) == []                   # 30초 안이라 안 켬
    f.run(25, True)
    assert f.run(5, False) == ["stuck"]


def test_quiet_after_level_drop():
    f = Feeder()
    f.run(18.5, True, db=-20)                      # 기준 -20dB, 창도 큰 목소리로 채움
    assert f.r.baseline_db == -20
    assert f.run(9, True, db=-28) == []            # 몇 초 작아진 것으로는 안 켬
    assert f.run(3, True, db=-28) == ["quiet"]     # 작아진 뒤 약 10초
    f.run(10, True, db=-21)                        # 회복하면 꺼짐
    assert "quiet" not in f.r.update(f.t + DT, True, -21)


def test_small_drop_is_not_quiet():
    f = Feeder()
    f.run(8.5, True, db=-20)
    f.run(20, True, db=-24)                        # 4dB 작음 → 기준(6dB) 미달
    assert "quiet" not in f.seen


def test_silence_does_not_count_as_quiet():
    f = Feeder()
    f.run(8.5, True, db=-20)
    f.run(20, False, db=-60)                       # 쉬는 동안 음량은 판정에 안 씀
    assert "quiet" not in f.seen


def test_no_mic_no_alerts():
    f = Feeder()
    assert f.run(20, None) == []


def test_summary():
    f = Feeder()
    f.run(8.5, True, db=-20)
    f.run(5, False)
    f.r.finish(f.t)
    s = f.r.summary()
    assert s["baseline_db"] == -20 and s["stuck_count"] == 1
