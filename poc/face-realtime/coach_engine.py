"""6단계: 웹 화면용 분석 엔진

step5_coaching.py의 판정(카메라 설정 → 규칙 → 쉴 때만 경고)을 화면 그리기와 분리했다.
- CoachSession: 한 프레임의 분석 결과를 받아 상태를 갱신하는 순수 로직. 웹캠 없이 테스트할 수 있다.
- CoachEngine: 웹캠·마이크를 백그라운드 스레드에서 읽어 CoachSession에 넣고,
  웹 서버가 가져갈 최신 JPEG 프레임과 상태(dict)를 보관한다.

웹 서버(web_server.py)는 이 엔진의 값을 브라우저로 보내기만 하고 판정은 하지 않는다.
"""
import threading
import time

import eval_report
from camera_setup import MESSAGES, CameraSetup
from eval_recorder import TASKS, Recorder
from feedback_gate import FeedbackGate
from step3_coaching import ALERTS, HOLD_SEC, CoachRules

COACH_ALERTS = {k: v for k, v in ALERTS.items() if k != "blink"}  # 깜빡임은 기록만 (step5와 같음)
COACH_ALERTS["shift"] = "가운데로 앉아 주세요!"
# ponytail: 몸이 옆으로 가면 고개를 안 돌려도 yaw가 돌아간 것처럼 나온다. 보정 계수를 재기 전까지는
# 이만큼(화면 폭 비율) 벗어나면 yaw를 믿지 않고 '치우침'으로 안내한다. 실측 후 yaw 보정으로 바꿀 것.
SHIFT_TOL = 0.12
JPEG_QUALITY = 75


class CoachSession:
    """카메라 설정 → 연습(규칙 + 쉴 때만 경고)을 진행한다. 시각 t는 호출하는 쪽이 정한다."""

    def __init__(self, no_audio=False):
        self.no_audio = no_audio
        self.setup = CameraSetup()
        self.rules = CoachRules()
        self.gate = FeedbackGate(no_audio=no_audio)
        self.practicing = False
        self.question = None
        self.started_at = None
        self.ended_at = None
        self.shown = []
        self.angles = None
        self.shift_since = None
        self.active = []  # 지금 기준에 걸려 있는 자세 (카드 표시 여부와 무관, 화면의 '자세' 칸용)
        self.speaking = None
        self.last_report = None

    @property
    def phase(self):
        if self.setup.active:
            return "setup"
        return "practice" if self.practicing else "ready"

    def redo_setup(self, t):
        self.stop(t)
        self.setup.restart()
        self.rules.reset_timers()

    def skip_position(self):
        self.setup.skip_position()

    def start(self, t, question=None):
        """연습 시작: 판정 기록을 새로 시작한다. 카메라 설정이 끝나야 시작할 수 있다."""
        if self.setup.active:
            return False
        self.rules = CoachRules()
        self.gate = FeedbackGate(no_audio=self.no_audio)
        self.practicing, self.question = True, question
        self.started_at, self.ended_at = t, None
        self.shown = []
        return True

    def stop(self, t):
        """연습 종료: 리포트를 만들어 돌려준다. 연습 중이 아니면 None."""
        if not self.practicing:
            return None
        self.rules.finish(t)
        self.gate.finish(t)
        self.practicing, self.ended_at, self.shown = False, t, []
        self.last_report = self.report()
        return self.last_report

    def feed(self, t, info, box, speaking):
        """한 프레임 처리. info: analyze() 결과(없으면 None), box: face_box() 결과."""
        self.speaking = speaking
        self.debug = {"yaw_raw": info["yaw"], "ray_yaw": info.get("ray_yaw"), "cx": box["cx"]} if info and box else None
        if self.setup.active:
            self.setup.feed(t, info, box)
            self.angles = None
            self.active = []
            return
        self.angles = self.setup.apply(info) if info else None
        shifted = bool(box) and self.setup.base_cx is not None and abs(box["cx"] - self.setup.base_cx) > SHIFT_TOL
        self.shift_since = (self.shift_since if self.shift_since is not None else t) if shifted else None
        angles = dict(self.angles, yaw=0.0) if shifted else self.angles  # 치우친 동안의 yaw는 돌림으로 세지 않음
        self.active = active = [k for k in self.rules.update(t, angles, info) if k != "blink"]
        if shifted and t - self.shift_since >= HOLD_SEC:
            active.append("shift")
        if self.practicing:
            self.shown = self.gate.update(t, active, speaking)

    def report(self):
        """연습 결과: 길이, 경고별 표시·보류 횟수, 자세 이탈 시간, 카메라 진단"""
        start, end = self.started_at, self.ended_at
        cards = {}
        for _, name, outcome, _ in self.gate.log:
            row = cards.setdefault(name, {"shown": 0, "report_only": 0, "dropped": 0, "suppressed": 0})
            row[outcome] += 1
        held = {}
        for name, s, e in self.rules.events:
            if name in COACH_ALERTS:
                held[name] = round(held.get(name, 0.0) + e - s, 1)
        return {
            "question": self.question,
            "duration_s": round(end - start, 1) if start is not None and end is not None else 0.0,
            "cards": [dict(name=k, label=COACH_ALERTS.get(k, k), **v) for k, v in cards.items()],
            "held_s": [{"name": k, "label": COACH_ALERTS[k], "seconds": v} for k, v in held.items()],
            "total_blinks": self.rules.total_blinks,
            "setup": self.setup.summary(),
            "log": [{"t": round(t - start, 2), "name": n, "outcome": o, "reason": r}
                    for t, n, o, r in self.gate.log],
            "no_audio": self.no_audio,
        }

    def state(self, t):
        """브라우저로 보낼 현재 상태"""
        out = {
            "phase": self.phase,
            "speaking": self.speaking,
            "no_audio": self.no_audio,
            "setup": {
                "step": self.setup.step,
                "message": MESSAGES[self.setup.message],
                "warnings": [MESSAGES[w] for w in self.setup.warnings],
            },
            "cards": [{"name": k, "label": COACH_ALERTS[k]} for k in self.shown],
            "active": list(self.active),
            "pending": list(self.gate.pending) if self.practicing else [],
            "elapsed_s": round(t - self.started_at, 1) if self.practicing else None,
            "question": self.question,
        }
        out["debug"] = getattr(self, "debug", None)  # 임시: 좌우 이동 보정값 측정용
        if self.angles:
            out["angles"] = {k: round(v, 1) for k, v in self.angles.items()}
        return out


