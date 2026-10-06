"""평가 스크립트 테스트. 실행: pytest -q"""
import pytest

from eval_events import latency_summary, match, rate_error, score

TRUTH = [("turn", 10.0, 13.0), ("turn", 30.0, 33.0), ("stuck", 50.0, 56.0)]


def test_perfect_detection_with_designed_delay():
    det = [("turn", 12.0, 14.0), ("turn", 32.0, 34.0), ("stuck", 54.0, 56.5)]
    s = score(TRUTH, det, minutes=1.0)
    assert s["전체"]["F1"] == 1.0
    assert s["turn"]["지연_중앙값"] == pytest.approx(2.0)     # 설계상 2초 대기
    assert s["stuck"]["지연_중앙값"] == pytest.approx(4.0)
    assert s["전체"]["분당_오경고"] == 0


def test_miss_and_false_alarm():
    det = [("turn", 12.0, 14.0), ("turn", 70.0, 72.0)]       # 두 번째는 정답 없음
    s = score(TRUTH, det, minutes=2.0)["turn"]
    assert (s["맞음"], s["놓침"], s["오경고"]) == (1, 1, 1)
    assert s["정밀도"] == 0.5 and s["재현율"] == 0.5
    assert s["분당_오경고"] == 0.5


def test_names_must_match():
    pairs, missed, extra = match([("turn", 10, 13)], [("down", 11, 13)])
    assert not pairs and missed and extra


def test_one_detection_cannot_match_two_truths():
    truth = [("turn", 10, 11), ("turn", 11.5, 12.5)]
    pairs, missed, _ = match(truth, [("turn", 10.5, 12)])
    assert len(pairs) == 1 and len(missed) == 1


def test_tolerance():
    assert match([("turn", 10, 11)], [("turn", 11.8, 12)], tol=1.0)[0]
    assert not match([("turn", 10, 11)], [("turn", 12.5, 13)], tol=1.0)[0]


def test_no_detections_gives_zero_recall():
    s = score(TRUTH, [])["전체"]
    assert s["재현율"] == 0 and s["정밀도"] is None


def test_rate_error():
    r = rate_error([(4.0, 4.4), (5.0, 4.5), (6.0, 6.6)])
    assert r["MAPE"] == pytest.approx(10.0)
    assert r["상관"] > 0.8


def test_latency_summary():
    s = latency_summary(list(range(1, 101)))
    assert s["p50"] == pytest.approx(50.5) and s["최대"] == 100
