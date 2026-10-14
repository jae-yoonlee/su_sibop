// 답변 녹화: 경고가 뜬 순간을 결과 화면에서 다시 보여 주기 위한 증거 영상.
// 영상은 이 브라우저 메모리에만 있다 (서버로 보내지 않고, 창을 닫거나 '자료 새로 넣기'를 누르면 사라짐).
const TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

export class AnswerRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  error = "";

  start(stream: MediaStream) {
    if (typeof MediaRecorder === "undefined") {
      this.error = "이 브라우저는 녹화를 지원하지 않아요";
      return;
    }
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    try {
      // 1분에 약 5MB (4문항 약 20MB)로 메모리를 아낀다
      this.rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 600_000, audioBitsPerSecond: 48_000 });
      this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.rec.start(1000);
    } catch (e) {
      this.error = (e as Error).message;
      this.rec = null;
    }
  }

  /** 멈추고 영상 주소(blob:)를 돌려준다. 녹화를 못 했으면 null */
  stop(): Promise<string | null> {
    const rec = this.rec;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => resolve(this.chunks.length ? URL.createObjectURL(new Blob(this.chunks, { type: rec.mimeType })) : null);
      rec.stop();
    });
  }
}

/** MediaRecorder가 만든 webm은 길이 정보가 없어 앞뒤로 옮기기가 안 되는 경우가 있어, 끝까지 한 번 옮겨 길이를 알아낸다 */
export function fixDuration(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("timeupdate", done);
      video.currentTime = 0;
      resolve();
    };
    if (Number.isFinite(video.duration)) return resolve();
    video.addEventListener("timeupdate", done);
    video.currentTime = 1e101;
  });
}
