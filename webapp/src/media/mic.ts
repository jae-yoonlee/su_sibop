// 마이크 → 30ms마다 RMS 콜백. 자동 음량 조절·잡음 제거를 꺼야 '목소리 작음'·'주변 소음' 규칙이 의미가 있다.
export interface Mic {
  stream: MediaStream;
  settings: MediaTrackSettings;
  stop(): void;
}

export async function openMic(onRms: (rms: number) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { autoGainControl: false, noiseSuppression: false, echoCancellation: false, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}rms-worklet.js`);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "rms-processor");
  node.port.onmessage = (e: MessageEvent<{ rms: number }>) => onRms(e.data.rms);
  src.connect(node);
  // 출력에 연결하지 않으면 일부 브라우저가 처리를 멈추므로, 소리 0으로 연결
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  if (ctx.state === "suspended") await ctx.resume();
  return {
    stream,
    settings: stream.getAudioTracks()[0].getSettings(),
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
