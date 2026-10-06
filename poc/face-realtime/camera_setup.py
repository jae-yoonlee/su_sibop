"""5단계: 시작할 때 카메라 위치·눈높이 맞추기

문제: 노트북 카메라가 눈보다 낮으면 화면을 평범하게 보는 것만으로 고개가 숙여진 것처럼 잡힌다.
해결: 시작할 때 세 단계를 안내한다.

1. 위치: 얼굴이 화면 가운데에 적당한 크기로 들어오게 한다 (너무 멀거나 가깝거나 치우치면 안내).
2. 렌즈 보기: 카메라 렌즈를 2초 바라본다 → 이때의 Pitch로 카메라가 눈보다 얼마나 낮은지(높은지) 추정한다.
   렌즈를 보려고 고개를 숙여야 하면(Pitch +) 카메라가 눈보다 낮다는 뜻이다.
3. 화면 보기: 면접 질문이 뜨는 화면 가운데를 2초 바라본다 → 이 자세를 '정면(0°)'으로 잡는다.
   그래서 화면을 보는 평소 자세는 '고개 숙임'으로 잡히지 않는다.

카메라가 너무 낮으면(렌즈를 볼 때 10° 넘게 숙임) 받침대로 올리라고 안내한다. 강제하지는 않는다.
기준값은 모두 초기값이며 여러 사람으로 다시 재야 한다.
"""
import numpy as np

STEADY_SEC = 2.0          # 이 시간 동안 흔들림 없이 유지되면 그 단계 완료
STEADY_MAX_STD = 3.0      # 흔들림 기준 (각도 표준편차 °)
SETTLE_SEC = 0.7          # 단계가 바뀐 뒤 시선을 옮길 시간: 이 동안의 프레임은 쓰지 않음
FACE_W_MIN = 0.18         # 얼굴 폭 / 화면 폭: 이보다 작으면 너무 멂
FACE_W_MAX = 0.45         # 이보다 크면 너무 가까움
CENTER_X_TOL = 0.15       # 얼굴 중심이 화면 가운데에서 좌우로 이만큼 벗어나면 안내
CENTER_Y_RANGE = (0.30, 0.65)  # 얼굴 중심 세로 위치 허용 범위 (위=0, 아래=1)
POSITION_OK_SEC = 1.0     # 위치가 이 시간 동안 맞으면 다음 단계
LENS_MAX_YAW = 15.0       # 렌즈·화면 보기 중 좌우로 이보다 돌아가 있으면 다시 기다림
CAMERA_LOW_PITCH = 10.0   # 렌즈를 볼 때 이보다 많이 숙이면 카메라가 눈보다 낮음
CAMERA_HIGH_PITCH = -10.0  # 렌즈를 볼 때 이보다 많이 들면 카메라가 눈보다 높음
SCREEN_GAP_WARN = 12.0    # 렌즈와 화면을 볼 때 각도 차이가 이보다 크면 '화면을 보는 것도 시선 이탈처럼 보임' 안내

ANGLE_KEYS = ("yaw", "pitch", "roll")

MESSAGES = {
    "no_face": "얼굴이 보이지 않습니다. 카메라 앞에 앉아 주세요",
    "too_far": "조금 더 가까이 앉아 주세요",
    "too_close": "조금 뒤로 물러나 주세요",
    "move_left": "왼쪽으로 조금 옮겨 주세요",
    "move_right": "오른쪽으로 조금 옮겨 주세요",
    "too_high": "얼굴이 화면 위쪽에 있습니다. 카메라 각도를 조금 올려 주세요",
    "too_low": "얼굴이 화면 아래쪽에 있습니다. 카메라 각도를 조금 내려 주세요",
    "position_ok": "좋습니다. 그대로 계세요",
    "lens": "카메라 렌즈를 2초 동안 바라봐 주세요",
    "screen": "이제 화면 가운데를 2초 동안 바라봐 주세요",
    "camera_low": "카메라가 눈보다 낮습니다. 노트북을 받침대나 책 위에 올려 주세요",
    "camera_high": "카메라가 눈보다 높습니다. 카메라를 조금 낮춰 주세요",
    "screen_gap": "화면과 카메라가 멀리 떨어져 있어 화면을 보는 것도 시선을 피하는 것처럼 보일 수 있습니다",
    "done": "준비 완료! 시작합니다",
}


def face_box(result):
    """랜드마크로 얼굴 중심(cx, cy)과 폭(w)을 화면 비율(0~1)로 구한다. 얼굴이 없으면 None."""
    if not result.face_landmarks:
        return None
    xs = [p.x for p in result.face_landmarks[0]]
    ys = [p.y for p in result.face_landmarks[0]]
    return {"cx": (min(xs) + max(xs)) / 2, "cy": (min(ys) + max(ys)) / 2, "w": max(xs) - min(xs)}


