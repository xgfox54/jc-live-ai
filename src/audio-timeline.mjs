import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readFileSync, statSync } from 'node:fs';
export class AudioTimeline {
  constructor() { this.pending = ''; this.samples = 0; this.frames = 0; this.spans = []; this.invalid = false; }
  write(text) {
    this.pending += text;
    let end;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      if (!line.includes('Parsed_ashowinfo_')) continue;
      const fields = Object.fromEntries([...line.matchAll(/\b(n|pts|rate|nb_samples|channels|fmt):([^\s]+)/g)].map(match => [match[1], match[2]]));
      const n = Number(fields.n); const pts = Number(fields.pts); const count = Number(fields.nb_samples);
      if (n !== this.frames || !Number.isSafeInteger(pts) || !Number.isSafeInteger(count) || count <= 0
        || fields.rate !== '16000' || fields.channels !== '1' || fields.fmt !== 's16') { this.invalid = true; continue; }
      this.frames++;
      const last = this.spans.at(-1);
      if (last && Math.abs(pts - last.source_pts - last.samples) <= 1) last.samples += count;
      else if (this.spans.length < 4096) this.spans.push({ pcm_sample: this.samples, source_pts: pts, samples: count, source_epoch: this.spans.length });
      else this.invalid = true;
      this.samples += count;
    }
    if (this.pending.length > 65536) { this.pending = ''; this.invalid = true; }
  }
  checkpoint(bytes) {
    const samples = Math.min(this.samples, Math.floor(bytes / 2));
    const spans = this.spans.filter(span => span.pcm_sample < samples)
      .map(span => ({ ...span, samples: Math.min(span.samples, samples - span.pcm_sample) }));
    return { version: 2, status: !this.invalid && samples > 0 && Number.isSafeInteger(bytes) && bytes % 2 === 0
      ? 'verified-prefix' : 'unverified', clock: 'decoded-source-audio', sample_rate: 16000,
      pcm_bytes: bytes, mapped_samples: samples, frames: this.frames, capture_complete: false,
      video_alignment: 'unverified', spans };
  }
  finish(bytes, complete = true) {
    if (this.pending.includes('Parsed_ashowinfo_')) this.invalid = true;
    return { version: 1, status: !this.invalid && this.frames > 0 && bytes === this.samples * 2 ? 'verified' : 'unverified',
      clock: 'decoded-source-audio', sample_rate: 16000, pcm_bytes: bytes, mapped_samples: this.samples, capture_complete: complete,
      frames: this.frames, video_alignment: 'unverified', spans: this.spans };
  }
}

export function sourceTimeAt(timeline, pcmMs) {
  if (!['verified', 'verified-prefix'].includes(timeline?.status) || !Number.isFinite(pcmMs) || pcmMs < 0
    || timeline.sample_rate !== 16000 || !Number.isSafeInteger(timeline.pcm_bytes) || timeline.pcm_bytes < 0
    || !Number.isSafeInteger(timeline.mapped_samples) || timeline.mapped_samples < 0
    || timeline.mapped_samples * 2 > timeline.pcm_bytes || !Array.isArray(timeline.spans)) return null;
  let covered = 0;
  for (const span of timeline.spans) {
    if (span.pcm_sample !== covered || !Number.isSafeInteger(span.samples) || span.samples <= 0
      || !Number.isSafeInteger(span.source_pts) || !Number.isSafeInteger(span.source_epoch)) return null;
    covered += span.samples;
  }
  if (covered !== timeline.mapped_samples || pcmMs * 16 >= covered) return null;
  const sample = pcmMs * 16;
  const span = timeline.spans.find(value => sample >= value.pcm_sample && sample < value.pcm_sample + value.samples);
  return span ? { source_seconds: (span.source_pts + sample - span.pcm_sample) / 16000, source_epoch: span.source_epoch } : null;
}

export function saveAudioTimeline(path, value) {
  const temporary = path + '.tmp';
  let fd;
  try {
    fd = openSync(temporary, 'w');
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function readAudioTimeline(path, pcmPath) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const bytes = statSync(pcmPath).size;
  if (!Number.isSafeInteger(value.pcm_bytes) || bytes < value.pcm_bytes || sourceTimeAt(value, 0) === null)
    return { ...value, status: 'unverified' };
  return value;
}
