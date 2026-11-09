// 면접관 목소리: 브라우저 내장 음성 합성(speechSynthesis, 한국어). 추가 파일·서버 없음.
// 이 PC에 깔린 음성(localService)을 먼저 쓴다. Windows는 'Microsoft Heami'가 보통 깔려 있다.
// PC 음성이 없고 Chrome의 'Google 한국의' 같은 온라인 음성만 있으면 질문 글이 Google로 가므로 화면에 알린다.

export type TtsEnd = "ended" | "error" | "cancel";
export interface TtsHandle {
  done: Promise<TtsEnd>;
  cancel(): void;
}

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

let voices: SpeechSynthesisVoice[] = [];
function loadVoices() {
  if (!ttsSupported()) return;
  voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith("ko"));
}
if (ttsSupported()) {
  loadVoices();
  speechSynthesis.addEventListener?.("voiceschanged", loadVoices); // Chrome은 목록을 늦게 준다
}

/** 면접관 번호에 맞는 한국어 음성. PC 음성이 여럿이면 사람마다 다르게 */
export function voiceFor(i: number): { voice: SpeechSynthesisVoice | null; remote: boolean } {
  const local = voices.filter((v) => v.localService);
  const list = local.length ? local : voices;
  const voice = list.length ? list[i % list.length] : null;
  return { voice, remote: !!voice && !voice.localService };
}

/** 말이 끝났다는 신호(onend)가 안 오는 브라우저가 있어 글자 수로 최대 시간을 잡는다 [가설: 한국어 초당 약 7자] */
export const maxSpeakSec = (text: string, rate: number) => text.length / (7 * rate) + 3;
const START_WAIT_MS = 2500; // 이 안에 말을 시작하지 않으면 소리가 안 나는 것으로 보고 자막으로

export function speak(text: string, judge: number, opt: { pitch: number; rate: number }): TtsHandle {
  if (!ttsSupported()) return { done: Promise.resolve("error"), cancel() {} };
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const { voice } = voiceFor(judge);
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? "ko-KR";
  u.pitch = opt.pitch;
  u.rate = opt.rate;
  let finish: (r: TtsEnd) => void = () => {};
  let started = false;
  const timers: number[] = [];
  const done = new Promise<TtsEnd>((resolve) => {
    finish = (r) => {
      timers.forEach(clearTimeout);
      finish = () => {};
      resolve(r);
    };
  });
  u.onstart = () => (started = true);
  u.onend = () => finish("ended");
  u.onerror = (e) => finish(e.error === "canceled" || e.error === "interrupted" ? "cancel" : "error");
  timers.push(window.setTimeout(() => !started && !speechSynthesis.speaking && (speechSynthesis.cancel(), finish("error")), START_WAIT_MS));
  timers.push(window.setTimeout(() => finish(started ? "ended" : "error"), maxSpeakSec(text, opt.rate) * 1000));
  speechSynthesis.speak(u);
  return {
    done,
    cancel() {
      finish("cancel");
      speechSynthesis.cancel();
    },
  };
}
