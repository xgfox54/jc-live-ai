// Cuts 16 kHz s16le audio at pauses so words are not split between recognition chunks.
// Once minS is buffered, a chunk closes at the latest pause (pauseMs below the noise floor x2.5); without a pause it closes
// at the quietest frame that is at least pauseMs before the buffered end, so chunks stay near minS for low latency.
// At maxS a cut is forced.
export class Segmenter {
  constructor({ minS = 4, maxS = 10, pauseMs = 300, frameMs = 20 } = {}) {
    Object.assign(this, { minS, maxS, pauseMs, frameMs });
    this.buffer = Buffer.alloc(0); this.offset = 0;
  }
  frameBytes() { return this.frameMs * 32; }
  energies(pcm) {
    const size = this.frameBytes(); const values = [];
    for (let o = 0; o + size <= pcm.length; o += size) {
      let sum = 0; for (let i = o; i < o + size; i += 2) { const v = pcm.readInt16LE(i); sum += v * v; }
      values.push(Math.sqrt(sum / (size / 2)));
    }
    return values;
  }
  cut() {
    const energies = this.energies(this.buffer); const frames = Math.round(this.pauseMs / this.frameMs);
    const first = Math.round(this.minS * 1000 / this.frameMs); const last = Math.min(energies.length, Math.round(this.maxS * 1000 / this.frameMs));
    const sorted = [...energies].sort((a, b) => a - b); const floor = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
    const quiet = Math.max(150, floor * 2.5);
    let best = null; let run = 0;
    for (let f = first; f < last; f++) {
      run = energies[f] < quiet ? run + 1 : 0;
      if (run >= frames) best = f - Math.floor(frames / 2);
    }
    if (best !== null) return best * this.frameBytes();
    if (energies.length < last) return null;
    let low = first; for (let f = first; f < last; f++) if (energies[f] < energies[low]) low = f;
    return Math.max(first, low) * this.frameBytes();
  }
  push(pcm) {
    this.buffer = Buffer.concat([this.buffer, pcm]); const out = [];
    while (this.buffer.length >= this.minS * 32000) {
      const ready = this.buffer.length >= this.maxS * 32000;
      const at = this.cut();
      if (at === null || (!ready && at >= this.buffer.length - this.pauseMs * 32)) break;
      if (!ready && this.buffer.length < this.maxS * 32000 && at === null) break;
      out.push(this.take(at));
    }
    return out;
  }
  take(bytes) {
    const pcm = Buffer.from(this.buffer.subarray(0, bytes)); const start_ms = this.offset / 32;
    this.buffer = this.buffer.subarray(bytes); this.offset += bytes;
    return { pcm, start_ms, end_ms: this.offset / 32 };
  }
  flush() { return this.buffer.length ? [this.take(this.buffer.length)] : []; }
}

