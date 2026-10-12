// 받아쓰기 (브라우저 Web Speech API, 한국어).
// 주의: Chrome·Edge 기본 방식은 음성을 Google·Microsoft 서버로 보내 글자로 바꾼다. 화면에 반드시 알린다.
// Chrome의 '기기 안 받아쓰기'(processLocally)는 지원 확인 함수(SpeechRecognition.available)가
// 일부 Chrome에서 탭을 멈추게 해서(헤드리스 Chrome 141에서 재현) 지금은 쓰지 않는다.

type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
type RecCtor = new () => Rec;

const Ctor = ((window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecCtor }).webkitSpeechRecognition) as RecCtor | undefined;

export type SttMode = "none" | "local" | "cloud";
let modeCache: Promise<SttMode> | null = null;

/** 이 브라우저에서 받아쓰기를 어떻게 할 수 있는지 */
export function sttMode(): Promise<SttMode> {
  modeCache ??= (async () => {
    if (!Ctor) return "none";
    return "cloud";
  })();
  return modeCache;
}

export const STT_MODE_TEXT: Record<SttMode, string> = {
  none: "이 브라우저는 받아쓰기를 지원하지 않아요 (Chrome·Edge 필요)",
  local: "받아쓰기: 이 PC 안에서 처리",
  cloud: "받아쓰기: 음성이 브라우저 회사(Google 등) 서버로 전송돼 글자로 바뀌어요",
};

/** 말하는 동안 계속 받아쓴다. Chrome은 잠깐 조용하면 저절로 멈추므로 다시 켠다. */
export class Transcriber {
  private rec: Rec | null = null;
  private finals: string[] = [];
  private interim = "";
  private on = false;
  error = "";

  constructor(private mode: SttMode, private onChange?: (text: string) => void) {}

  get text() {
    return [...this.finals, this.interim].join(" ").replace(/\s+/g, " ").trim();
  }

  start() {
    if (!Ctor || this.mode === "none") return;
    this.finals = [];
    this.interim = "";
    this.error = "";
    this.on = true;
    this.open();
  }

  private open() {
    const r = new Ctor!();
    r.lang = "ko-KR";
    r.continuous = true;
    r.interimResults = true;
    if (this.mode === "local") r.processLocally = true;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.finals.push(res[0].transcript.trim());
        else interim += res[0].transcript;
      }
      this.interim = interim.trim();
      this.onChange?.(this.text);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.error = e.error;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.on = false;
    };
    r.onend = () => {
      if (this.interim) this.finals.push(this.interim); // 끊길 때 남은 중간 결과도 살린다
      this.interim = "";
      if (this.on) setTimeout(() => this.on && this.open(), 100);
    };
    this.rec = r;
    try {
      r.start();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** 멈추고, 마지막 결과가 들어올 때까지 잠깐 기다린 뒤 전체 글을 돌려준다 */
  async stop(waitMs = 800): Promise<string> {
    this.on = false;
    this.rec?.stop();
    await new Promise((r) => setTimeout(r, waitMs));
    return this.text;
  }
}
