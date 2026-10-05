"""5단계: 카메라 위치 맞추기 + 쉴 때만 경고 띄우기

3단계 코칭에 두 가지를 더했다.
1. 시작할 때 카메라 위치·눈높이 안내 (camera_setup.py)
   위치 맞추기 → 렌즈 2초 보기 → 화면 가운데 2초 보기. 화면을 보는 자세가 정면(0°)이 된다.
2. 쉴 때만 경고 띄우기 (feedback_gate.py)
   말하는 중에는 경고를 대기시키고, 말을 멈춘 뒤 0.7~1.5초 사이에만 카드 1개를 띄운다.
   마이크 음량으로 말하는 중인지 판단한다 (speech_state.py, 음성 기능이 생기면 교체).

3단계의 '긴장 상태입니다 (깜빡임 과다)' 경고는 뺐다. 사람은 말할 때 원래 깜빡임이 늘어서
(Bentivoglio 외 1997: 쉴 때 17회/분, 대화 중 26회/분) 면접 답변 중에는 계속 뜰 수 있다.
깜빡임 수는 기록만 한다.

키: 스페이스 = 위치 맞추기 건너뛰기 / c = 처음부터 다시 맞추기 / s = 캡처 저장 / q = 종료

실행 예)
  python step5_coaching.py             # 웹캠 + 마이크 (sounddevice 필요)
  python step5_coaching.py --no-mic    # 마이크 없이: 쉬는 순간을 몰라 쿨다운만 적용
  python step5_coaching.py --log       # results/step5_feedback.csv, step5_setup.json 저장
"""
import argparse
import csv
import json
import sys
import time

import cv2

from camera_setup import MESSAGES, CameraSetup, face_box
from feedback_gate import FeedbackGate
from speech_state import MicSpeechState
from step2_face_landmarks import RESULTS_DIR, analyze, create_landmarker, ensure_model, put, to_mp_image
from step3_coaching import ALERTS, CoachRules, paste, render_label

COACH_ALERTS = {k: v for k, v in ALERTS.items() if k != "blink"}
SETUP_DONE_SHOW_SEC = 4.0   # 준비 완료 후 카메라 높이 안내를 보여주는 시간
WINDOW = "Step5 - Setup + Pause-timed coaching (space: skip, c: redo setup, s: save, q: quit)"


def draw_status(frame, angles, rules, gate, speaking):
    put(frame, f"Yaw {angles['yaw']:+5.1f}  Pitch {angles['pitch']:+5.1f}", 28, (0, 255, 255))
    voice = {True: "speaking", False: "silent", None: "no mic"}[speaking]
    put(frame, f"Voice: {voice}  Pending: {','.join(gate.pending) or '-'}", 56)
    put(frame, f"Blinks/min {rules.blink_count} (log only)", 84, (180, 180, 180))


def save_logs(setup, gate, rules):
    with open(RESULTS_DIR / "step5_feedback.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["time_s", "alert", "outcome", "reason"])
        writer.writerows(gate.log)
    summary = dict(setup.summary(), total_blinks=rules.total_blinks)
    with open(RESULTS_DIR / "step5_setup.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    shown = sum(1 for row in gate.log if row[2] == "shown")
    print(f"기록 저장: step5_feedback.csv ({len(gate.log)}건, 표시 {shown}건), step5_setup.json")


def main():
    parser = argparse.ArgumentParser(description="카메라 위치 맞추기 + 쉴 때만 경고 띄우기")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--no-mic", action="store_true", help="마이크를 쓰지 않음")
    parser.add_argument("--log", action="store_true")
    args = parser.parse_args()

    ensure_model()
    RESULTS_DIR.mkdir(exist_ok=True)
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        sys.exit("웹캠을 열 수 없습니다. WSL이라면 Windows에서 실행하세요.")

    speech = None if args.no_mic else MicSpeechState()
    if speech is not None and not speech.available:
        print(f"마이크를 열지 못해 음성 없이 진행합니다: {speech.error}")
        speech = None

    alert_labels = {k: render_label(msg, (200, 30, 30)) for k, msg in COACH_ALERTS.items()}
    setup_labels = {k: render_label(msg, (30, 90, 200)) for k, msg in MESSAGES.items()}
    setup, rules = CameraSetup(), CoachRules()
    gate = FeedbackGate(no_audio=speech is None)
    start, last_ts, t, done_at = time.perf_counter(), -1, 0.0, None

    with create_landmarker(video=True) as landmarker:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("웹캠 프레임을 읽지 못했습니다.")
                break
            frame = cv2.flip(frame, 1)
            t = time.perf_counter() - start
            ts = max(int(t * 1000), last_ts + 1)
            last_ts = ts
            result = landmarker.detect_for_video(to_mp_image(frame), ts)
            info = analyze(result)
            h = frame.shape[0]

            if setup.active:
                setup.feed(t, info, face_box(result))
                paste(frame, setup_labels[setup.message], h - 70)
                if not setup.active:
                    done_at = t
                    print("카메라 진단:", setup.summary())
            else:
                speaking = speech.speaking if speech else None
                angles = setup.apply(info) if info else None
                active = [k for k in rules.update(t, angles, info) if k != "blink"]
                shown = gate.update(t, active, speaking)
                if angles:
                    draw_status(frame, angles, rules, gate, speaking)
                if done_at is not None and t - done_at < SETUP_DONE_SHOW_SEC:
                    for i, w in enumerate(setup.warnings or ["done"]):
                        paste(frame, setup_labels[w], 100 + i * 62)
                for i, k in enumerate(shown):
                    paste(frame, alert_labels[k], h - 70 - i * 62)

            cv2.imshow(WINDOW, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord(" "):
                setup.skip_position()
            if key == ord("c"):
                setup.restart()
                rules.reset_timers()
            if key == ord("s"):
                cv2.imwrite(str(RESULTS_DIR / "step5_coaching.png"), frame)

    cap.release()
    cv2.destroyAllWindows()
    if speech:
        speech.close()
    rules.finish(t)
    gate.finish(t)
    if args.log:
        save_logs(setup, gate, rules)


if __name__ == "__main__":
    main()
