"""8단계: 평가용 녹화 — 영상·음성·프레임별 신호·지시(정답)를 한 폴더에 저장한다

recordings/<날짜-시각>-<과제>/
  video.mp4   웹캠 원본(좌우 반전 전). python web_server.py --camera video.mp4 로 다시 넣을 수 있다
  audio.wav   마이크 (16kHz, 한 채널)
  frames.csv  프레임마다 한 줄: 시각, 처리 시간, 각도, 눈동자, 음성 상태. n번째 줄 = video.mp4의 n번째 프레임
  truth.csv   지시 화면이 보여 준 지시 = 정답 (name,start,end,note). eval_events.py와 같은 형식

시각은 모두 녹화 시작부터의 초다. 얼굴 영상이 들어 있으므로 recordings/는 git에 올리지 않는다(.gitignore).
"""
import csv
import threading
import time
import wave
from pathlib import Path

import numpy as np

REC_DIR = Path(__file__).parent / "recordings"
TASKS = ("gaze", "rate", "filler")
FRAME_COLS = ["t", "proc_ms", "face", "yaw_raw", "pitch_raw", "cx", "gaze_x", "gaze_y", "blink",
              "speaking", "db", "rate_spm", "filler", "active"]
VIDEO_FPS = 30  # 파일에 적는 값일 뿐이다. 실제 프레임 시각은 frames.csv의 t


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return int(v)
    return f"{v:.4f}" if isinstance(v, float) else v


class Recorder:
    def __init__(self, task, t0, root=REC_DIR, sr=16000):
        self.dir = Path(root) / f"{time.strftime('%Y%m%d-%H%M%S')}-{task}"
        self.dir.mkdir(parents=True)
        self.t0 = t0
        self._video = None
        self._lock = threading.Lock()  # 음성은 마이크 스레드가 쓴다
        self._wav = wave.open(str(self.dir / "audio.wav"), "wb")
        self._wav.setnchannels(1)
        self._wav.setsampwidth(2)
        self._wav.setframerate(sr)
        self._files = []
        self._frames = self._writer("frames.csv", FRAME_COLS)
        self._truth = self._writer("truth.csv", ["name", "start", "end", "note"])
        self._mark = None

    def _writer(self, name, header):
        f = open(self.dir / name, "w", newline="", encoding="utf-8")
        self._files.append(f)
        w = csv.writer(f)
        w.writerow(header)
        return w

    def frame(self, t, image, row):
        """image: 웹캠 원본 프레임(BGR), row: FRAME_COLS의 값 dict (t 제외)"""
        if self._video is None:
            import cv2
            h, w = image.shape[:2]
            self._video = cv2.VideoWriter(str(self.dir / "video.mp4"), cv2.VideoWriter_fourcc(*"mp4v"),
                                          VIDEO_FPS, (w, h))
        self._video.write(image)
        self._frames.writerow([f"{t - self.t0:.4f}"] + [_fmt(row.get(c)) for c in FRAME_COLS[1:]])

    def audio(self, samples):
        """samples: -1~1 실수 배열"""
        with self._lock:
            if self._wav is not None:
                self._wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())

    def mark(self, t, name=None, note=""):
        """지시가 바뀐 시각. 앞 지시를 닫고, name이 있으면 새 지시를 연다."""
        if self._mark:
            n, start, nt = self._mark
            self._truth.writerow([n, f"{start:.3f}", f"{t - self.t0:.3f}", nt])
        self._mark = (name, t - self.t0, note) if name else None

    def close(self, t):
        self.mark(t)
        with self._lock:
            self._wav.close()
            self._wav = None
        if self._video is not None:
            self._video.release()
        for f in self._files:
            f.close()