def frame_row(info, box, speaking, voice, proc_ms, active):
    """평가 녹화의 frames.csv 한 줄 (eval_recorder.FRAME_COLS)"""
    row = {"proc_ms": proc_ms, "face": info is not None, "speaking": speaking, "active": "|".join(active),
           "db": voice.get("db"), "rate_spm": voice.get("rate_spm"), "filler": voice.get("filler")}
    if info:
        row.update(yaw_raw=info["yaw"], pitch_raw=info["pitch"], gaze_x=info.get("gaze_x"),
                   gaze_y=info.get("gaze_y"), blink=max(info["blink_l"], info["blink_r"]))
    if box:
        row["cx"] = box["cx"]
    return row


class CoachEngine:
    """웹캠·마이크를 읽어 CoachSession을 돌리는 백그라운드 스레드"""

    def __init__(self, camera=0, use_mic=True):
        self.camera = camera
        self.use_mic = use_mic
        self.lock = threading.Lock()
        self.frame_ready = threading.Condition(self.lock)
        self.jpeg = None
        self.frame_id = 0
        self.error = None
        self.mic_error = None
        self.fps = 0.0
        self.session = None
        self.speech = None
        self.voice = {}           # 음성 상태 (말 속도, 군말)
        self.recorder = None      # 평가 녹화 중이면 Recorder
        self._stop = threading.Event()
        self._start = time.perf_counter()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def now(self):
        return time.perf_counter() - self._start

    def start(self):
        self._thread.start()

    def close(self):
        self._stop.set()
        self._thread.join(timeout=3)

    def command(self, action, **kw):
        """브라우저 버튼 → 엔진. 돌려주는 값은 그대로 JSON 응답이 된다."""
        if action == "eval_stop":
            with self.lock:
                rec, self.recorder = self.recorder, None
                if rec is None:
                    return {"ok": False, "error": "녹화 중이 아닙니다"}
                if self.speech:
                    self.speech.sink = None
                rec.close(self.now())
            try:  # 표 계산은 잠금 밖에서 (영상이 멈추지 않게)
                text = eval_report.report(rec.dir)
            except Exception as e:
                text = f"녹화는 저장했지만 결과 계산에 실패했습니다: {e}"
            return {"ok": True, "dir": str(rec.dir), "report": text}
        with self.lock:
            s = self.session
            if s is None:
                return {"ok": False, "error": self.error or "카메라를 준비하는 중입니다"}
            t = self.now()
            if action == "redo_setup":
                s.redo_setup(t)
            elif action == "skip_position":
                s.skip_position()
            elif action == "start":
                if not s.start(t, kw.get("question")):
                    return {"ok": False, "error": "카메라 설정을 먼저 끝내 주세요"}
            elif action == "stop":
                return {"ok": True, "report": s.stop(t) or s.last_report}
            elif action == "report":
                return {"ok": True, "report": s.last_report}
            elif action == "eval_start":
                if kw.get("task") not in TASKS or self.recorder is not None:
                    return {"ok": False, "error": "평가를 시작할 수 없습니다 (이미 녹화 중이거나 없는 과제)"}
                self.recorder = Recorder(kw["task"], t)
                if self.speech:
                    self.speech.sink = self.recorder.audio
                return {"ok": True, "dir": str(self.recorder.dir), "no_audio": self.speech is None}
            elif action == "eval_mark":
                if self.recorder is not None:
                    self.recorder.mark(t, kw.get("name"), str(kw.get("note", "")))
            else:
                return {"ok": False, "error": f"알 수 없는 명령: {action}"}
            return {"ok": True}

    def state(self):
        with self.lock:
            if self.session is None:
                return {"phase": "loading", "error": self.error}
            out = self.session.state(self.now())
            out["fps"] = round(self.fps, 1)
            out["mic_error"] = self.mic_error
            out["voice"] = self.voice
            out["recording"] = self.recorder.dir.name if self.recorder else None
            out["error"] = self.error
            return out

    def wait_frame(self, last_id, timeout=1.0):
        """새 프레임이 나올 때까지 기다렸다가 (frame_id, jpeg)를 돌려준다."""
        with self.frame_ready:
            self.frame_ready.wait_for(lambda: self.frame_id != last_id or self._stop.is_set(), timeout)
            return self.frame_id, self.jpeg

    def _run(self):
        # 무거운 모듈은 스레드 안에서 불러 서버가 먼저 뜨게 한다
        try:
            import cv2

            from camera_setup import face_box
            from speech_state import MicSpeechState
            from step2_face_landmarks import analyze, create_landmarker, ensure_model, to_mp_image

            ensure_model()
            cap = cv2.VideoCapture(self.camera)
            if not cap.isOpened():
                raise RuntimeError("웹캠을 열 수 없습니다. 다른 프로그램이 카메라를 쓰고 있지 않은지 확인하세요.")
        except Exception as e:
            with self.lock:
                self.error = str(e)
            print("엔진 시작 실패:", e)
            return

        speech = MicSpeechState() if self.use_mic else None
        if speech is not None and not speech.available:
            self.mic_error = speech.error
            print(f"마이크를 열지 못해 음성 없이 진행합니다: {speech.error}")
            speech = None
        with self.lock:
            self.speech = speech
            self.session = CoachSession(no_audio=speech is None)

        last_ts, last_t = -1, None
        try:
            with create_landmarker(video=True) as landmarker:
                while not self._stop.is_set():
                    ok, frame = cap.read()
                    if not ok:
                        with self.lock:
                            self.error = "웹캠 프레임을 읽지 못했습니다"
                        break
                    raw, frame = frame, cv2.flip(frame, 1)
                    t = self.now()
                    ts = max(int(t * 1000), last_ts + 1)
                    last_ts = ts
                    result = landmarker.detect_for_video(to_mp_image(frame), ts)
                    info = analyze(result)
                    proc_ms = (self.now() - t) * 1000
                    box = face_box(result)
                    speaking = speech.speaking if speech else None
                    voice = speech.voice() if speech else {}
                    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                    with self.frame_ready:
                        self.session.feed(t, info, box, speaking)
                        self.voice = voice
                        if self.recorder is not None:
                            self.recorder.frame(t, raw, frame_row(info, box, speaking, voice, proc_ms,
                                                                  self.session.active))
                        if last_t is not None and t > last_t:
                            self.fps = 0.9 * self.fps + 0.1 / (t - last_t)
                        last_t = t
                        if ok:
                            self.jpeg = buf.tobytes()
                            self.frame_id += 1
                        self.frame_ready.notify_all()
        except Exception as e:  # 분석 중 오류도 화면에 보이게 한다 (스레드가 조용히 죽지 않게)
            with self.lock:
                self.error = f"분석 엔진 오류: {e}"
            print("분석 엔진 오류:", e)
        finally:
            cap.release()
            if self.recorder is not None:
                self.recorder.close(self.now())
            if speech:
                speech.close()
            with self.frame_ready:
                self.frame_ready.notify_all()
