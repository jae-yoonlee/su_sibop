"""8단계: 평가 녹화 폴더 → 기능별 정확도·지연 표 (설계서 11절)

지시 화면(/eval.html)으로 녹화한 폴더 하나를 읽어, 정답(truth.csv)과 비교한 결과를 낸다.
음성 항목은 audio.wav를 다시 분석하므로 기준값을 바꾼 뒤 같은 녹음으로 다시 잴 수 있다.

- 눈동자 5방향: 1바퀴째로 사람별 기준(방향별 중심)을 잡고, 2바퀴째부터 가장 가까운 중심으로 방향을 맞힌다.
  지시가 바뀐 뒤 1초(눈이 옮겨 가는 시간)와 깜빡인 프레임은 정확도에서 뺀다.
- 발화속도: 낭독 구간마다 센 음절 수 ÷ 구간 길이를 실제(대본 음절 수 ÷ 구간 길이)와 비교한다.
- 군말: 지시한 "음—" 구간을 잡았는지, 낭독 구간에서 잘못 잡았는지.

실행: python eval_report.py recordings/20261006-153000-gaze
"""
import csv
import sys
import time
import wave
from collections import Counter
from pathlib import Path
from statistics import median

import numpy as np

from eval_events import latency_summary, percentile, rate_error, score
from filler_detect import HOP_SEC as FILLER_HOP
from filler_detect import MIN_SEC as FILLER_MIN_SEC
from filler_detect import FillerDetector
from speech_rate import HOP_SEC, hop_power, syllable_peaks

SETTLE_SEC = 1.0         # 지시가 바뀐 뒤 이 시간은 정확도에서 뺌
BLINK_MAX = 0.5          # 깜빡임 점수가 이 이상인 프레임은 뺌
LATENCY_FRAMES = 5       # 이만큼 연속으로 맞아야 '판정이 켜졌다'고 봄
NOISE_RATIO = 3.0        # 녹음의 조용한 구간(하위 10%)의 이 배수까지는 소음


