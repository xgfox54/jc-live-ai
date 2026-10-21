import { randomUUID } from 'node:crypto';
import { HttpError } from './validate.mjs';

export class Scheduler {
  constructor(store, engine, config) {
    this.store = store; this.engine = engine; this.config = config;
    this.channels = new Map(); this.last = -1; this.busy = false; this.accepting = true;
    this.metrics = { jobs: 0, silence: 0, gaps: 0, errors: 0, unique_audio_s: 0, inferred_audio_s: 0 };
    this.samples = []; this.started_ms = Date.now(); this.finishes = new Set();
  }
  start(stream) {
    if (!this.accepting || !this.engine.ready) throw new HttpError(503, 'Transcription engine is not ready');
    if (this.diarizer && !this.diarizer.engine.ready) throw new HttpError(503, 'Live diarization engine is not ready');
    const existing = this.channels.get(stream.stream_id);
    if (existing && ['running', 'draining'].includes(existing.state)) throw new HttpError(409, 'Stream already active');
    if ([...this.channels.values()].filter(channel => ['running', 'draining'].includes(channel.state)).length >= 8)
      throw new HttpError(409, '동시 전사는 최대 8개입니다. 수집 중인 채널을 중지한 뒤 다시 시작해 주세요.');
    const channel = { stream_id: stream.stream_id, session_id: randomUUID(), timeline_epoch: 0,
      state: 'running', started_ms: Date.now(), audio_received_until: 0, audio_processed_until: 0,
      last_speech_segment_end: null, last_receive_ms: null, queue: [], buffer: Buffer.alloc(0),
      received: 0, next_seq: 0, prompt: stream.prompt ?? '', config: this.engine.metadata,
      total_received_s: 0, total_processed_s: 0, total_gap_s: 0 };
    this.channels.set(stream.stream_id, channel); this.save(channel); return this.public(channel);
  }
  public(c) {
    return { stream_id: c.stream_id, session_id: c.session_id, timeline_epoch: c.timeline_epoch,
      state: c.state === 'running' && (c.error || c.queue.some(j => Date.now() - j.received_ms > 20000)) ? 'degraded' : c.state,
      started_ms: c.started_ms, ended_ms: c.ended_ms ?? null,
      audio_received_until: c.audio_received_until, audio_processed_until: c.audio_processed_until,
      last_speech_segment_end: c.last_speech_segment_end, last_receive_ms: c.last_receive_ms,
      queue_length: c.queue.length, queue_audio_s: c.queue.reduce((sum, j) => sum + j.unique_s, 0),
      queue_oldest_ms: c.queue[0] ? Date.now() - c.queue[0].received_ms : 0,
      input_stale: c.state === 'running' && Date.now() - (c.last_receive_ms ?? c.started_ms) > 10_000,
      total_received_s: c.total_received_s, total_processed_s: c.total_processed_s,
      total_gap_s: c.total_gap_s, model: c.config, error: c.error ?? null,
      sync_state: 'unverified', timestamp_quality: 'chunk-envelope', partial: c.partial ?? null,
      diarization: c.diarization ?? null };
  }
  states() { return [...this.channels.values()].map(c => this.public(c)); }
  save(c) { this.store.saveSession(this.public(c)); }
  channel(id) {
    const channel = this.channels.get(id);
    if (!channel) throw new HttpError(404, 'Active stream not found');
    return channel;
  }
  feed(id, packet) {
    const c = this.channel(id);
    if (!this.engine.ready) throw new HttpError(503, 'Transcription engine failed; stop and restart the service');
    if (c.state !== 'running') throw new HttpError(409, 'Stream is not accepting audio');
    if (packet.session_id !== c.session_id || packet.epoch !== c.timeline_epoch) throw new HttpError(409, 'Session or epoch changed');
    if (packet.seq < c.next_seq) return { duplicate: true, next_seq: c.next_seq };
    if (packet.seq !== c.next_seq) throw new HttpError(409, 'Missing packet; create a new epoch');
    if (packet.pcm.length === 0 || packet.pcm.length % 2 || packet.pcm.length > 32_000) throw new HttpError(400, 'Expected up to one second of s16le 16 kHz mono');
    c.next_seq++; c.last_receive_ms = Date.now();
    c.total_received_s += packet.pcm.length / 32_000;
    c.buffer = Buffer.concat([c.buffer, packet.pcm]);
    c.audio_received_until = (c.received + c.buffer.length / 2) / 16;
    const bytes = this.config.chunkSeconds * 32_000;
    while (c.buffer.length >= bytes) {
      const pcm = Buffer.from(c.buffer.subarray(0, bytes));
      c.buffer = c.buffer.subarray(bytes); this.enqueue(c, pcm);
    }
    if (this.config.interim === true && this.config.chunkSeconds === 10 && c.buffer.length >= 160000 && c.preview_at !== c.received) {
      c.preview_at = c.received;
      if (c.queue.length < this.config.queueChunks - 1) c.queue.push({ stream_id: id, session_id: c.session_id, epoch: c.timeline_epoch,
        pcm: Buffer.from(c.buffer), partial: true, start_ms: c.received / 16, end_ms: (c.received + c.buffer.length / 2) / 16,
        prompt: c.prompt, received_ms: Date.now(), enqueued_ms: Date.now(), unique_s: 0 });
    }
    this.pump(); return { duplicate: false, next_seq: c.next_seq };
  }
  gap(c, job, reason) {
    this.metrics.gaps++; c.total_gap_s += job.unique_s;
    this.store.event('gap', { stream_id: c.stream_id, session_id: c.session_id,
      timeline_epoch: job.epoch, start_ms: job.start_ms, end_ms: job.end_ms, reason });
  }
  enqueue(c, pcm) {
    const start_ms = c.received / 16;
    c.received += pcm.length / 2;
    const job = { stream_id: c.stream_id, session_id: c.session_id, epoch: c.timeline_epoch,
      start_ms, end_ms: c.received / 16, unique_s: pcm.length / 32_000,
      received_ms: Date.now(), pcm, prompt: c.prompt, enqueued_ms: Date.now() };
    c.queue = c.queue.filter(item => !item.partial);
    if (c.queue.length >= this.config.queueChunks) {
      const dropped = c.queue.shift(); this.gap(c, dropped, 'queue_overflow');
      this.store.event('status', { ...this.public(c), state: 'degraded', reason: 'queue_overflow' });
    }
    c.queue.push(job);
  }
  epoch(id) {
    const c = this.channel(id);
    if (c.state !== 'running') throw new HttpError(409, 'Stream is stopped');
    if (c.buffer.length) { this.enqueue(c, Buffer.from(c.buffer)); c.buffer = Buffer.alloc(0); }
    c.timeline_epoch++; c.received = 0; c.next_seq = 0;
    c.partial = null; c.preview_at = null;
    c.audio_received_until = 0; c.audio_processed_until = 0; c.last_speech_segment_end = null;
    this.store.event('gap', { stream_id: id, session_id: c.session_id, timeline_epoch: c.timeline_epoch,
      reason: 'input_discontinuity', extent: 'unknown' });
    this.save(c); this.pump(); return this.public(c);
  }
  stop(id) {
    const c = this.channel(id);
    if (c.state !== 'running') return this.public(c);
    c.state = 'draining';
    if (c.buffer.length) { this.enqueue(c, Buffer.from(c.buffer)); c.buffer = Buffer.alloc(0); }
    this.save(c); this.pump(); this.finish(c); return this.public(c);
  }
  finish(c) {
    if (c.state === 'draining' && c.queue.length === 0 && this.inflight !== c.session_id && !c.finishing) {
      if (this.diarizer) {
        c.finishing = true;
        const task = this.diarizer.finish(c).then(result => { if (result) c.diarization = result; }).finally(() => {
          c.state = 'stopped'; c.ended_ms = Date.now(); this.save(c); this.finishes.delete(task);
        });
        this.finishes.add(task);
      } else { c.state = 'stopped'; c.ended_ms = Date.now(); this.save(c); }
    }
  }
  next() {
    const channels = [...this.channels.values()];
    const overdue = channels.filter(c => c.queue.length && Date.now() - c.queue[0].received_ms > 20000)
      .sort((a, b) => a.queue[0].received_ms - b.queue[0].received_ms);
    if (overdue.length) { this.last = channels.indexOf(overdue[0]); return overdue[0]; }
    for (let n = 1; n <= channels.length; n++) {
      const index = (this.last + n) % channels.length;
      if (channels[index].queue.length) { this.last = index; return channels[index]; }
    }
    return null;
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let c = this.next(); c; c = this.next()) {
        const job = c.queue.shift(); this.inflight = c.session_id;
        const started = Date.now();
        try {
          let energy = 0;
          for (let i = 0; i < job.pcm.length; i += 2) energy += (job.pcm.readInt16LE(i) / 32768) ** 2;
          const silent = this.config.silenceRms > 0 && Math.sqrt(energy / (job.pcm.length / 2)) < this.config.silenceRms;
          const diarizationTask = !job.partial && this.diarizer ? this.diarizer.process(job) : Promise.resolve(null);
          const [recognition, diarization] = await Promise.allSettled([
            silent ? Promise.resolve({ spans: [], inference_ms: 0 }) : this.engine.transcribe(job), diarizationTask]);
          if (recognition.status === 'rejected') throw recognition.reason;
          const result = recognition.value;
          const speakers = diarization.status === 'fulfilled' ? diarization.value
            : { speaker_state: 'unavailable', diarization_error: String(diarization.reason) };
          if (speakers) c.diarization = { state: speakers.speaker_state, scope: speakers.speaker_scope,
            processed_until_ms: speakers.processed_until_ms, error: speakers.diarization_error ?? null };
          if (job.partial) {
            if (job.epoch === c.timeline_epoch) {
              c.partial = { stream_id: c.stream_id, session_id: c.session_id, timeline_epoch: job.epoch,
                start_ms: job.start_ms, end_ms: job.end_ms, raw_text: result.spans.map(span => span.text).join('').trim(), status: 'provisional' };
              this.store.event('partial', c.partial); this.save(c);
            }
            this.inflight = null; this.finish(c); continue;
          }
          this.metrics.jobs++; this.metrics.unique_audio_s += job.unique_s;
          this.metrics.inferred_audio_s += silent ? 0 : job.unique_s;
          if (silent) this.metrics.silence++;
          c.total_processed_s += job.unique_s;
          if (job.epoch === c.timeline_epoch) c.audio_processed_until = job.end_ms;
          const raw_text = result.spans.map(s => s.text).join('').trim();
          if (c.partial && c.partial.timeline_epoch === job.epoch && c.partial.start_ms <= job.start_ms) c.partial = null;
          if (raw_text) {
            this.store.segment({ stream_id: c.stream_id, session_id: c.session_id,
              timeline_epoch: job.epoch, start_ms: job.start_ms, end_ms: job.end_ms, raw_text,
              ready_ms: Date.now(), audio_received_ms: job.received_ms, timestamp_quality: 'chunk-envelope',
              latency_ms: Date.now() - job.received_ms + job.unique_s * 1000, ...(speakers ?? {}) });
            if (job.epoch === c.timeline_epoch) c.last_speech_segment_end = job.end_ms;
          }
          const sample = { stream_id: c.stream_id, session_id: c.session_id, epoch: job.epoch,
            start_ms: job.start_ms, end_ms: job.end_ms, unique_s: job.unique_s, silent,
            queue_ms: started - job.enqueued_ms, inference_ms: result.inference_ms,
            diarization_ms: speakers?.diarization_ms ?? 0, speaker_state: speakers?.speaker_state ?? 'disabled',
            ready_ms: Date.now(), readiness_ms: Date.now() - job.received_ms + job.unique_s * 1000 };
          this.samples.push(sample); if (this.samples.length > 20_000) this.samples.shift();
          this.store.event('metric', sample);
          this.save(c);
        } catch (error) {
          if (job.partial) { this.inflight = null; c.partial = null; this.save(c); this.finish(c); continue; }
          this.metrics.errors++; c.error = error.message; this.gap(c, job, 'inference_failed');
          this.store.event('status', { ...this.public(c), state: 'degraded' });
        }
        this.inflight = null; this.finish(c);
      }
    } finally { this.busy = false; }
  }
  async close() {
    this.accepting = false;
    for (const id of this.channels.keys()) this.stop(id);
    const deadline = Date.now() + 95_000;
    while ((this.busy || this.finishes.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    await this.diarizer?.close(); await this.engine.stop();
  }
  async background(job) {
    if (!this.accepting || !this.engine.ready || this.busy || this.states().some(state => ['running', 'draining', 'degraded', 'reconnecting'].includes(state.state)))
      throw new HttpError(409, '실시간 음성 처리를 마친 뒤 재전사를 시작해 주세요.');
    this.busy = true;
    try { return await this.engine.transcribe(job); }
    finally { this.busy = false; this.pump(); }
  }
}