def position_issue(box):
    """얼굴 위치 문제를 하나 골라 돌려준다. 문제없으면 None. (거울 화면 기준)"""
    if box is None:
        return "no_face"
    if box["w"] < FACE_W_MIN:
        return "too_far"
    if box["w"] > FACE_W_MAX:
        return "too_close"
    if box["cx"] < 0.5 - CENTER_X_TOL:
        return "move_right"
    if box["cx"] > 0.5 + CENTER_X_TOL:
        return "move_left"
    if box["cy"] < CENTER_Y_RANGE[0]:
        return "too_high"
    if box["cy"] > CENTER_Y_RANGE[1]:
        return "too_low"
    return None


class SteadyWindow:
    """최근 STEADY_SEC 동안의 각도가 흔들림 없이 유지됐는지 확인"""

    def __init__(self):
        self.samples = []

    def reset(self):
        self.samples = []

    def feed(self, t, info):
        """흔들림 없이 STEADY_SEC가 채워지면 평균 각도 dict, 아니면 None"""
        self.samples.append((t, [info[k] for k in ANGLE_KEYS]))
        self.samples = [(ts, v) for ts, v in self.samples if t - ts <= STEADY_SEC]
        if t - self.samples[0][0] < STEADY_SEC - 0.05:
            return None
        values = np.array([v for _, v in self.samples])
        if values.std(axis=0).max() > STEADY_MAX_STD:
            return None
        return dict(zip(ANGLE_KEYS, values.mean(axis=0)))


class CameraSetup:
    """위치 → 렌즈 보기 → 화면 보기 순서로 안내하고, 끝나면 정면 기준 각도와 진단 결과를 남긴다."""

    def __init__(self):
        self.restart()

    def restart(self):
        self.step = "position"
        self.ok_since = None
        self.step_at = None       # 지금 단계가 시작된 시각 (첫 프레임에서 정함)
        self.window = SteadyWindow()
        self.lens = None          # 렌즈를 볼 때 평균 각도 (카메라 기준)
        self.baseline = None      # 화면을 볼 때 평균 각도 → 정면(0°)
        self.base_cx = None       # 화면을 볼 때 얼굴 중심의 가로 위치 (몸이 옆으로 치우쳤는지 판정용)
        self.warnings = []        # 끝난 뒤에도 보여줄 안내 (카메라 높이 등)
        self.message = "no_face"  # 화면에 띄울 안내 (MESSAGES의 키)

    @property
    def active(self):
        return self.step != "done"

    def skip_position(self):
        """사용자가 위치 맞추기를 건너뜀 (스페이스)"""
        if self.step == "position":
            self._go("lens")

    def _go(self, step):
        self.step = step
        self.step_at = None
        self.window.reset()
        self.message = step

    def feed(self, t, info, box):
        """한 프레임 처리. info: analyze() 결과(없으면 None), box: face_box() 결과."""
        if self.step == "position":
            issue = position_issue(box)
            if issue:
                self.ok_since = None
                self.message = issue
                return
            self.ok_since = self.ok_since if self.ok_since is not None else t
            self.message = "position_ok"
            if t - self.ok_since >= POSITION_OK_SEC:
                self._go("lens")
            return

        if info is None:
            self.window.reset()
            self.message = "no_face"  # 화면에 띄울 안내 (MESSAGES의 키)
            return
        self.message = self.step
        self.step_at = self.step_at if self.step_at is not None else t
        if t - self.step_at < SETTLE_SEC:
            return  # 이전 단계의 자세(예: 아직 렌즈를 보는 중)가 섞이지 않게 잠시 기다림
        mean = self.window.feed(t, info)
        if mean is None:
            return
        if self.step == "lens":
            if abs(mean["yaw"]) > LENS_MAX_YAW:
                self.window.reset()  # 렌즈를 보는데 고개가 돌아가 있으면 렌즈가 아니라 다른 곳을 본 것
                return
            self.lens = mean
            self._go("screen")
        elif self.step == "screen":
            if abs(mean["yaw"] - self.lens["yaw"]) > LENS_MAX_YAW:
                self.window.reset()
                return
            self.baseline = mean
            self.base_cx = box["cx"] if box else None
            self.warnings = self.diagnose()
            self._go("done")
            self.message = "done"

    def diagnose(self):
        """렌즈·화면 각도로 카메라 높이를 판정해 안내 문구 목록을 돌려준다."""
        out = []
        if self.lens["pitch"] > CAMERA_LOW_PITCH:
            out.append("camera_low")
        elif self.lens["pitch"] < CAMERA_HIGH_PITCH:
            out.append("camera_high")
        if abs(self.baseline["pitch"] - self.lens["pitch"]) > SCREEN_GAP_WARN:
            out.append("screen_gap")
        return out

    def apply(self, info):
        """보정된 각도 = 현재 각도 − 화면을 볼 때 각도"""
        return {k: info[k] - self.baseline[k] for k in ANGLE_KEYS}

    def summary(self):
        """리포트·로그용 진단 값"""
        if self.baseline is None:
            return {}
        return {
            "lens_pitch": round(self.lens["pitch"], 1),
            "screen_pitch": round(self.baseline["pitch"], 1),
            "screen_minus_lens": round(self.baseline["pitch"] - self.lens["pitch"], 1),
            "warnings": [MESSAGES[w] for w in self.warnings],
        }
