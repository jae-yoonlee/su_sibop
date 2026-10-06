# LocalCoach: 로컬 AI 면접 연습 코치

웹캠과 마이크로 면접 답변을 보면서 **고개 방향·시선·침묵·작은 목소리·발화속도·군말**을 실시간으로 알려 주고,
자기소개서로 **맞춤 질문 3개 + 꼬리질문 3개**를 만들어 주는 연습 도구입니다.
분석은 모두 내 PC 안에서 하고, 화면은 브라우저(`http://127.0.0.1:8000`)로 봅니다.

> 캡스톤 프로젝트 "실시간 시선·filler word·발화속도 검출 시스템 구현 및 정확도/지연시간 평가" (이재윤 · 김여진)

## 바로 실행 (Windows)

1. 이 저장소를 받습니다: 초록색 **Code → Download ZIP**, 또는 `git clone https://github.com/jae-yoonlee/su_sibop.git`
2. `poc\face-realtime\run_web.bat`을 더블클릭합니다.
   Python 설치 → 가상환경 → 패키지 설치 → 서버 실행 → 브라우저 열기까지 자동으로 합니다.

자세한 단계별 설명은 [poc/face-realtime/README.md](poc/face-realtime/README.md)에 있습니다.

## 받아야 하는 것

### 꼭 필요 (자동으로 받아짐)
| 무엇 | 크기 | 받는 방법 |
|---|---|---|
| Python 3.10 이상 (3.12 권장) | 약 30MB | `run_web.bat`이 없으면 자동 설치 (winget) |
| Python 패키지 (`requirements.txt`) | 약 300MB | `run_web.bat`이 자동 설치. 직접: `pip install -r poc/face-realtime/requirements.txt` |
| 얼굴 모델 `face_landmarker.task` (MediaPipe) | 약 4MB | 처음 실행할 때 `poc/face-realtime/models/`에 자동 다운로드 |

### 자소서 질문·꼬리질문용 (택1)
| 무엇 | 크기 | 받는 방법 | 자소서가 밖으로 나가나 |
|---|---|---|---|
| **Ollama + EXAONE 3.5 (최종 기본값)** | 약 5GB | [ollama.com](https://ollama.com/download) 설치 후 `ollama pull exaone3.5:7.8b` (메모리 16GB 미만이면 `exaone3.5:2.4b`) | 아니요, PC 안에서만 |
| Gemini API 키 (지금 코드의 기본값) | - | [Google AI Studio](https://aistudio.google.com/apikey)에서 발급 → `poc/face-realtime/.env.example`을 `.env`로 복사하고 키 입력 | 예, Google 서버로 전송 |

> EXAONE은 연구·교육용 무료 라이선스입니다. 상업적으로 쓰려면 LG AI연구원과 별도 계약이 필요합니다.

### 아직 코드에 연결 전 (다음 단계에서 받음)
| 무엇 | 쓰는 곳 |
|---|---|
| `silero-vad` (pip) | 말소리 구간 찾기. 지금은 마이크 음량으로 임시 판정 |
| `faster-whisper` (pip) + 모델 (small 약 500MB) | 답변 받아쓰기 → 꼬리질문, 군말 집계, 자소서 대조 |
| AI Hub 데이터 | 평가용. [data/README.md](data/README.md) 참고 |

## 폴더 구조

```
poc/face-realtime/
  run_web.bat            Windows 한 번에 실행
  web_server.py, web/    브라우저 화면 (127.0.0.1에서만 열림)
  coach_engine.py        카메라 맞추기 → 규칙 → 알림을 한 프레임씩 진행
  [얼굴 인식]
    step2_face_landmarks.py   MediaPipe로 얼굴 점 478개, 고개 각도
    step3_coaching.py         고개 돌림·숙임·화면 이탈 규칙
    camera_setup.py           카메라 위치 맞추기와 정면 보정
    step4_benchmark.py        FPS·처리 시간 측정
  [음성]
    speech_state.py      말하는 중인지 (지금은 음량, Silero VAD로 교체 예정)
    voice_rules.py       침묵(4초)·작은 목소리·너무 빠름 규칙
    speech_rate.py       발화속도 (글자 변환 없이 음절 봉우리를 세어 분당 음절 수)
    filler_detect.py     소리 기반 군말 (길게 끄는 "음—", "어—")
    feedback_gate.py     알림 간격 (20초, 같은 종류 45초, 1분 최대 2개)
  [자소서]
    question_gen.py      자소서 → 맞춤 질문 3개 (Gemini 또는 EXAONE)
    followup_gen.py      답변 → 꼬리질문 1개 (규칙 + EXAONE, 매번 다르게)
  eval_events.py         평가 계산 (맞힌 횟수·헛경고·지연)
  eval_recorder.py, eval_report.py   평가용 녹화(영상·음성·정답)와 채점. 화면은 /eval.html
  test_*.py              테스트 (웹캠·마이크·AI 없이 실행)
  results/               측정 결과와 캡처
data/
  resume/sample_resume.txt   가상 예시 자소서
  private/                   실제 자소서 (GitHub에 안 올라감)
```

## 자소서로 질문 만들어 보기

```bat
cd poc\face-realtime
python question_gen.py ..\..\data\resume\sample_resume.txt --backend exaone
```

## 테스트

```bat
cd poc\face-realtime
pytest -q
```

웹캠·마이크·AI 없이 127개 테스트가 돌아갑니다.

## 진행 상황 (4주차)

| 항목 | 상태 |
|---|---|
| 고개 방향 판정·경고 화면 | 완료 |
| 자소서 맞춤 질문 3개 | 완료 |
| 침묵·작은 목소리 규칙, 꼬리질문, 평가 계산 | 코드와 테스트만 (화면 연결 전) |
| 발화속도, 소리 기반 군말, 눈동자 방향 값 | 값만 화면에 표시. 경고와 사람 대상 정확도 측정은 아직 |
| 정확도·지연 평가 도구 (/eval.html) | 도구는 있음. 사람 측정은 아직 ([사용법](poc/face-realtime/README.md#8단계-정확도지연-평가)) |
