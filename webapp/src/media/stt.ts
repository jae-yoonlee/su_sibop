// 받아쓰기 (브라우저 Web Speech API, 한국어).
// 주의: Chrome·Edge 기본 방식은 음성을 Google·Microsoft 서버로 보내 글자로 바꾼다. 화면에 반드시 알린다.
// Chrome의 '기기 안 받아쓰기'(processLocally)는 지원 확인 함수(SpeechRecognition.available)가
// 일부 Chrome에서 탭을 멈추게 해서(헤드리스 Chrome 141에서 재현) 지금은 쓰지 않는다.

type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  maxAlternatives?: number;
  phrases?: unknown[];
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
type RecCtor = new () => Rec;

const Ctor = ((globalThis as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }).SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: RecCtor }).webkitSpeechRecognition) as RecCtor | undefined;

const PhraseCtor = (globalThis as unknown as { SpeechRecognitionPhrase?: new (phrase: string, boost: number) => unknown }).SpeechRecognitionPhrase;

/** 한 결과에 받을 후보 수. 자소서 단어가 들어간 후보를 고르는 데 씀 */
export const STT_ALTERNATIVES = 3;
/** 자소서 단어 힌트 가중치 (명세 범위 0~10) [가설] */
export const STT_PHRASE_BOOST = 5;
/** 말소리 판정이 '말하는 중'인데 이만큼 받아쓰기 결과가 안 오면 받아쓰기를 다시 켠다 [가설] */
export const STT_STALL_SEC = 6; // [가설] 4초 → 6초 (2026-10-27): 서버가 조금 늦게 줄 때까지 끊지 않게
/** 멈춘 받아쓰기에 stop()을 부르고 이만큼 지나도 안 끝나면 abort() */
const STOP_GRACE_SEC = 1.5;

/** 후보 여러 개 중 자소서 단어(공백 무시)를 가장 많이 담은 것. 같으면 브라우저가 1순위로 준 것 */
export function pickAlternative(alts: string[], hints: string[]): string {
  if (!alts.length) return "";
  const keys = hints.map((h) => h.replace(/\s/g, "")).filter((h) => h.length >= 2);
  if (!keys.length) return alts[0];
  let best = 0, bestHits = -1;
  alts.forEach((a, i) => {
    const t = a.replace(/\s/g, "");
    const hits = keys.filter((k) => t.includes(k)).length;
    if (hits > bestHits) [best, bestHits] = [i, hits];
  });
  return alts[best];
}

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
  none: "이 브라우저에서는 받아쓰기가 안 돼요. Chrome이나 Edge로 열어 주세요",
  local: "받아쓰기도 이 컴퓨터 안에서 해요",
  cloud: "받아쓰기만 Google 서버를 거쳐요",
};

/** 받아쓰기 한 번 켠 것의 결과. 다시 켜도 앞 것의 늦게 온 결과가 제자리에 들어가도록 따로 모은다 */
interface Segment {
  finals: string[];
  interim: string;
}

/** 말하는 동안 계속 받아쓴다. Chrome은 잠깐 조용하면 저절로 멈추므로 다시 켠다. */
export class Transcriber {
  private rec: Rec | null = null;
  private segs: Segment[] = [];
  private on = false;
  private live = false; // 지금 받아쓰기가 켜져 있는지 (Chrome이 저절로 끈 뒤 다시 켜기 전엔 false)
  private noPhrases = !PhraseCtor;
  private lastResult = 0;
  private stopAt: number | null = null; // 멈춘 받아쓰기를 끝내려고 stop()을 부른 시각
  error = "";
  /** 말소리 판정을 보고 다시 켠 횟수 (결과 JSON에 남겨 효과 확인) */
  restarts = 0;

  /** hints: 자소서의 프로젝트 이름, 숫자, 영문 약어처럼 틀리기 쉬운 단어 */
  constructor(private mode: SttMode, private onChange?: (text: string) => void, private hints: string[] = []) {}

  get text() {
    return this.segs.flatMap((g) => [...g.finals, g.interim]).join(" ").replace(/\s+/g, " ").trim();
  }

  start() {
    if (!Ctor || this.mode === "none") return;
    this.segs = [];
    this.error = "";
    this.on = true;
    this.open();
  }

  private open() {
    const r = new Ctor!();
    const seg: Segment = { finals: [], interim: "" };
    this.segs.push(seg);
    r.lang = "ko-KR";
    r.continuous = true;
    r.interimResults = true;
    if (this.mode === "local") r.processLocally = true;
    r.maxAlternatives = STT_ALTERNATIVES;
    // 문맥 힌트(contextual biasing): 지원하는 Chrome에서만. 지원 안 하면 오류가 오고, 그때부터 빼고 켠다
    if (!this.noPhrases && this.hints.length) {
      try {
        r.phrases = this.hints.slice(0, 50).map((h) => new PhraseCtor!(h, STT_PHRASE_BOOST));
      } catch {
        this.noPhrases = true;
      }
    }
    r.onresult = (e) => {
      this.lastResult = performance.now();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) seg.finals.push(pickAlternative(Array.from(res, (a) => a.transcript.trim()), this.hints));
        else interim += res[0].transcript;
      }
      seg.interim = interim.trim();
      this.onChange?.(this.text);
    };
    r.onerror = (e) => {
      if (e.error === "phrases-not-supported") return void (this.noPhrases = true); // onend에서 힌트 없이 다시 켬
      if (e.error !== "no-speech" && e.error !== "aborted") this.error = e.error;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.on = false;
    };
    r.onend = () => {
      if (seg.interim) seg.finals.push(seg.interim); // 끊길 때 남은 중간 결과도 살린다
      seg.interim = "";
      if (this.rec !== r) return;
      this.live = false;
      if (this.on) setTimeout(() => this.on && !this.live && this.open(), 100);
    };
    this.rec = r;
    this.stopAt = null;
    this.lastResult = performance.now();
    try {
      r.start();
      this.live = true;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** 말소리 판정(Silero)이 말하는 중이라고 할 때마다 부른다.
   *  Chrome이 조용할 때 받아쓰기를 저절로 끄고 다시 켜는 사이에 첫마디가 잘리고, 가끔 켜진 채 결과를 안 주므로
   *  꺼져 있으면 바로 켜고, 말하는데 결과가 STT_STALL_SEC 넘게 없으면 다시 켠다.
   *  2026-10-27 실사용: 다시 켠 횟수가 많았던 답변에서 말이 크게 빠졌다(41초 답변에 25어절). 예전엔 abort()로 버려서
   *  서버가 처리 중이던 말까지 사라졌을 가능성이 커서, 이제 stop()으로 끝내 그때까지 들은 말의 결과를 받고
   *  끝났다는 신호(onend)가 오면 다시 켠다. stop에도 STOP_GRACE_SEC 안에 안 끝나면 그때 abort. */
  speech() {
    if (!this.on || !Ctor) return;
    if (!this.live) {
      this.restarts++;
      return this.open();
    }
    const now = performance.now();
    if (this.stopAt !== null) {
      if (now - this.stopAt > STOP_GRACE_SEC * 1000) {
        this.stopAt = null;
        this.rec?.abort();
      }
      return;
    }
    if (now - this.lastResult > STT_STALL_SEC * 1000) {
      this.restarts++;
      this.stopAt = now;
      try {
        this.rec?.stop();
      } catch {
        this.stopAt = null;
      }
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
