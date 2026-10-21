import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from './validate.mjs';

export class CaptureRecording {
  constructor({ scheduler, config, store }) { Object.assign(this, { scheduler, config, store }); this.sessions = new Map(); }
  append(id, packet, ack) {
    if (ack.duplicate || !this.config.recordAudio) return;
    const channel = this.scheduler.channel(id); let recording = this.sessions.get(channel.session_id);
    try {
      if (!recording) {
        const directory = resolve(this.config.recordings ?? 'data/recordings', id, channel.session_id); mkdirSync(directory, { recursive: true });
        const file = resolve(directory, 'audio.pcm'); writeFileSync(file, Buffer.alloc(0), { flag: 'wx' });
        writeFileSync(resolve(directory, 'source.json'), JSON.stringify({ stream_id: id, session_id: channel.session_id,
          format: 's16le', sample_rate: 16000, channels: 1, coverage: 'unverified', started_at: new Date().toISOString() }));
        recording = { file, bytes: 0 }; this.sessions.set(channel.session_id, recording);
      }
      if (recording.bytes + packet.pcm.length > (this.config.maxRecordingBytes ?? 1382400000)) throw new Error('quota');
      appendFileSync(recording.file, packet.pcm); recording.bytes += packet.pcm.length;
    } catch {
      channel.recording_failed = true; this.scheduler.stop(id);
      this.store.event('gap', { stream_id: id, session_id: channel.session_id, reason: 'collector_failed', extent: 'unknown' });
      throw new HttpError(503, '원음 저장에 실패해 수집을 중지했습니다. 저장 공간과 접근 권한을 확인해 주세요.');
    }
  }
}
