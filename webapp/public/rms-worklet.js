// 마이크 소리를 30ms 조각으로 나눠 RMS(음량)만 메인 스레드로 보낸다. 소리 자체는 어디에도 보내지 않음.
class RmsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round(sampleRate * 0.03);
    this.sum = 0;
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.sum += ch[i] * ch[i];
        if (++this.n >= this.block) {
          this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), t: currentTime });
          this.sum = 0;
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("rms-processor", RmsProcessor);
