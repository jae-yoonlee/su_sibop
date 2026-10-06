"""8단계 테스트: 발화속도, 소리 기반 군말, 평가 녹화·채점. 마이크·웹캠 없이 합성한 소리로 돈다. 실행: pytest -q"""
import numpy as np
import pytest

from eval_recorder import Recorder
from eval_report import gaze_scores, read_csv, read_wav, report
from filler_detect import FillerDetector
from speech_rate import SpeechRate, hop_power, syllable_peaks
from voice_rules import VoiceRules

SR = 16000


def vowel(sec, f0=150.0, glide=0.0):
    """목소리 비슷한 소리: 기본음 + 배음. glide: 초당 높이 변화 비율"""
    t = np.arange(int(sec * SR)) / SR
    phase = 2 * np.pi * f0 * (t + glide * t * t / 2)
    return sum(np.sin(k * phase) / k for k in range(1, 8)).astype(np.float32) * 0.2


def syllables(n, per_sec, f0=150.0):
    """음절 n개: 음절마다 음량이 솟았다 꺼지고, 높이가 번갈아 바뀐다"""
    out = []
    for i in range(n):
        x = vowel(1 / per_sec, f0 * (1.0 if i % 2 else 1.3))
        out.append(x * np.hanning(len(x)).astype(np.float32))
    return np.concatenate(out)


SILENCE = np.zeros(SR // 2, dtype=np.float32)


# ---------- 발화속도 ----------

@pytest.mark.parametrize("per_sec", [3, 5, 7])
def test_counts_syllables(per_sec):
    peaks, speech = syllable_peaks(hop_power(syllables(30, per_sec), SR))
    assert abs(len(peaks) - 30) <= 1
    assert speech.any()


def test_streaming_rate_ignores_pauses():
    r = SpeechRate(SR)
    audio = np.concatenate([syllables(20, 5), np.zeros(4 * SR, dtype=np.float32), syllables(10, 5)])
    for i in range(0, len(audio), 480):
        r.feed(audio[i:i + 480])
    assert r.rate() == pytest.approx(5 * 60, rel=0.25)   # 4초 쉬어도 말한 시간 기준으로는 초당 5음절


def test_rate_unknown_until_enough_speech():
    r = SpeechRate(SR)
    r.feed(syllables(5, 5))
    assert r.rate() is None


def test_fast_alert_needs_baseline_then_uses_it():
    v, t = VoiceRules(), 0.0

    def run(sec, rate):
        nonlocal t
        out = []
        for _ in range(int(sec * 10)):
            t += 0.1
            out = v.update(t, True, -20.0, rate)
        return out

    assert "fast" not in run(15, 450)        # 처음 20초는 기준을 재는 중이라 켜지 않음
    v, t = VoiceRules(), 0.0
    run(21, 300)
    assert v.rate_baseline == 300
    assert "fast" not in run(5, 320)
    assert "fast" in run(1, v.rate_baseline * 1.3)
    assert "fast" in run(1, v.rate_baseline * 1.15)    # 기준 +10% 위에서는 유지
    assert "fast" not in run(1, v.rate_baseline)
    assert "fast" in run(1, 410)             # 분당 400 이상은 기준과 무관하게


# ---------- 군말 ----------

def detect(audio):
    d = FillerDetector(SR)
    flags = []
    for i in range(0, len(audio) - 479, 480):
        d.feed(audio[i:i + 480], 0.001)
        flags.append(d.active)
    d.finish()
    return d.events, flags


def test_held_vowel_is_filler_and_fires_after_300ms():
    events, flags = detect(np.concatenate([SILENCE, vowel(0.8), SILENCE]))
    assert len(events) == 1
    name, start, end = events[0]
    assert name == "filler" and start == pytest.approx(0.5, abs=0.07) and end - start == pytest.approx(0.8, abs=0.1)
    first_on = flags.index(True) * 0.03
    assert first_on - 0.5 == pytest.approx(0.33, abs=0.07)   # 검출 지연 = 0.3초 + 조각


def test_normal_syllables_and_short_sounds_are_not_fillers():
    assert detect(np.concatenate([SILENCE, syllables(20, 5), SILENCE]))[0] == []
    assert detect(np.concatenate([SILENCE, vowel(0.2), SILENCE]))[0] == []
    assert detect(np.concatenate([SILENCE, vowel(0.8, glide=2.0), SILENCE]))[0] == []   # 높이가 계속 오르는 소리
    noise = np.random.default_rng(0).normal(0, 0.1, SR).astype(np.float32)
    assert detect(noise)[0] == []


# ---------- 눈동자 채점 ----------

CENTERS = {"center": (0, 0), "left": (-0.4, 0), "right": (0.4, 0), "up": (0, 0.3), "down": (0, -0.3)}


def gaze_run(noise, lag=0.3):
    """3바퀴. 지시가 바뀌고 lag초 뒤에 눈이 옮겨 간다."""
    rng, segs, frames, t, prev = np.random.default_rng(1), [], [], 0.0, "center"
    for rnd in (1, 2, 3):
        for d in CENTERS:
            segs.append((d, rnd, t, t + 3))
            for i in range(90):
                cx, cy = CENTERS[prev if i / 30 < lag else d]
                frames.append((t + i / 30, cx + rng.normal(0, noise), cy + rng.normal(0, noise)))
            t, prev = t + 3, d
    return segs, frames


def test_gaze_scores_clean_signal():
    g = gaze_scores(*gaze_run(noise=0.03))
    assert g["frame_acc"] > 0.98 and g["seg_acc"] == 1.0
    assert g["segments"] == 10                       # 1바퀴째는 기준 잡기에 쓰고 채점하지 않음
    assert g["delay_p50"] == pytest.approx(0.3 + 4 / 30, abs=0.05)


def test_gaze_scores_noisy_signal_is_worse():
    g = gaze_scores(*gaze_run(noise=0.3))
    assert g["frame_acc"] < 0.8


def test_gaze_scores_without_calibration():
    assert gaze_scores([("left", 2, 0, 3)], [(1.5, 0.0, 0.0)]) is None


# ---------- 녹화 → 채점 ----------

def test_recording_folder_roundtrip(tmp_path):
    rec = Recorder("rate", t0=100.0, root=tmp_path)
    image = np.zeros((48, 64, 3), dtype=np.uint8)
    speech = syllables(20, 5)
    rec.mark(100.5, "read", "pace=보통으로;syll=20")
    for i in range(150):                              # 5초
        t = 100.0 + i / 30
        rec.frame(t, image, {"proc_ms": 15.0, "face": True, "gaze_x": 0.1, "gaze_y": 0.0, "blink": 0.0, "active": ""})
    rec.audio(np.concatenate([SILENCE, speech, SILENCE]))
    rec.mark(104.5)
    rec.close(105.0)

    truth = read_csv(rec.dir / "truth.csv")
    assert [(r["name"], r["start"], r["end"]) for r in truth] == [("read", "0.500", "4.500")]
    assert len(read_csv(rec.dir / "frames.csv")) == 150
    audio, sr = read_wav(rec.dir / "audio.wav")
    assert sr == SR and len(audio) == len(speech) + SR
    assert (rec.dir / "video.mp4").stat().st_size > 0

    text = report(rec.dir)
    assert "발화속도" in text and "| 보통으로 | 20 |" in text
    assert "얼굴 분석 처리 시간: 중앙값 15.00ms" in text
    assert (rec.dir / "report.md").read_text(encoding="utf-8") == text
