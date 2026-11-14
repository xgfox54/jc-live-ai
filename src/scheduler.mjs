import { randomUUID } from 'node:crypto';
import { HttpError } from './validate.mjs';
import { RecoveryQueue } from './recovery-queue.mjs';
import { Segmenter } from './segmenter.mjs';
import { nonSpeech, stripInvented } from './silence-filter.mjs';
import { speechActivity } from './speech-activity.mjs';

export class Scheduler {
  constructor(store, engine, config) {
    this.store = store; this.engine = engine; this.config = config;
    this.channels = new Map(); this.last = -1; this.busy = false; this.active = 0; this.accepting = true;
    this.metrics = { jobs: 0, silence: 0, near_silence: 0, gaps: 0, errors: 0, unique_audio_s: 0, inferred_audio_s: 0 };
    this.samples = []; this.started_ms = Date.now(); this.finishes = new Set();
    this.recognizing = 0; this.recognitionWaiters = [];
    this.recovery = new RecoveryQueue(store); this.closed = false;
    for (const { job, session } of this.recovery.restore()) {
      if (this.recovery.hasSegment(job)) { this.recovery.complete(job); continue; }
      let c = this.channels.get(job.stream_id);
      if (!c) {
        c = { ...session, state: 'draining', input_end_reason: 'process_restart', queue: [],
          segmenter: this.segmenter(), inflight: false, received: 0, next_seq: 0, prompt: job.prompt };
        this.channels.set(job.stream_id, c);
      }
      c.queue.push(job);
    }
    if (this.channels.size) this.wake();
  }
  segmenter() {
    const [minS, maxS] = this.config.segmentSeconds ?? [this.config.chunkSeconds, this.config.chunkSeconds];
    return new Segmenter({ minS, maxS });
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
      last_speech_segment_end: null, last_receive_ms: null, queue: [], segmenter: this.segmenter(), inflight: false,
      received: 0, next_seq: 0, prompt: stream.prompt ?? '', config: this.engine.metadata,
      total_received_s: 0, total_processed_s: 0, total_gap_s: 0 };
    this.channels.set(stream.stream_id, channel); this.save(channel); return this.public(channel);
  }
  public(c) {
    return { stream_id: c.stream_id, session_id: c.session_id, timeline_epoch: c.timeline_epoch,
      state: c.state === 'running' && (!this.engine.ready || c.error || c.queue.some(j => Date.now() - j.received_ms > 20000)) ? 'degraded' : c.state,
      started_ms: c.started_ms, ended_ms: c.ended_ms ?? null, input_end_reason: c.input_end_reason ?? null,
      audio_received_until: c.audio_received_until, audio_processed_until: c.audio_processed_until,
      last_speech_segment_end: c.last_speech_segment_end, last_receive_ms: c.last_receive_ms,
      video_offset_ms: c.video_offset_ms ?? null, video_id: c.video_id ?? null, content_from_ms: c.content_from_ms ?? null,
      queue_length: c.queue.length, queue_audio_s: c.queue.reduce((sum, j) => sum + j.unique_s, 0),
      queue_oldest_ms: c.queue[0] ? Date.now() - c.queue[0].received_ms : 0,
      input_stale: c.state === 'running' && Date.now() - (c.last_receive_ms ?? c.started_ms) > 10_000,
      total_received_s: c.total_received_s, total_processed_s: c.total_processed_s,
      last_processed_ms: c.last_processed_ms ?? null, last_processing_result: c.last_processing_result ?? null,
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
  feed(id, packet, { receivedMs = Date.now() } = {}) {
    const c = this.channel(id);
    if (c.state !== 'running') throw new HttpError(409, 'Stream is not accepting audio');
    if (packet.session_id !== c.session_id || packet.epoch !== c.timeline_epoch) throw new HttpError(409, 'Session or epoch changed');
    if (packet.seq < c.next_seq) return { duplicate: true, next_seq: c.next_seq };
    if (packet.seq !== c.next_seq) throw new HttpError(409, 'Missing packet; create a new epoch');
    if (packet.pcm.length === 0 || packet.pcm.length % 2 || packet.pcm.length > 32_000) throw new HttpError(400, 'Expected up to one second of s16le 16 kHz mono');
    if (!Number.isSafeInteger(receivedMs) || receivedMs <= 0) throw new HttpError(400, 'Invalid receive time');
    c.next_seq++; c.last_receive_ms = Math.max(c.last_receive_ms ?? 0, receivedMs);
    c.total_received_s += packet.pcm.length / 32_000;
    for (const piece of c.segmenter.push(packet.pcm)) this.enqueue(c, piece.pcm);
    const buffer = c.segmenter.buffer;
    c.audio_received_until = (c.received + buffer.length / 2) / 16;
    if (this.config.interim === true && this.config.chunkSeconds === 10 && buffer.length >= 160000 && c.preview_at !== c.received) {
      c.preview_at = c.received;
      if (c.queue.length < this.config.queueChunks - 1) c.queue.push({ stream_id: id, session_id: c.session_id, epoch: c.timeline_epoch,
        pcm: Buffer.from(buffer), partial: true, start_ms: c.received / 16, end_ms: (c.received + buffer.length / 2) / 16,
        prompt: c.prompt, received_ms: c.last_receive_ms, enqueued_ms: Date.now(), unique_s: 0 });
    }
    this.pump(); return { duplicate: false, next_seq: c.next_seq };
  }
  flush(c) {
    for (const piece of c.segmenter.flush()) this.enqueue(c, piece.pcm);
    c.segmenter = this.segmenter();
  }
  gap(c, job, reason) {
    this.metrics.gaps++; c.total_gap_s += job.unique_s; this.recovery.complete(job);
    this.store.event('gap', { stream_id: c.stream_id, session_id: c.session_id,
      timeline_epoch: job.epoch, start_ms: job.start_ms, end_ms: job.end_ms, reason });
  }
  enqueue(c, pcm) {
    const start_ms = c.received / 16;
    c.received += pcm.length / 2;
    const job = { stream_id: c.stream_id, session_id: c.session_id, epoch: c.timeline_epoch,
      start_ms, end_ms: c.received / 16, unique_s: pcm.length / 32_000,
      received_ms: c.last_receive_ms ?? Date.now(), pcm, prompt: c.prompt, enqueued_ms: Date.now() };
    c.queue = c.queue.filter(item => !item.partial);
    while (c.queue.reduce((sum, item) => sum + item.unique_s, 0) + job.unique_s > Math.min(7200, Math.max(10, this.config.recoverySeconds || 7200)) && c.queue.length) {
      const dropped = c.queue.shift(); this.gap(c, dropped, 'queue_overflow');
      this.store.event('status', { ...this.public(c), state: 'degraded', reason: 'queue_overflow' });
    }
    c.queue.push(this.recovery.put(job));
    c.audio_received_until = job.end_ms; this.save(c);
  }
  epoch(id) {
    const c = this.channel(id);
    if (c.state !== 'running') throw new HttpError(409, 'Stream is stopped');
    this.flush(c);
    c.timeline_epoch++; c.received = 0; c.next_seq = 0;
    c.partial = null; c.preview_at = null;
    c.audio_received_until = 0; c.audio_processed_until = 0; c.last_speech_segment_end = null;
    this.store.event('gap', { stream_id: id, session_id: c.session_id, timeline_epoch: c.timeline_epoch,
      reason: 'input_discontinuity', extent: 'unknown' });
    this.save(c); this.pump(); return this.public(c);
  }
  stop(id, reason = 'manual') {
    const c = this.channel(id);
    if (c.state !== 'running') return this.public(c);
    c.state = 'draining'; c.input_end_reason = reason;
    this.flush(c);
    this.save(c); this.pump(); this.finish(c); return this.public(c);
  }
  finish(c) {
    if (c.state === 'draining' && c.queue.length === 0 && !c.inflight && !c.finishing) {
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
    const ready = c => c.queue.length && !c.inflight && (c.queue[0].retry_at ?? 0) <= Date.now();
    const overdue = channels.filter(c => ready(c) && Date.now() - c.queue[0].received_ms > 20000)
      .sort((a, b) => a.queue[0].received_ms - b.queue[0].received_ms);
    if (overdue.length) { this.last = channels.indexOf(overdue[0]); return overdue[0]; }
    for (let n = 1; n <= channels.length; n++) {
      const index = (this.last + n) % channels.length;
      if (ready(channels[index])) { this.last = index; return channels[index]; }
    }
    return null;
  }
  wake() {
    if (this.closed || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.pump(); }, 100);
    this.wakeTimer.unref();
  }
  retry(c, job, error) {
    if (job.partial || error.code !== 'ENGINE_UNAVAILABLE') return false;
    job.attempts = (job.attempts ?? 0) + 1;
    if (job.attempts > 8) return false;
    job.retry_at = Date.now() + Math.min(60_000, (this.config.recoveryRetryMs ?? 1000) * 2 ** (job.attempts - 1));
    c.error = error.message;
    c.queue.unshift(this.recovery.put(job));
    this.store.event('status', { ...this.public(c), state: 'degraded', reason: 'engine_recovery' });
    this.wake(); return true;
  }
  pump() {
    if (this.closed) return;
    const capacity = this.engine.capacity ?? 1;
    const pipeline = Boolean(this.diarizer) && this.config.pipelineOverlap !== false;
    while (this.engine.ready && (pipeline || (this.engine.available ?? 1) > 0)
      && this.active < capacity + (pipeline ? 1 : 0) && !this.exclusive) {
      const c = this.next(); if (!c) break;
      let job = c.queue.shift();
      if (!job.partial && this.recovery.hasSegment(job)) { this.recovery.complete(job); this.finish(c); continue; }
      if (!job.partial) job = this.recovery.load(job);
      c.inflight = true; this.active++; this.busy = true;
      this.run(c, job).finally(() => {
        c.inflight = false; this.active--; this.busy = this.active > 0; this.finish(c); this.pump();
      });
    }
    if ([...this.channels.values()].some(c => c.queue.length)) this.wake();
  }
  async recognize(job) {
    const waitingAt = Date.now();
    if (this.recognizing >= (this.engine.capacity ?? 1))
      await new Promise(resolve => this.recognitionWaiters.push(resolve));
    else this.recognizing++;
    job.recognition_wait_ms = Date.now() - waitingAt;
    try { return await this.engine.transcribe(job); }
    finally {
      const next = this.recognitionWaiters.shift();
      if (next) next(); else this.recognizing--;
    }
  }
  async run(c, job) {
        const started = Date.now();
        try {
          const diarizationStarted = Date.now();
          if (!Object.hasOwn(job, 'diarization_result')) {
            job.diarization_result = !job.partial && this.diarizer
              ? await this.diarizer.process(job).catch(() => ({ speaker_state: 'unavailable', speaker_turns: [] })) : null;
          }
          const diarizationElapsed = Date.now() - diarizationStarted;
          const speakers = job.diarization_result;
          const gate = this.config.speechGate === true || this.config.silenceRms > 0;
          const acoustic_activity = gate && this.vad ? await this.vad.process(job) : undefined;
          const activity = gate ? speechActivity(job.pcm, speakers, { ...job, acoustic_activity }) : { state: 'unknown', method: 'disabled' };
          const silent = activity.state === 'silence';
          const result = silent ? { spans: [], inference_ms: 0 } : await this.recognize(job);
          const evidence = { ...(speakers ?? {}), speech_activity: activity };
          if (speakers) c.diarization = { state: speakers.speaker_state, scope: speakers.speaker_scope,
            processed_until_ms: speakers.processed_until_ms, error: speakers.diarization_error ?? null };
          if (job.partial) {
            if (job.epoch === c.timeline_epoch) {
              c.partial = { stream_id: c.stream_id, session_id: c.session_id, timeline_epoch: job.epoch,
                start_ms: job.start_ms, end_ms: job.end_ms, raw_text: result.spans.map(span => span.text).join('').trim(), status: 'provisional' };
              this.store.event('partial', c.partial); this.save(c);
            }
            return;
          }
          this.metrics.jobs++; this.metrics.unique_audio_s += job.unique_s;
          this.metrics.inferred_audio_s += silent ? 0 : job.unique_s;
          if (silent) this.metrics.silence++;
          if (activity.method === 'near-silence') this.metrics.near_silence++;
          c.total_processed_s += job.unique_s;
          if (job.epoch === c.timeline_epoch) c.audio_processed_until = job.end_ms;
          let main_text = result.spans.map(s => s.text).join('').trim();
          if (main_text && nonSpeech(main_text, evidence))
            this.store.db.prepare('INSERT INTO recognition_suppressed(session_id,start_ms,end_ms,document) VALUES(?,?,?,?)')
              .run(job.session_id, job.start_ms, job.end_ms, JSON.stringify({ raw_text: main_text, evidence }));
          if (nonSpeech(main_text, evidence)) { main_text = ''; this.metrics.silence_artifacts = (this.metrics.silence_artifacts ?? 0) + 1; }
          // Music under real speech makes Whisper append invented phrases ("…부르겠습니다. 찬송가 2장"). They are cut out
          // and the recognized text is kept with the segment.
          const recognized_text = main_text; main_text = stripInvented(main_text);
          const raw_text = main_text;
          if (c.partial && c.partial.timeline_epoch === job.epoch && c.partial.start_ms <= job.start_ms) c.partial = null;
          if (raw_text && !(Number.isFinite(c.resume_floor_ms) && Number.isFinite(c.video_offset_ms) && job.end_ms + c.video_offset_ms <= c.resume_floor_ms)) {
            this.store.segment({ stream_id: c.stream_id, session_id: c.session_id,
              timeline_epoch: job.epoch, start_ms: job.start_ms, end_ms: job.end_ms, raw_text,
              video_offset_ms: c.video_offset_ms ?? null, video_id: c.video_id ?? null,
              ...(main_text !== recognized_text ? { recognized_text } : {}),
              live_preview: Boolean(main_text), preview_updated_ms: Date.now(),
              ready_ms: Date.now(), audio_received_ms: job.received_ms, timestamp_quality: 'chunk-envelope',
              latency_ms: Date.now() - job.received_ms + job.unique_s * 1000, ...evidence });
            if (job.epoch === c.timeline_epoch) c.last_speech_segment_end = job.end_ms;
          }
          const sample = { stream_id: c.stream_id, session_id: c.session_id, epoch: job.epoch,
            start_ms: job.start_ms, end_ms: job.end_ms, unique_s: job.unique_s, silent,
            queue_ms: started - job.enqueued_ms, inference_ms: result.inference_ms,
            diarization_wall_ms: diarizationElapsed, recognition_wait_ms: job.recognition_wait_ms ?? 0,
            pipeline_ms: Date.now() - started,
            diarization_ms: speakers?.diarization_ms ?? 0, speaker_state: speakers?.speaker_state ?? 'disabled',
            ready_ms: Date.now(), readiness_ms: Date.now() - job.received_ms + job.unique_s * 1000 };
          this.samples.push(sample); if (this.samples.length > 20_000) this.samples.shift();
          this.store.event('metric', sample);
          c.last_processed_ms = Date.now(); c.last_processing_result = raw_text ? 'speech' : silent ? 'silent' : 'unknown';
          c.error = null;
          this.save(c);
          this.recovery.complete(job);
        } catch (error) {
          if (job.partial) { c.partial = null; this.save(c); return; }
          if (this.retry(c, job, error)) return;
          this.metrics.errors++; c.error = error.message; this.gap(c, job, 'inference_failed');
          this.recovery.complete(job);
          this.store.event('status', { ...this.public(c), state: 'degraded' });
        }
  }
  async close() {
    this.accepting = false;
    for (const id of this.channels.keys()) this.stop(id);
    const deadline = Date.now() + 95_000;
    while ((this.busy || this.finishes.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    this.closed = true; clearTimeout(this.wakeTimer);
    await this.diarizer?.close(); await this.vad?.stop(); await this.engine.stop();
  }
  async background(job) {
    if (!this.accepting || !this.engine.ready || this.busy || this.states().some(state => ['running', 'draining', 'degraded', 'reconnecting'].includes(state.state)))
      throw new HttpError(409, '실시간 음성 처리를 마친 뒤 재전사를 시작해 주세요.');
    this.busy = true; this.exclusive = true;
    try { return await this.engine.transcribe(job); }
    finally { this.exclusive = false; this.busy = this.active > 0; this.pump(); }
  }
}
