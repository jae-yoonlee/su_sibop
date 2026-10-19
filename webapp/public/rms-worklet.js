// 마이크 소리를 30ms 조각으로 나눠 RMS(음량)를 메인 스레드로 보낸다.
// 말소리 판정(Silero VAD, 이 PC 안)을 위해 16kHz로 줄인 512샘플(32ms)조각도 함께 보낸다. 소리는 브라우저 밖으로 나가지 않음.
class RmsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round(sampleRate * 0.03);
    this.sum = 0;
    this.n = 0;
    // 16kHz로 줄이기: 원래 샘플 간격(step)마다 하나씩, 그 사이 값을 평균 (간단한 저역 통과)
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.frame = new Float32Array(512);
    this.fi = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        this.sum += v * v;
        if (++this.n >= this.block) {
          this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), t: currentTime });
          this.sum = 0;
          this.n = 0;
        }
        this.acc += v;
        this.accN++;
        if (++this.pos >= this.step) {
          this.pos -= this.step;
          this.frame[this.fi++] = this.acc / this.accN;
          this.acc = 0;
          this.accN = 0;
          if (this.fi === 512) {
            this.port.postMessage({ frame: this.frame }, [this.frame.buffer]);
            this.frame = new Float32Array(512);
            this.fi = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("rms-processor", RmsProcessor);
