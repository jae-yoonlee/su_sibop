"""8단계: 소리로 잡는 실시간 군말 — "음—", "어—"처럼 길게 끄는 소리를 글자 변환 없이 찾는다

보통 말은 음절마다(0.15~0.25초) 입 모양이 바뀌어 음색이 계속 변한다. 군말은 같은 소리를 끈다.
그래서 '목소리의 높이와 음색이 0.3초 이상 그대로인 구간'을 군말로 본다.
- 0.03초마다 최근 0.06초를 본다.
- 높이: 자기상관으로 구한다(75~400Hz). 주기성이 약하면 목소리가 아닌 것으로 본다.
- 음색: 0~4kHz를 16칸으로 나눈 세기(dB)에서 전체 크기를 뺀 모양.
- 높이가 구간 평균의 ±12%, 음색이 평균 3dB 안에 머무는 동안 구간을 이어 간다.
소리가 시작되고 0.3초 뒤에 켜진다(검출 지연 = 0.3초 + 조각 길이).

못 잡는 것: "그", "이제", "약간" 같은 낱말 군말(글자 변환이 필요). 잘못 잡는 것: 말끝을 길게 끄는 말투, 아주 느리게 또박또박 읽기, 노래.
기준값은 합성 음성(Windows TTS)으로만 맞춘 초기값이다. 사람 녹음(eval_report.py)으로 다시 맞춰야 한다.
"""
import numpy as np

SAMPLE_RATE = 16000
HOP_SEC = 0.03
MIN_SEC = 0.3            # 이만큼 이어져야 군말
PITCH_HZ = (75, 400)
VOICED_MIN = 0.5         # 자기상관 봉우리가 이보다 낮으면 목소리가 아님
PITCH_TOL = 0.12         # 높이가 구간 평균에서 이 비율 안 (약 반음 둘)
TIMBRE_TOL_DB = 3.0      # 음색 모양이 구간 평균에서 이 dB 안 (TTS 낭독의 음절 사이 변화는 3~7dB)
NFFT = 1024
BANDS = 16               # 0~4kHz
BAND_RANGE_DB = 40.0     # 가장 센 칸보다 이만큼 넘게 약한 칸은 같은 값으로 봄


class FillerDetector:
    def __init__(self, sr=SAMPLE_RATE):
        self.sr = sr
        self.hop = int(sr * HOP_SEC)
        self._buf = np.zeros(0, dtype=np.float32)
        self._n = 0             # 지금까지 처리한 표본 수 (시각 = _n / sr)
        self._run = None        # [시작 시각, 길이(조각 수), 평균 높이, 평균 음색]
        self.events = []        # ("filler", 시작, 끝)

    @property
    def active(self):
        return self._run is not None and self._run[1] * HOP_SEC >= MIN_SEC

    def feed(self, samples, floor_rms=0.0):
        """floor_rms: 이보다 작은 소리는 보지 않는다 (주변 소음)"""
        self._buf = np.concatenate([self._buf, samples])
        while len(self._buf) >= 2 * self.hop:
            self._step(self._buf[:2 * self.hop], floor_rms)
            self._buf = self._buf[self.hop:]
            self._n += self.hop

    def finish(self):
        self._close()

    def _step(self, x, floor_rms):
        feat = self._features(x, floor_rms)
        run = self._run
        if feat and run and abs(feat[0] / run[2] - 1) <= PITCH_TOL \
                and float(np.mean(np.abs(feat[1] - run[3]))) <= TIMBRE_TOL_DB:
            run[1] += 1
            run[2] += (feat[0] - run[2]) / run[1]
            run[3] = run[3] + (feat[1] - run[3]) / run[1]
            return
        self._close()
        if feat:
            self._run = [self._n / self.sr, 1, feat[0], feat[1]]

    def _close(self):
        if self.active:
            self.events.append(("filler", self._run[0], self._n / self.sr + HOP_SEC))
        self._run = None

    def _features(self, x, floor_rms):
        """→ (높이 Hz, 음색 모양) 또는 None(조용함·목소리 아님)"""
        if float(np.sqrt(np.mean(np.square(x)))) <= floor_rms:
            return None
        spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), NFFT)) ** 2
        ac = np.fft.irfft(spec)
        lo, hi = self.sr // PITCH_HZ[1], self.sr // PITCH_HZ[0]
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[0] <= 0 or ac[lag] / ac[0] < VOICED_MIN:
            return None
        top = int(4000 * NFFT / self.sr)
        bands = 10 * np.log10(spec[:top].reshape(BANDS, -1).sum(axis=1) + 1e-12)
        bands = np.maximum(bands, bands.max() - BAND_RANGE_DB)  # 거의 비어 있는 칸의 잡음이 음색 비교를 흔들지 않게
        return self.sr / lag, bands - bands.mean()
