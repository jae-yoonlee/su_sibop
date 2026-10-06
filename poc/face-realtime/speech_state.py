"""5단계: '지금 말하는 중인가'를 FeedbackGate에 알려 주는 임시 음성 감지

음성 기능을 본격적으로 만들기 전까지 쓰는 자리표시자다. 마이크 음량(RMS)만 보고
말함/안 말함을 정하므로 키보드·팬 소리도 말로 잡을 수 있다. 음성 담당이 Silero VAD로
교체할 때는 같은 인터페이스(speaking 속성: True/False/None)만 지키면 된다.

- 시작 1초 동안 주변 소음 크기를 재서 기준으로 삼는다.
- 소음보다 일정 배 이상 크면 말함, 작아지면 0.3초 뒤에 안 말함으로 바꾼다 (두 기준을 달리 둬 깜빡임 방지).
- sounddevice가 없거나 마이크를 못 열면 None을 돌려주고, 그러면 FeedbackGate는 음성 없이 동작한다.
"""
import math
import threading
import time

import numpy as np

from filler_detect import FillerDetector
from speech_rate import SpeechRate

SAMPLE_RATE = 16000
BLOCK_SEC = 0.03         # 30ms 단위로 음량 계산
NOISE_SEC = 1.0          # 시작할 때 소음 측정 시간
ON_RATIO = 3.0           # 소음 RMS의 이 배수를 넘으면 말함
OFF_RATIO = 2.0          # 이 배수 아래로 떨어진 상태가 OFF_HOLD_SEC 이어지면 안 말함
MIN_ON_SEC = 0.15        # 이보다 짧은 소리는 말로 보지 않음 (책상 두드림 등)
OFF_HOLD_SEC = 0.3


class EnergyVad:
    """음량 기반 말함/안 말함 판정기. 마이크 없이도 feed()로 테스트할 수 있다."""

    def __init__(self):
        self.noise = None
        self._noise_samples = []
        self.speaking = False
        self._above_since = None
        self._below_since = None

    def feed(self, t, rms):
        if self.noise is None:
            self._noise_samples.append(rms)
            if len(self._noise_samples) * BLOCK_SEC >= NOISE_SEC:
                self.noise = max(float(np.median(self._noise_samples)), 1e-4)
            return self.speaking
        if not self.speaking:
            if rms > self.noise * ON_RATIO:
                self._above_since = self._above_since if self._above_since is not None else t
                if t - self._above_since >= MIN_ON_SEC:
                    self.speaking, self._below_since = True, None
            else:
                self._above_since = None
        else:
            if rms < self.noise * OFF_RATIO:
                self._below_since = self._below_since if self._below_since is not None else t
                if t - self._below_since >= OFF_HOLD_SEC:
                    self.speaking, self._above_since = False, None
            else:
                self._below_since = None
        return self.speaking


class MicSpeechState:
    """마이크를 백그라운드에서 읽어 speaking 속성을 갱신한다."""

    def __init__(self, device=None):
        self.vad = EnergyVad()
        self.rate = SpeechRate(SAMPLE_RATE)       # 말 속도 (8단계)
        self.filler = FillerDetector(SAMPLE_RATE)  # 길게 끄는 군말 (8단계)
        self.db = None            # 방금 조각의 음량(dBFS)
        self.sink = None          # 평가 녹음용: 조각(실수 배열)을 받는 함수
        self.available = False
        self.error = None
        self._stream = None
        self._lock = threading.Lock()
        self._start = time.perf_counter()
        try:
            import sounddevice as sd
            self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, device=device,
                                          blocksize=int(SAMPLE_RATE * BLOCK_SEC), callback=self._callback)
            self._stream.start()
            self.available = True
        except Exception as e:  # sounddevice 미설치, 마이크 없음, 권한 거부 등
            self.error = str(e)

    def _callback(self, data, frames, time_info, status):
        x = data[:, 0].copy()
        rms = float(np.sqrt(np.mean(np.square(x))))
        with self._lock:
            self.vad.feed(time.perf_counter() - self._start, rms)
            self.db = 20 * math.log10(max(rms, 1e-6))
            self.rate.feed(x)
            if self.vad.noise is not None:
                self.filler.feed(x, self.vad.noise * ON_RATIO)
        sink = self.sink
        if sink is not None:
            sink(x)

    @property
    def calibrating(self):
        return self.available and self.vad.noise is None

    @property
    def speaking(self):
        if not self.available or self.calibrating:
            return None
        with self._lock:
            return self.vad.speaking

    def voice(self):
        """화면·기록용 음성 상태: 음량, 말 속도(분당 음절), 지금 군말 중인지, 지금까지 군말 수"""
        with self._lock:
            noise = self.vad.noise
            floor = None if noise is None else 20 * math.log10(noise * OFF_RATIO)
            return {"db": self.db, "rate_spm": self.rate.rate(floor),
                    "filler": self.filler.active, "filler_count": len(self.filler.events)}

    def close(self):
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
