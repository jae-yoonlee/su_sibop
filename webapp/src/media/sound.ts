// 주변 소리 종류 분류: YAMNet (Google 공개 모델, AudioSet 521종, Apache 2.0). MediaPipe Audio Classifier로 브라우저 안에서 실행.
// 주변 소음 경고가 무엇 때문인지(음악, TV, 키보드 등) 알려 주는 용도. 판정 자체는 기존 소음 규칙이 한다.
import { AudioClassifier, FilesetResolver } from "@mediapipe/tasks-audio";
import { SOUND_MIN_SCORE } from "../rules/constants";

const WASM_URL = `${import.meta.env.BASE_URL}mediapipe-audio`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite";
const RATE = 16000;
const WINDOW = 15600; // YAMNet 한 번에 0.975초

/** YAMNet 이름 → 화면에 보일 묶음. 순서대로 처음 맞는 것 */
const GROUPS: [RegExp, string][] = [
  [/^Silence$/, ""],
  [/Speech|Conversation|Narration|Television|Radio|Laughter|Babbling|Chatter|Crowd/, "다른 사람 목소리, TV"],
  [/Music|Singing|Song|instrument|Guitar|Piano|Drum|Beat/, "음악"],
  [/Typing|keyboard|Click|Writing|Mouse|Tap/, "키보드, 클릭"],
  [/Vehicle|Car|Traffic|Siren|horn|Motorcycle|Bus|Truck|Train/, "바깥 차 소리"],
  [/fan|Air conditioning|Hum|Engine|Mechanical|Buzz|Vacuum|Hair dryer/, "기계 소리(선풍기, 에어컨)"],
  [/Dog|Bark|Cat|Meow|Bird|Animal/, "동물 소리"],
  [/Door|Knock|Footsteps|Chair|Slam/, "문, 발소리"],
];

export function soundGroup(name: string): string {
  for (const [re, g] of GROUPS) if (re.test(name)) return g;
  return "기타 소리";
}

export interface SoundSensor {
  ready: boolean;
  push(frame: Float32Array): void;
  /** 최근 약 1초를 분류. 모르면 null */
  classify(): string | null;
}

export async function startSound(): Promise<SoundSensor> {
  const buf = new Float32Array(WINDOW);
  let filled = 0;
  const sensor: SoundSensor = {
    ready: false,
    push(frame) {
      // 최근 WINDOW 샘플만 유지 (frame은 말소리 판정기로 넘어가기 전에 복사됨)
      if (frame.length >= WINDOW) buf.set(frame.subarray(frame.length - WINDOW));
      else {
        buf.copyWithin(0, frame.length);
        buf.set(frame, WINDOW - frame.length);
      }
      filled = Math.min(WINDOW, filled + frame.length);
    },
    classify: () => null,
  };
  const fileset = await FilesetResolver.forAudioTasks(WASM_URL);
  const clf = await AudioClassifier.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL_URL }, maxResults: 1 });
  sensor.classify = () => {
    if (filled < WINDOW) return null;
    const top = clf.classify(buf, RATE)[0]?.classifications[0]?.categories[0];
    if (!top || top.score < SOUND_MIN_SCORE) return null;
    return soundGroup(top.categoryName) || null;
  };
  sensor.ready = true;
  return sensor;
}
