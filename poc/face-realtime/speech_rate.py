"""8단계: 발화속도 — 글자 변환 없이 음량 봉우리(음절 핵)를 세어 음절 수를 어림한다

de Jong & Wempe (2009)의 방법을 줄인 것이다. 한국어는 음절마다 모음이 하나라 봉우리 하나 = 음절 하나로 본다.
- 0.01초마다 소리 세기를 구해 0.04초로 고르게 한 뒤 dB로 바꾼다.
- 가장 큰 소리(상위 1%)보다 25dB 넘게 작은 구간은 말이 아닌 것으로 본다.
- 앞 골짜기보다 2dB 이상 솟은 봉우리만 음절로 센다.
말 속도(분당 음절) = 봉우리 수 ÷ 말한 시간. 0.3초 이상 쉰 시간은 뺀다.

ponytail: 원 논문은 목소리 떨림(유성음)인 봉우리만 세지만 여기서는 음량만 본다. 'ㅅ, ㅊ' 같은 센 자음이나
주변 소음을 음절로 셀 수 있다. 낭독 녹음의 오차가 15%를 넘으면(eval_report.py) 유성음 검사를 넣거나 STT로 바꿀 것.
"""
from collections import deque

import numpy as np

SAMPLE_RATE = 16000
HOP_SEC = 0.01           # 소리 세기를 구하는 간격
SMOOTH_HOPS = 4          # 0.04초 이동 평균 (길면 빠른 말의 음절이 붙고, 짧으면 한 음절을 둘로 셈)
SILENCE_DB = 25.0        # 가장 큰 소리보다 이만큼 작으면 말이 아님
MIN_PAUSE_HOPS = 30      # 0.3초 이상 조용해야 쉼
DIP_DB = 2.0             # 봉우리 앞에 이만큼의 골짜기가 있어야 음절로 셈
WINDOW_SEC = 10.0        # 실시간 속도는 최근 이 시간으로 계산
MIN_SPEECH_SEC = 3.0     # 창 안에 이만큼은 말해야 속도를 냄


def hop_power(samples, sr=SAMPLE_RATE):
    """소리(-1~1) → 0.01초마다의 세기(제곱 평균)"""
    hop = int(sr * HOP_SEC)
    n = len(samples) // hop
    return np.mean(np.square(np.asarray(samples[:n * hop], dtype=np.float64).reshape(n, hop)), axis=1)


def syllable_peaks(power, floor_db=None):
    """세기 배열 → (음절 봉우리 위치 목록, 말한 구간 표시 배열). floor_db: 이보다 작은 소리는 소음으로 봄."""
    if len(power) < SMOOTH_HOPS:
        return [], np.zeros(len(power), dtype=bool)
    smooth = np.convolve(power, np.ones(SMOOTH_HOPS) / SMOOTH_HOPS, mode="same")
    env = 10 * np.log10(np.maximum(smooth, 1e-12))
    thr = np.percentile(env, 99) - SILENCE_DB
    if floor_db is not None:
        thr = max(thr, floor_db)
    peaks, valley = [], env[0]
    for i in range(1, len(env) - 1):
        valley = min(valley, env[i])
        if env[i] > thr and env[i] >= env[i - 1] and env[i] > env[i + 1] and env[i] - valley >= DIP_DB:
            peaks.append(i)
            valley = env[i]
    speech = np.ones(len(env), dtype=bool)   # 0.3초 이상 조용한 구간만 쉼으로 본다 (받침·파열음의 짧은 끊김은 말한 시간)
    start = None
    for i, quiet in enumerate(np.append(env <= thr, False)):
        if quiet and start is None:
            start = i
        elif not quiet and start is not None:
            if i - start >= MIN_PAUSE_HOPS:
                speech[start:i] = False
            start = None
    return peaks, speech


class SpeechRate:
    """마이크 조각을 받아 최근 10초의 말 속도(분당 음절)를 낸다."""

    def __init__(self, sr=SAMPLE_RATE):
        self.sr = sr
        self._rest = np.zeros(0, dtype=np.float32)
        self._power = deque(maxlen=int(WINDOW_SEC / HOP_SEC))

    def feed(self, samples):
        x = np.concatenate([self._rest, samples])
        hop = int(self.sr * HOP_SEC)
        n = len(x) // hop
        self._power.extend(hop_power(x, self.sr))
        self._rest = x[n * hop:]

    def rate(self, floor_db=None):
        """분당 음절 수. 말한 시간이 모자라면 None."""
        peaks, speech = syllable_peaks(np.array(self._power), floor_db)
        sec = float(speech.sum()) * HOP_SEC
        return len(peaks) / sec * 60 if sec >= MIN_SPEECH_SEC else None
