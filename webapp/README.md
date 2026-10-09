# 웹 버전 (1단계): 카메라·목소리 실시간 코칭

`poc/face-realtime/`의 Python 판정 규칙을 브라우저로 옮긴 버전입니다. 영상과 소리는 사용자 브라우저 안에서만 분석하고 서버로 보내지 않습니다.

- 배포 주소: https://jae-yoonlee.github.io/su_sibop/ (main에 합쳐지면 자동 배포)
- 권장 브라우저: Chrome, Edge (데스크톱)

## 실행

```bash
cd webapp
npm install
npm run dev      # http://localhost:5173
npm test         # 판정 규칙 테스트
npm run build    # dist/ 생성
```

## 구성

| 파일 | 내용 | 옮겨 온 곳 |
|---|---|---|
| `src/rules/constants.ts` | 모든 기준값 (출처 표시: Python 파일명 또는 [가설]) | step3, camera_setup, coach_engine, voice_rules, speech_state, feedback_gate |
| `src/rules/face.ts` | 고개 각도·눈동자 값·얼굴 위치 | step2_face_landmarks.analyze, camera_setup.face_box |
| `src/rules/cameraSetup.ts` | 가운데 앉기 → 렌즈 보기 → 질문 화면 보기 | camera_setup.CameraSetup |
| `src/rules/postureRules.ts` | 얼굴 안 보임·고개 돌림·숙임·중앙 이탈·자리 이동·눈동자 | step3.CoachRules, coach_engine (중앙·눈동자는 새로 추가) |
| `src/rules/voice.ts` | 소음 측정·목소리 기준, 5초 침묵·작은 목소리·주변 소음 | speech_state.EnergyVad, voice_rules.VoiceRules (소음은 새로 추가) |
| `src/rules/gate.ts` | 알림 간격 (20초, 같은 종류 45초, 1분 2개) | feedback_gate (쉴 때만 띄우기는 뺌) |
| `src/media/` | 카메라 + MediaPipe(웹), 마이크(AudioWorklet) | |

마이크는 자동 음량 조절·잡음 제거를 끄고 엽니다. 켜 두면 '목소리 작음'·'주변 소음' 판정이 무의미해집니다.

## 테스트 중 보기
- 면접 화면에서 `D` 키: 각도·눈동자 흔들림·음량 값 표시
- 결과 화면 아래 "측정 정보": 얼굴 분석 방식(GPU/CPU), fps, 마이크 설정이 실제로 꺼졌는지

## [가설] 값 (실측 필요)
눈동자 흔들림 기준, 주변 소음 +10dB, 목소리 적정 범위(-42~-12 dBFS), 앞뒤 이동 25%.