def read_csv(path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
        return data, w.getframerate()


def note_value(row, key):
    """note 칸의 'pace=빠르게;syll=58'에서 값 하나"""
    return dict(p.split("=", 1) for p in row["note"].split(";") if "=" in p).get(key)


def _f(v, unit=""):
    return "-" if v is None else f"{v:.2f}{unit}"


# ---------- 눈동자 ----------

def gaze_scores(segments, frames):
    """segments: [(방향, 바퀴, 시작, 끝)], frames: [(t, gaze_x, gaze_y)] (얼굴 없음·깜빡임은 미리 뺀 것)"""
    def points(s, e):
        return [(x, y) for t, x, y in frames if s <= t < e]

    cal = {}
    for d, rnd, s, e in segments:
        if rnd == 1:
            cal.setdefault(d, []).extend(points(s + SETTLE_SEC, e))
    centers = {d: np.median(np.array(p), axis=0) for d, p in cal.items() if p}
    names = sorted(centers)
    if len(names) < 2:
        return None
    grid = np.array([centers[d] for d in names])

    def predict(x, y):
        return names[int(np.argmin(np.hypot(grid[:, 0] - x, grid[:, 1] - y)))]

    confusion, seg_n, seg_hit, delays = Counter(), 0, 0, []
    for d, rnd, s, e in segments:
        if rnd == 1 or d not in centers:
            continue
        preds = [predict(x, y) for x, y in points(s + SETTLE_SEC, e)]
        if not preds:
            continue
        confusion.update((d, p) for p in preds)
        seg_n += 1
        seg_hit += Counter(preds).most_common(1)[0][0] == d
        run = 0
        for t, x, y in frames:
            if s <= t < e:
                run = run + 1 if predict(x, y) == d else 0
                if run == LATENCY_FRAMES:
                    delays.append(t - s)
                    break
    total = sum(confusion.values())
    return {
        "names": names, "confusion": confusion, "centers": centers,
        "frame_acc": sum(confusion[d, d] for d in names) / total if total else None,
        "recall": {d: confusion[d, d] / n if (n := sum(confusion[d, p] for p in names)) else None for d in names},
        "segments": seg_n, "seg_acc": seg_hit / seg_n if seg_n else None,
        "delay_p50": median(delays) if delays else None, "delay_p95": percentile(delays, 95),
        "delay_n": len(delays),
    }


def gaze_report(truth, frames):
    segs = [(r["name"][5:], int(note_value(r, "round") or 0), float(r["start"]), float(r["end"]))
            for r in truth if r["name"].startswith("gaze_")]
    pts = [(float(r["t"]), float(r["gaze_x"]), float(r["gaze_y"])) for r in frames
           if r["gaze_x"] and float(r["blink"] or 0) < BLINK_MAX]
    g = gaze_scores(segs, pts)
    if g is None:
        return ["눈동자: 기준을 잡을 자료가 없습니다 (1바퀴째에 얼굴이 안 잡힘)."]
    names = g["names"]
    out = ["## 눈동자 5방향", "",
           f"- 프레임 정확도 **{_f(g['frame_acc'] and g['frame_acc'] * 100, '%')}**, "
           f"구간 정확도 {_f(g['seg_acc'] and g['seg_acc'] * 100, '%')} ({g['segments']}구간, 2바퀴째부터)",
           f"- 검출 지연(지시가 바뀜 → {LATENCY_FRAMES}프레임 연속으로 맞음, 사람의 반응 시간 포함): "
           f"중앙값 {_f(g['delay_p50'], '초')}, 상위 5% {_f(g['delay_p95'], '초')} ({g['delay_n']}구간)",
           "", "| 지시 \\ 판정 | " + " | ".join(names) + " | 맞힌 비율 |", "|---|" + "---|" * (len(names) + 1)]
    for d in names:
        out.append(f"| {d} | " + " | ".join(str(g["confusion"][d, p]) for p in names)
                   + f" | {_f(g['recall'][d] and g['recall'][d] * 100, '%')} |")
    out += ["", "방향별 기준(1바퀴째의 gaze_x, gaze_y 중앙값): "
            + ", ".join(f"{d} ({c[0]:+.2f}, {c[1]:+.2f})" for d, c in g["centers"].items())]
    return out


# ---------- 발화속도 ----------

def rate_report(truth, audio, sr):
    rows, pairs = [], []
    for r in truth:
        syll = note_value(r, "syll") if r["name"] == "read" else None
        if not syll:
            continue
        s, e = float(r["start"]), float(r["end"])
        peaks, speech = syllable_peaks(hop_power(audio[int(s * sr):int(e * sr)], sr))
        true, est = int(syll) / (e - s) * 60, len(peaks) / (e - s) * 60
        spoke = float(speech.sum()) * HOP_SEC
        pairs.append((true, est))
        rows.append(f"| {note_value(r, 'pace')} | {syll} | {len(peaks)} | {true:.0f} | {est:.0f} | "
                    f"{(est - true) / true * 100:+.1f}% | {_f(len(peaks) / spoke * 60 if spoke else None)} |")
    if not rows:
        return []
    err = rate_error(pairs)
    return ["## 발화속도", "",
            f"- 평균 오차율 **{_f(err['MAPE'], '%')}** (목표 15% 이하), 상관 {_f(err['상관'])} ({len(pairs)}구간)",
            "", "| 지시 | 대본 음절 | 센 음절 | 실제(분당) | 추정(분당) | 오차 | 쉼을 뺀 추정(분당) |",
            "|---|---|---|---|---|---|---|"] + rows


# ---------- 군말 ----------

def detect_fillers(audio, sr):
    """→ (군말 구간 목록, 조각 하나 처리 시간 ms 목록)"""
    power = hop_power(audio, sr)
    floor = float(np.sqrt(np.percentile(power, 10))) * NOISE_RATIO if len(power) else 0.0
    det, ms, hop = FillerDetector(sr), [], int(sr * FILLER_HOP)
    for i in range(0, len(audio) - hop + 1, hop):
        t0 = time.perf_counter()
        det.feed(audio[i:i + hop], floor)
        ms.append((time.perf_counter() - t0) * 1000)
    det.finish()
    return det.events, ms


def filler_report(truth, audio, sr):
    want = [("filler", float(r["start"]), float(r["end"])) for r in truth if r["name"] == "filler"]
    if not want:
        return []
    events, ms = detect_fillers(audio, sr)
    s = score(want, events, minutes=len(audio) / sr / 60)["filler"]
    lat = latency_summary(ms)
    return ["## 소리 기반 군말", "",
            f"- 지시한 군말 {s['정답']}개 중 {s['맞음']}개 잡음, 잘못 잡음 {s['오경고']}개",
            f"- 정밀도 {_f(s['정밀도'])}, 재현율 {_f(s['재현율'])}, **F1 {_f(s['F1'])}** (목표 0.7 이상), "
            f"분당 잘못 잡음 {_f(s['분당_오경고'])}",
            f"- 검출 지연: 소리 시작 뒤 {FILLER_MIN_SEC + FILLER_HOP:.2f}초 (기준 시간 {FILLER_MIN_SEC}초 + 조각 {FILLER_HOP}초, 설계값)",
            f"- 처리 시간({FILLER_HOP}초 조각 하나): 중앙값 {_f(lat['p50'], 'ms')}, 상위 5% {_f(lat['p95'], 'ms')}",
            "", "잡은 구간(초): " + (", ".join(f"{a:.1f}~{b:.1f}" for _, a, b in events) or "없음")]


# ---------- 전체 ----------

def report(folder):
    folder = Path(folder)
    truth, frames = read_csv(folder / "truth.csv"), read_csv(folder / "frames.csv")
    out = [f"# 평가 결과: {folder.name}", ""]
    if frames:
        dur = float(frames[-1]["t"])
        lat = latency_summary([float(r["proc_ms"]) for r in frames if r["proc_ms"]])
        out += [f"- 녹화 {dur:.0f}초, {len(frames)}프레임 (평균 {len(frames) / dur:.1f} FPS)" if dur else "",
                f"- 얼굴 분석 처리 시간: 중앙값 {_f(lat['p50'], 'ms')}, 상위 5% {_f(lat['p95'], 'ms')}, "
                f"최대 {_f(lat['최대'], 'ms')}", ""]
    out += gaze_report(truth, frames) if any(r["name"].startswith("gaze_") for r in truth) else []
    wav = folder / "audio.wav"
    if wav.exists() and wav.stat().st_size > 44:
        audio, sr = read_wav(wav)
        out += [""] + rate_report(truth, audio, sr) + [""] + filler_report(truth, audio, sr)
    text = "\n".join(out).strip() + "\n"
    (folder / "report.md").write_text(text, encoding="utf-8")
    return text


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.stdout.reconfigure(encoding="utf-8")
    print(report(sys.argv[1]))
