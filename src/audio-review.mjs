import { open, readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from './validate.mjs';
import { nativeSpeakers, speakerFor } from './diarization.mjs';

export class AudioReview {
  constructor({ store, registry, scheduler, config }) {
    Object.assign(this, { store, registry, scheduler, config }); this.closed = false;
    store.db.exec('CREATE TABLE IF NOT EXISTS audio_jobs(id TEXT PRIMARY KEY, document TEXT NOT NULL);');
    for (const job of this.jobs().filter(job => job.phase === 'running')) this.save({ ...job, phase: 'interrupted' });
  }
  jobs(id) { return this.store.db.prepare('SELECT document FROM audio_jobs ORDER BY rowid DESC').all().map(row => JSON.parse(row.document)).filter(job => !id || job.broadcast_id === id); }
  save(job) { this.store.db.prepare('INSERT INTO audio_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(job.id, JSON.stringify(job)); return job; }
  async recording(session) {
    if (!session || !/^ch(?:[1-9]|1[0-2])$/.test(session.stream_id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(session.session_id)) throw new HttpError(404, '원음 기록을 찾지 못했습니다.');
    const directory = resolve(this.config.recordings ?? 'data/recordings');
    const folder = resolve(directory, session.stream_id, session.session_id);
    try {
      const root = await realpath(directory); const file = await realpath(resolve(folder, 'audio.pcm'));
      if (!file.startsWith(root + sep)) throw new Error('path');
      const meta = JSON.parse(await readFile(resolve(folder, 'source.json'), 'utf8'));
      if (meta.session_id !== session.session_id || meta.stream_id !== session.stream_id || meta.format !== 's16le' || meta.sample_rate !== 16000 || meta.channels !== 1)
        throw new Error('metadata');
      return { file, bytes: (await stat(file)).size };
    } catch { throw new HttpError(404, '일치하는 저장 원음이 없습니다. 원음과 메타데이터를 확인해 주세요.'); }
  }
  async clip(id) {
    const value = this.store.db.prepare('SELECT document FROM segments WHERE id=?').get(id);
    if (!value) throw new HttpError(404, '문장을 찾지 못했습니다.');
    const segment = JSON.parse(value.document);
    if (segment.timeline_epoch !== undefined && segment.timeline_epoch !== 0) throw new HttpError(409, '시간축이 변경된 원음은 정확한 위치를 확인할 수 없습니다.');
    const sessionRow = this.store.db.prepare('SELECT document FROM sessions WHERE id=?').get(segment.session_id);
    let session = sessionRow && JSON.parse(sessionRow.document);
    if (session?.source_session) session = { ...session, session_id: session.source_session };
    const recording = await this.recording(session);
    const start = Math.floor(segment.start_ms * 32 / 2) * 2; const end = Math.floor(segment.end_ms * 32 / 2) * 2;
    if (start < 0 || end <= start || end > recording.bytes || end - start > 32000 * 120) throw new HttpError(409, '원음 범위를 확인할 수 없습니다.');
    const pcm = Buffer.alloc(end - start); const handle = await open(recording.file, 'r');
    try { const { bytesRead } = await handle.read(pcm, 0, pcm.length, start); if (bytesRead !== pcm.length) throw new HttpError(409, '원음이 불완전합니다.'); }
    finally { await handle.close(); }
    const wav = Buffer.alloc(44); wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([wav, pcm]);
  }
  async recordings(id) {
    if (!this.registry.get(id)) throw new HttpError(404, '방송 기록을 찾지 못했습니다.');
    const output = [];
    for (const session of this.registry.sessions(id).filter(session => !session.source_session)) {
      try { const data = await this.recording(session); output.push({ session_id: session.session_id, seconds: data.bytes / 32000,
        processed_s: session.total_processed_s ?? 0, state: session.state, available: true }); }
      catch { output.push({ session_id: session.session_id, state: session.state, available: false }); }
    }
    return output;
  }
  async start(id, value) {
    if (this.closed || this.pending) throw new HttpError(409, '다른 원음 작업을 마친 뒤 시작해 주세요.');
    if (!this.registry.get(id)) throw new HttpError(404, '방송 기록을 찾지 못했습니다.');
    const previous = value.job_id ? this.jobs(id).find(job => job.id === value.job_id) : null;
    if (value.job_id && !previous) throw new HttpError(404, '재개할 작업을 찾지 못했습니다.');
    const source = this.registry.sessions(id).find(session => session.session_id === (previous?.source_session ?? value.session_id));
    if (!source || source.source_session) throw new HttpError(400, '원본 세션을 선택해 주세요.');
    if (this.scheduler.states().some(state => ['running', 'draining', 'degraded', 'reconnecting'].includes(state.state))) throw new HttpError(409, '모든 수집을 마친 뒤 재전사합니다.');
    if (['running', 'draining', 'degraded', 'reconnecting'].includes(source.state) || source.timeline_epoch > 0) throw new HttpError(409, '원음 수집 종료와 시간축을 확인해 주세요.');
    const data = await this.recording(source);
    const digest = createHash('sha256'); for await (const part of createReadStream(data.file)) digest.update(part);
    const sourceHash = digest.digest('hex');
    if (previous?.source_sha256 && previous.source_sha256 !== sourceHash) throw new HttpError(409, '원음 내용이 변경되어 이어 처리할 수 없습니다.');
    if (this.pending || this.closed) throw new HttpError(409, '다른 원음 작업이 진행 중입니다.');
    if (previous?.total_bytes !== undefined && data.bytes !== previous.total_bytes) throw new HttpError(409, '원음 크기가 변경되어 이어 처리할 수 없습니다.');
    const start = value.recover === true ? Math.min(data.bytes, Math.floor((source.audio_processed_until ?? 0) * 32 / 2) * 2) : 0;
    if (value.recover === true && (source.total_gap_s ?? 0) > 0) throw new HttpError(409, '중간 누락이 있어 전체 재전사가 필요합니다.');
    const job = { ...(previous ?? { id: randomUUID(), broadcast_id: id, source_session: source.session_id, stream_id: source.stream_id,
      session_id: randomUUID(), offset: start, started_ms: Date.now(), total_bytes: data.bytes }), phase: 'running', error: null };
    job.source_sha256 = sourceHash;
    job.result_id ??= createHash('sha256').update('retranscription:' + job.id).digest('hex');
    if (!this.registry.get(job.result_id)) this.registry.save({ ...this.registry.get(id), id: job.result_id,
      title: this.registry.get(id).title + ' · 재전사', original_id: id, completed: true, phase: 'ended', suspended: true });
    this.save(job); this.store.db.prepare('INSERT OR IGNORE INTO broadcast_sessions VALUES(?,?)').run(job.session_id, job.result_id);
    this.store.saveSession({ session_id: job.session_id, stream_id: source.stream_id, state: 'stopped', timeline_epoch: 0,
      source_session: source.session_id, purpose: 'retranscription', started_ms: job.started_ms });
    this.paused = false;
    this.pending = this.run(job, data.file).finally(() => { this.pending = null; }); return job;
  }
  async run(job, file) {
    const handle = await open(file, 'r');
    try {
      while (job.offset < job.total_bytes && !this.paused && !this.closed) {
        const pcm = Buffer.alloc(Math.min(32000 * 10, job.total_bytes - job.offset) & ~1);
        if (!pcm.length) break;
        const { bytesRead } = await handle.read(pcm, 0, pcm.length, job.offset); if (bytesRead !== pcm.length) throw new Error('원음이 불완전합니다.');
        const start_ms = job.offset / 32; const end_ms = (job.offset + pcm.length) / 32;
        const result = await this.scheduler.background({ stream_id: job.stream_id, pcm, start_ms, end_ms,
          epoch: 0, unique_s: pcm.length / 32000, prompt: '', session_id: job.session_id });
        const raw_text = result.spans.map(span => span.text).join('').trim();
        job.offset += pcm.length; job.elapsed_ms = Date.now() - job.started_ms;
        job.remaining_ms = job.offset ? Math.round(job.elapsed_ms * (job.total_bytes - job.offset) / job.offset) : null;
        if (raw_text) this.store.segment({ stream_id: job.stream_id, session_id: job.session_id, timeline_epoch: 0,
          start_ms, end_ms, raw_text, ready_ms: Date.now(), timestamp_quality: 'chunk-envelope' }, () => this.save(job));
        else this.save(job);
      }
      this.save({ ...job, phase: job.offset >= job.total_bytes ? 'completed' : 'paused' });
    } catch (error) { this.save({ ...job, phase: 'paused', error: error.status === 409 ? error.message : '원음 처리에 실패했습니다. 저장한 위치에서 재개해 주세요.' }); }
    finally { await handle.close(); }
  }
  async diarize(id, sessionId, runner = nativeSpeakers) {
    if (this.closed || this.pending || this.scheduler.busy || this.scheduler.states().some(state => ['running', 'draining', 'degraded'].includes(state.state))) throw new HttpError(409, '수집과 원음 처리를 마친 뒤 참여자를 분석해 주세요.');
    const session = this.registry.sessions(id).find(item => item.session_id === sessionId);
    if (!session || session.source_session || session.timeline_epoch > 0) throw new HttpError(400, '원본 세션과 시간축을 확인해 주세요.');
    const recording = await this.recording(session);
    if (this.pending || this.closed) throw new HttpError(409, '다른 원음 작업이 진행 중입니다.');
    if (recording.bytes < 32000 || recording.bytes > 32000 * 86400 || recording.bytes % 2) throw new HttpError(400, '분석할 원음 길이를 확인해 주세요.');
    const rows = this.registry.segments(id).filter(row => row.session_id === sessionId);
    const job = this.save({ id: randomUUID(), kind: 'diarization', broadcast_id: id, session_id: sessionId,
      phase: 'running', offset: 0, total_bytes: recording.bytes, started_ms: Date.now() });
    this.controller = new AbortController();
    this.pending = (async () => {
      try {
        const spans = await runner(recording, this.config, this.controller.signal); let applied = 0;
        for (const row of rows) {
          if (row.speaker_method === 'manual') continue;
          const speaker = speakerFor(row, spans); if (!speaker) continue;
          try { this.store.speaker(row.segment_id, row.version, speaker, 'nemotron'); applied++; } catch (error) { if (error.status !== 409) throw error; }
        }
        this.save({ ...job, phase: 'completed', offset: recording.bytes, applied, model: 'nvidia/Nemotron-3-Diarization', spans });
      } catch { this.save({ ...job, phase: 'failed', error: '참여자 분석에 실패했거나 중단됐습니다. 기존 지정은 보존했습니다.' }); }
    })().finally(() => { this.pending = null; });
    return job;
  }
  pause() { this.paused = true; this.controller?.abort(); return { pausing: true }; }
  async close() { this.closed = true; this.paused = true; this.controller?.abort(); await this.pending; }
}
