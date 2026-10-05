"""6단계 테스트: 웹 화면용 엔진(CoachSession)과 로컬 서버. 웹캠 없이 돈다. 실행: pytest -q"""
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import web_server
from coach_engine import CoachSession

FPS = 30
DT = 1 / FPS
GOOD_BOX = {"cx": 0.5, "cy": 0.5, "w": 0.30}


class Feeder:
    def __init__(self, **kw):
        self.s, self.t = CoachSession(**kw), 0.0

    def run(self, sec, yaw=0.0, pitch=0.0, face=True, speaking=None):
        for _ in range(round(sec * FPS)):
            self.t += DT
            info = {"yaw": yaw, "pitch": pitch, "roll": 0.0, "blink_l": 0.0, "blink_r": 0.0} if face else None
            self.s.feed(self.t, info, GOOD_BOX if face else None, speaking)
        return self.s.state(self.t)


def finish_setup(f, pitch=0.0):
    f.run(1.2)
    f.run(2.8, pitch=pitch)
    f.run(2.8, pitch=pitch)
    assert f.s.phase == "ready"


def test_starts_in_setup_and_cannot_practice_yet():
    f = Feeder()
    state = f.run(0.5)
    assert state["phase"] == "setup"
    assert state["setup"]["message"]
    assert not f.s.start(f.t, "질문")


def test_setup_then_practice_shows_card_in_pause():
    f = Feeder()
    finish_setup(f)
    assert f.s.start(f.t, "자기소개")
    f.run(3, yaw=30, speaking=True)                    # 말하면서 고개 돌림 → 대기
    assert f.s.state(f.t)["cards"] == []
    state = f.run(0.8, yaw=30, speaking=False)         # 쉬는 순간에 표시
    assert [c["name"] for c in state["cards"]] == ["turn"]
    assert state["question"] == "자기소개"


def test_card_has_plain_title_and_posture():
    f = Feeder(no_audio=True)
    finish_setup(f)
    assert f.run(0.2)["posture"] == "좋아요"
    f.s.start(f.t)
    state = f.run(2.5, yaw=30)
    assert state["posture"] == "옆을 보고 있어요"
    assert state["cards"][0]["title"] == "정면을 봐 주세요!"
    assert state["cards"][0]["detail"]


def test_extra_alert_from_voice_side():
    """음성 쪽이 넣는 '말이 너무 빠릅니다!'도 같은 규칙(쉴 때만)으로 뜬다"""
    f = Feeder()
    finish_setup(f)
    f.s.start(f.t)
    for _ in range(round(2 * FPS)):
        f.t += DT
        f.s.feed(f.t, {"yaw": 0, "pitch": 0, "roll": 0, "blink_l": 0, "blink_r": 0}, GOOD_BOX, True, ["fast"])
    assert f.s.state(f.t)["cards"] == []
    for _ in range(round(0.8 * FPS)):
        f.t += DT
        f.s.feed(f.t, {"yaw": 0, "pitch": 0, "roll": 0, "blink_l": 0, "blink_r": 0}, GOOD_BOX, False, ["fast"])
    assert f.s.state(f.t)["cards"][0]["title"] == "말이 너무 빠릅니다!"


def test_no_cards_before_practice_starts():
    f = Feeder(no_audio=True)
    finish_setup(f)
    state = f.run(3, yaw=30)
    assert state["phase"] == "ready" and state["cards"] == []


def test_report_after_stop():
    f = Feeder(no_audio=True)
    finish_setup(f)
    f.s.start(f.t, "지원 동기")
    f.run(3, yaw=30)
    f.run(2)
    report = f.s.stop(f.t)
    assert report["question"] == "지원 동기"
    assert report["duration_s"] == pytest.approx(5.0, abs=0.1)
    turn = next(c for c in report["cards"] if c["name"] == "turn")
    assert turn["shown"] == 1
    held = next(h for h in report["held_s"] if h["name"] == "turn")
    assert held["seconds"] > 0
    assert f.s.phase == "ready"
    assert f.s.stop(f.t) is None                       # 두 번 끝내도 오류 없음


def test_redo_setup_during_practice_ends_it():
    f = Feeder(no_audio=True)
    finish_setup(f)
    f.s.start(f.t)
    f.run(1)
    f.s.redo_setup(f.t)
    assert f.s.phase == "setup"
    assert f.s.last_report is not None


def test_screen_pose_is_front_after_setup():
    f = Feeder()
    finish_setup(f, pitch=12.0)                        # 카메라가 낮아 화면을 볼 때 12° 숙임
    state = f.run(0.5, pitch=12.0)
    assert state["angles"]["pitch"] == pytest.approx(0.0)


# --- 서버 ---
class FakeEngine:
    def __init__(self):
        self.calls = []

    def state(self):
        return {"phase": "ready", "fps": 30.0}

    def command(self, action, **kw):
        self.calls.append((action, kw))
        return {"ok": True}

    def wait_frame(self, last_id, timeout=1.0):
        return last_id + 1, b"\xff\xd8\xff\xd9"


@pytest.fixture
def server():
    engine = FakeEngine()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), web_server.make_handler(engine))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", engine
    srv.shutdown()
    srv.server_close()


def get(url):
    with urllib.request.urlopen(url, timeout=3) as r:
        return r.status, r.headers.get("Content-Type"), r.read()


def test_serves_page_and_assets(server):
    base, _ = server
    status, ctype, body = get(base + "/")
    assert status == 200 and "text/html" in ctype and "LocalCoach".encode() in body
    for path in ("/app.js", "/style.css"):
        assert get(base + path)[0] == 200


def test_blocks_path_outside_web_dir(server):
    base, _ = server
    with pytest.raises(urllib.error.HTTPError) as e:
        get(base + "/../web_server.py")
    assert e.value.code == 404


def test_questions_and_state(server):
    base, _ = server
    assert json.loads(get(base + "/api/questions")[2])["questions"]
    assert json.loads(get(base + "/api/state")[2])["phase"] == "ready"


def test_command_is_forwarded(server):
    base, engine = server
    req = urllib.request.Request(base + "/api/command", method="POST",
                                 data=json.dumps({"action": "start", "question": "자기소개"}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3) as r:
        assert json.loads(r.read())["ok"]
    assert engine.calls == [("start", {"question": "자기소개"})]


def test_events_stream_sends_state(server):
    base, _ = server
    with urllib.request.urlopen(base + "/events", timeout=3) as r:
        line = r.readline().decode()
    assert line.startswith("data: ") and json.loads(line[6:])["phase"] == "ready"


def test_server_listens_on_localhost_only():
    assert "127.0.0.1" in open(web_server.__file__, encoding="utf-8").read().split("ThreadingHTTPServer((")[1][:20]
