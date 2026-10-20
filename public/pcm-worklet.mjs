class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super(); this.pending = []; this.position = 0; this.flushed = false;
    this.port.onmessage = event => {
      if (event.data !== 'flush') return;
      this.flushed = true;
      if (this.pending.length) {
        const pcm = new Int16Array(this.pending.splice(0));
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      this.port.postMessage('flushed');
    };
  }
  process(inputs) {
    if (this.flushed) return true;
    const channels = inputs[0];
    if (!channels?.[0]) return true;
    const count = channels[0].length;
    for (let i = 0; i < count; i++) {
      const sample = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
      this.position += 16000;
      if (this.position >= sampleRate) {
        this.position -= sampleRate;
        this.pending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
      }
    }
    if (this.pending.length >= 16000) {
      const pcm = new Int16Array(this.pending.splice(0, 16000));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmWorklet);
