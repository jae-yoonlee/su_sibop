"""평가: 검출 결과를 정답 라벨과 비교해 정확도와 지연시간을 계산한다 (통합 설계서 9절)

입력 CSV는 둘 다 같은 형식이다: name,start,end (초). 헤더 한 줄.
- 정답: 사람이 녹화를 보며 단 라벨 (Audacity 라벨을 옮겨도 됨)
- 검출: 엔진이 남긴 경고 구간 (CoachRules.events, VoiceRules.events 등)

사건 단위로 맞춘다. 같은 이름의 정답 구간과 검출 구간이 겹치거나 TOL초 안에 있으면 맞은 것으로 보고,
정답 하나에는 검출 하나만 짝짓는다 (시작 시각이 가까운 순서로).
- 정밀도 = 맞은 검출 / 전체 검출, 재현율 = 잡은 정답 / 전체 정답, F1
- 검출 지연 = 검출 시작 − 정답 시작 (설계상 대기 시간 2초 등이 포함됨)
- 분당 오경고 = 짝이 없는 검출 수 / 녹화 길이(분)

실행: python eval_events.py 정답.csv 검출.csv [--tol 1.0] [--minutes 12.5]
"""
import argparse
import csv
from statistics import mean, median

TOL = 1.0


def load(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [(r["name"].strip(), float(r["start"]), float(r["end"])) for r in csv.DictReader(f)]


def _near(a, b, tol):
    """두 구간이 겹치거나 tol초 안에 있으면 True"""
    return a[1] - tol <= b[2] and b[1] - tol <= a[2]


def match(truth, detected, tol=TOL):
    """반환: [(정답, 검출)], 놓친 정답 목록, 짝 없는 검출 목록"""
    pairs, used = [], set()
    for t in sorted(truth, key=lambda x: x[1]):
        cands = [(abs(d[1] - t[1]), i) for i, d in enumerate(detected)
                 if i not in used and d[0] == t[0] and _near(t, d, tol)]
        if cands:
            _, i = min(cands)
            used.add(i)
            pairs.append((t, detected[i]))
    matched_truth = {id(t) for t, _ in pairs}
    missed = [t for t in truth if id(t) not in matched_truth]
    extra = [d for i, d in enumerate(detected) if i not in used]
    return pairs, missed, extra


def percentile(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def score(truth, detected, tol=TOL, minutes=None):
    """이름별 + 전체 점수 dict"""
    out = {}
    for name in sorted({x[0] for x in truth} | {x[0] for x in detected}) + [None]:
        t = [x for x in truth if name is None or x[0] == name]
        d = [x for x in detected if name is None or x[0] == name]
        pairs, missed, extra = match(t, d, tol)
        p = len(pairs) / len(d) if d else None
        r = len(pairs) / len(t) if t else None
        f1 = 2 * p * r / (p + r) if p and r else 0.0 if (p == 0 or r == 0) else None
        lat = [dd[1] - tt[1] for tt, dd in pairs]
        out[name or "전체"] = {
            "정답": len(t), "검출": len(d), "맞음": len(pairs), "놓침": len(missed), "오경고": len(extra),
            "정밀도": p, "재현율": r, "F1": f1,
            "지연_중앙값": median(lat) if lat else None,
            "지연_p95": percentile(lat, 95),
            "분당_오경고": len(extra) / minutes if minutes else None,
        }
    return out


def rate_error(pairs):
    """발화속도 평가: [(정답 음절/초, 추정 음절/초)] → 평균 절대 백분율 오차(%), 상관계수"""
    errs = [abs(e - g) / g * 100 for g, e in pairs if g > 0]
    if len(pairs) < 2:
        return {"MAPE": mean(errs) if errs else None, "상관": None}
    g, e = zip(*pairs)
    mg, me = mean(g), mean(e)
    cov = sum((a - mg) * (b - me) for a, b in pairs)
    sg = sum((a - mg) ** 2 for a in g) ** 0.5
    se = sum((b - me) ** 2 for b in e) ** 0.5
    return {"MAPE": mean(errs), "상관": cov / (sg * se) if sg and se else None}


def latency_summary(ms):
    """처리 지연(ms) 목록 → p50, p95, 최대"""
    return {"p50": percentile(ms, 50), "p95": percentile(ms, 95), "최대": max(ms) if ms else None}


def _fmt(v):
    return "-" if v is None else f"{v:.2f}" if isinstance(v, float) else str(v)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("truth")
    ap.add_argument("detected")
    ap.add_argument("--tol", type=float, default=TOL)
    ap.add_argument("--minutes", type=float, help="녹화 길이(분). 주면 분당 오경고를 계산")
    a = ap.parse_args()
    res = score(load(a.truth), load(a.detected), a.tol, a.minutes)
    cols = ["정답", "검출", "맞음", "놓침", "오경고", "정밀도", "재현율", "F1", "지연_중앙값", "지연_p95", "분당_오경고"]
    print("항목\t" + "\t".join(cols))
    for name, row in res.items():
        print(name + "\t" + "\t".join(_fmt(row[c]) for c in cols))
