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
// 2026-10-19 실사용 피드백 "움직임을 잘 못 잡음" → 가로 12% → 8%, 위아래 추가, 앞뒤 25% → 15% [가설, 녹화로 확인 필요]
// 같은 날 여진 검증: 화면 글만 읽어도 4번 오경보 → 위아래 8% → 12%, 앞뒤 15% → 20%로 되돌림. 어느 축이 걸렸는지 결과 JSON(shiftBy)에 남김
export const SHIFT_TOL = 0.08; // 세팅 때 위치에서 가로로 이만큼(화면 폭 비율) 벗어나면 이동 (Python 0.12)
export const SHIFT_Y_TOL = 0.12; // [가설] 위아래로 이만큼(화면 높이 비율) 벗어나면 이동. 글을 읽으며 고개를 끄덕이는 정도는 넘지 않게
export const SHIFT_SIZE_RATIO = 0.2; // [가설] 얼굴 폭이 세팅 때보다 20% 넘게 변하면 앞뒤 이동

// ── 딴 곳 보기 [가설] 2026-10-19 사용자 요청: 카메라·질문 말고 다른 곳을 2초 넘게 보면 알림. 기준값은 실측 필요
export const LOOK_HEAD_DEG = 12.0; // 얼굴 방향이 '렌즈~질문 카드' 사이에서 이 각도 넘게 벗어나면
export const LOOK_EYE_TOL = 0.25; // 또는 눈동자 방향(-1~1)이 렌즈·질문 볼 때 값 사이에서 이만큼 넘게 벗어나면
export const LOOK_HOLD_SEC = 2.0;

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
// [가설, 2026-10-19 실사용 피드백] 숨소리·입소리·의자·키보드처럼 작고 짧은 소리가 '말함'으로 잡혀 침묵 타이머가 계속 초기화됐다.
export const SPEECH_FLOOR_BELOW_VOICE_DB = 20; // 내 목소리 기준보다 이만큼 넘게 작은 소리는 말로 보지 않음 (작은 목소리 경고 6dB보다 훨씬 아래)
// Silero VAD(말소리 판정 모델) 히스테리시스 [가설: Silero 기본값 0.5, 꺼짐은 0.15 낮게]
export const VAD_ON_P = 0.5;
export const VAD_OFF_P = 0.35;
export const VAD_OFF_HOLD_SEC = 0.3; // 이만큼 이어서 낮아야 말 끝남 (말 사이 짧은 틈 무시)
export const VAD_STALE_SEC = 1; // 판정이 이보다 오래 안 오면 음량 판정으로 대신
export const SILENCE_RESET_SEC = 0.3; // 침묵을 끊으려면 이만큼 이어서 말해야 함 (짧은 '음'·기침 한 번은 침묵 유지)

// ── 남의 목소리 거르기 [가설] 2026-10-23 사용자 요청 "소음이랑 구분". Silero는 TV·옆 사람 말소리도 말소리로 본다.
// 말소리가 들리는데 화면 속 입(jawOpen)이 거의 안 움직이면 내 말이 아니라고 보고, 침묵을 끊지 않고 소음으로 센다.
export const MOUTH_WINDOW_SEC = 0.8; // 최근 이 시간 동안 입 벌림 점수의 (최대-최소)가
export const MOUTH_MOVE_MIN = 0.04; // 이보다 작으면 입이 안 움직인 것
export const MOUTH_STALE_SEC = 0.5; // 얼굴 프레임이 이보다 오래 없으면 입 판정 안 함 (음성만으로 판정)

// ── 소리 종류 [가설] YAMNet(구글 공개 소리 분류 모델, 521종) 결과를 몇 묶음으로
export const SOUND_EVERY_SEC = 1.0; // 내가 말하지 않는 동안 1초마다 분류
export const SOUND_MIN_SCORE = 0.3; // 1위 점수가 이보다 낮으면 '모름'

// ── 음성 규칙 [voice_rules.py]
export const STUCK_SEC = 5.0; // 이만큼 말이 없으면 침묵 경고 (Python 4초 → 사용자 요청 5초)
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
export const VOICE_SETUP_SEC = 4.0; // 문장을 읽으며 최소 이만큼 말해야 하고 (문장 전체 약 5~6초)
export const VOICE_END_SILENCE_SEC = 1.0; // 그 뒤 이만큼 조용해지면 '다 읽었다'로 보고 기준 확정 (3초 고정이면 읽는 중에 넘어감)
export const VOICE_MIN_DB = -42.0; // 기준이 이보다 작으면 '더 크게'
export const VOICE_MAX_DB = -12.0; // 이보다 크면 '조금 작게' (찢어짐 위험)
export const NOISE_SETUP_SEC = 1.5; // 조용히 있는 동안 소음 측정 (Python NOISE_SEC 1초보다 넉넉히)
export const NOISE_MAX_DB = -40.0; // [가설] 측정한 소음이 이보다 크면 말소리가 섞였거나 너무 시끄러운 것 → 다시 잼

// ── 알림 간격 [feedback_gate.py] (2026-10-06 결정: 쉴 때만 띄우기는 빼고 간격 규칙은 유지)
export const CARD_SEC = 3.75; // 알림 카드 표시 시간. 2026-10-27 사용자 요청 "너무 빨리 지나감" → 2.5초 × 1.5
export const EYE_RECHECK_SEC = 5.0; // 시선 경고는 한 번 띄우면 이만큼 쉬었다가 다시 확인 (2026-10-19 사용자 요청)
export const GLOBAL_COOLDOWN = 20.0;
export const TYPE_COOLDOWN = 45.0;
export const BUDGET_WINDOW = 60.0;
export const BUDGET_MAX = 2;
export const QUEUE_MAX = 2;
export const PENDING_MAX_SEC = 8.0;

// ── 면접 진행
export const QUESTION_SEC = 30;
export const ANSWER_SEC = 60;

// ── 결과 등급 [사용자 결정 2026-10-14] 경고 종류별로 4문항 전체 횟수를 셈
export const WARN_COUNT = 3; // 이 횟수부터 '주의'
export const PROBLEM_COUNT = 5; // 이 횟수부터 '문제'
export const CLIP_LEAD_SEC = 2; // 증거 영상은 경고가 시작되기 이만큼 전부터 재생
