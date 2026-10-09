// 판정 기준값. 출처 표시: [파일명] = poc/face-realtime/ 의 Python 값을 그대로 옮김, [가설] = 웹 버전에서 새로 둔 값(실측 필요).

// ── 카메라 세팅 [camera_setup.py]
export const STEADY_SEC = 2.0; // 이 시간 동안 흔들림 없이 유지되면 그 단계 완료
export const STEADY_MAX_STD = 3.0; // 흔들림 기준 (각도 표준편차 °)
export const SETTLE_SEC = 0.7; // 단계가 바뀐 뒤 시선을 옮길 시간
export const FACE_W_MIN = 0.18; // 얼굴 폭 / 화면 폭: 이보다 작으면 너무 멂
export const FACE_W_MAX = 0.45; // 이보다 크면 너무 가까움
export const CENTER_X_TOL = 0.15; // 얼굴 중심이 가운데에서 좌우로 이만큼 벗어나면 안내
export const CENTER_Y_RANGE: [number, number] = [0.3, 0.65]; // 얼굴 중심 세로 허용 범위 (위=0)
export const POSITION_OK_SEC = 1.0; // 위치가 이 시간 동안 맞으면 다음 단계
export const LENS_MAX_YAW = 15.0; // 렌즈·화면 보기 중 좌우로 이보다 돌아가 있으면 다시 기다림
export const CAMERA_LOW_PITCH = 10.0;
export const CAMERA_HIGH_PITCH = -10.0;
export const SCREEN_GAP_WARN = 12.0;

// ── 자세 규칙 [step3_coaching.py]
export const YAW_LIMIT = 20.0; // 좌우로 이 각도 이상 돌리면
export const PITCH_LIMIT = 15.0; // 이 각도 이상 숙이면
export const HOLD_SEC = 2.0; // 위 상태가 이 시간 이상 이어지면 경고
export const FACE_GAP_SEC = 0.5; // 얼굴 인식이 이보다 짧게 끊기면 타이머 유지
export const MIN_SHOW_SEC = 1.0; // 상태가 풀려도 경고를 이 시간만큼 유지 (깜빡거림 방지)

// ── 자리 이동 [coach_engine.py]
export const SHIFT_TOL = 0.12; // 세팅 때 위치에서 가로로 이만큼(화면 폭 비율) 벗어나면 이동
export const SHIFT_SIZE_RATIO = 0.25; // [가설] 얼굴 폭이 세팅 때보다 25% 넘게 변하면 앞뒤 이동

// ── 눈동자 [가설] step2_face_landmarks.py의 gaze_x/gaze_y 계산식만 재사용, 기준값은 데이터 없음
export const GAZE_WINDOW_SEC = 4.0; // 최근 이 시간의 눈동자 흔들림을 봄
export const GAZE_MIN_STD = 0.18; // 흔들림(표준편차)이 이 값 이상이고
export const GAZE_BASE_RATIO = 2.5; // 세팅 때 흔들림의 이 배수 이상이면 '눈동자가 많이 움직임'
export const GAZE_BLINK_SKIP = 0.5; // 눈 감은 프레임은 빼고 계산

// ── 말함 판정 [speech_state.py]
export const BLOCK_SEC = 0.03; // 30ms 단위 음량
export const ON_RATIO = 3.0; // 소음 RMS의 이 배수를 넘으면 말함
export const OFF_RATIO = 2.0;
export const MIN_ON_SEC = 0.15;
export const OFF_HOLD_SEC = 0.3;

// ── 음성 규칙 [voice_rules.py]
export const STUCK_SEC = 5.0; // 이만큼 말이 없으면 침묵 경고 (Python 4초 → 사용자 요청 5초)
export const STUCK_COOLDOWN = 30.0;
export const QUIET_WINDOW = 10.0;
export const QUIET_MIN_SPEECH = 3.0;
export const QUIET_ON_DB = 6.0; // 내 기준보다 이만큼 작으면 켬
export const QUIET_OFF_DB = 4.0;
export const QUIET_HOLD = 5.0;

// ── 주변 소음 [가설]
export const NOISE_WINDOW_SEC = 5.0; // 최근 이 시간의 음량 중
export const NOISE_PERCENTILE = 0.1; // 하위 10% 값을 '바닥 소음'으로 봄 (말 사이 빈틈)
export const NOISE_RISE_DB = 10.0; // 세팅 때보다 이만큼 커지면
export const NOISE_HOLD_SEC = 3.0; // 이 시간 이어질 때 경고

// ── 목소리 기준 측정 [가설] 자동 음량 조절을 끈 상태의 dBFS
export const VOICE_SETUP_SEC = 3.0; // 문장을 읽으며 이만큼 말하면 기준 확정
export const VOICE_MIN_DB = -42.0; // 기준이 이보다 작으면 '더 크게'
export const VOICE_MAX_DB = -12.0; // 이보다 크면 '조금 작게' (찢어짐 위험)
export const NOISE_SETUP_SEC = 1.5; // 조용히 있는 동안 소음 측정 (Python NOISE_SEC 1초보다 넉넉히)
export const NOISE_MAX_DB = -40.0; // [가설] 측정한 소음이 이보다 크면 말소리가 섞였거나 너무 시끄러운 것 → 다시 잼

// ── 알림 간격 [feedback_gate.py] (2026-10-06 결정: 쉴 때만 띄우기는 빼고 간격 규칙은 유지)
export const CARD_SEC = 2.5;
export const GLOBAL_COOLDOWN = 20.0;
export const TYPE_COOLDOWN = 45.0;
export const BUDGET_WINDOW = 60.0;
export const BUDGET_MAX = 2;
export const QUEUE_MAX = 2;
export const PENDING_MAX_SEC = 8.0;

// ── 면접 진행
export const QUESTION_SEC = 30;
export const ANSWER_SEC = 60;
