import { randomUUID } from 'node:crypto';
import { DiarizationEngine } from './diarization-engine.mjs';

export function speakerAnnotation(job, reply, context) {
  if (!Number.isFinite(reply.processed_s) || reply.processed_s < 0
    || reply.processed_s * 1000 > context.next_ms - context.base_ms + 100
    || !Array.isArray(reply.segments) || reply.segments.length > 20000)
    throw new Error('Invalid live diarization result');
  const frontier = context.base_ms + reply.processed_s * 1000 - (context.finished ? 0 : 640);
  const turns = reply.segments.map(turn => {
    if (!Number.isInteger(turn.speaker) || turn.speaker < 1 || turn.speaker > 8 || !Number.isFinite(turn.start)
      || !Number.isFinite(turn.end) || turn.start < 0 || turn.end <= turn.start
      || turn.end * 1000 + context.base_ms > context.next_ms + 100) throw new Error('Invalid speaker turn');
    return { start_ms: Math.max(job.start_ms, context.base_ms + turn.start * 1000),
      end_ms: Math.min(job.end_ms, context.base_ms + turn.end * 1000), speaker_id: turn.speaker };
  }).filter(turn => turn.end_ms > turn.start_ms);
  const speakers = [...new Set(turns.filter(turn => turn.end_ms - turn.start_ms >= 200).map(turn => turn.speaker_id))];
  const covered = speakers.length === 1 ? turns.filter(turn => turn.speaker_id === speakers[0])
    .reduce((sum, turn) => sum + turn.end_ms - turn.start_ms, 0) : 0;
  const pending = frontier + 20 < job.end_ms;
  const speaker_state = pending ? 'pending' : speakers.length > 1 ? 'multiple'
    : covered >= (job.end_ms - job.start_ms) * .6 ? 'assigned' : 'unknown';
  return { speaker_scope: context.scope, speaker_method: 'nemotron-streaming', speaker_state,
    speaker_id: speaker_state === 'assigned' ? speakers[0] : null, speaker_turns: turns,
    speaker_timestamp_quality: 'audio-interval' };
}

export class LiveDiarization {
  constructor(store, config, engine = new DiarizationEngine(config)) {
    this.store = store; this.engine = engine; this.contexts = new Map();
    this.metrics = { jobs: 0, audio_s: 0, inference_ms: 0, errors: 0, resets: 0, streams: 0 };
  }
  start() { return this.engine.start(); }
  async context(job) {
    let context = this.contexts.get(job.stream_id);
    if (context && (context.session_id !== job.session_id || context.epoch !== job.epoch || context.next_ms !== job.start_ms)) {
      await this.finish(context); this.metrics.resets++; context = null;
    }
    if (!context) {
      context = { stream_id: job.stream_id, session_id: job.session_id, epoch: job.epoch,
        scope: randomUUID(), base_ms: job.start_ms, next_ms: job.start_ms };
      await this.engine.request('open', context.scope); this.contexts.set(job.stream_id, context);
    }
    return context;
  }
  applyPending(context, reply) {
    for (const row of this.store.segments({ stream: context.stream_id, limit: 20 }).items) {
      if (row.session_id !== context.session_id || row.timeline_epoch !== context.epoch
        || row.speaker_scope !== context.scope || row.speaker_state !== 'pending') continue;
      const annotation = speakerAnnotation(row, reply, context);
      if (annotation.speaker_state !== 'pending') this.store.annotateSpeakers(row.segment_id, annotation);
    }
  }
  async process(job) {
    try {
      const context = await this.context(job);
      const reply = await this.engine.request('push', context.scope, job.pcm);
      context.next_ms = job.end_ms;
      const annotation = speakerAnnotation(job, reply, context);
      this.applyPending(context, reply);
      this.metrics.jobs++; this.metrics.audio_s += job.unique_s;
      this.metrics.inference_ms += reply.inference_ms; this.metrics.streams = this.contexts.size;
      return { ...annotation, diarization_ms: reply.inference_ms, processed_until_ms: context.base_ms + reply.processed_s * 1000 };
    } catch (error) {
      this.metrics.errors++; this.metrics.last_error = error.message;
      const context = this.contexts.get(job.stream_id);
      if (context) {
        this.failPending(context);
        await this.release(context).catch(() => {});
      }
      return { speaker_id: null, speaker_state: 'unavailable', speaker_method: 'nemotron-streaming',
        speaker_scope: null, speaker_turns: [], diarization_error: error.message };
    }
  }
  async release(context) {
    try { await this.engine.request('close', context.scope); }
    finally { if (this.contexts.get(context.stream_id) === context) this.contexts.delete(context.stream_id); }
  }
  failPending(context) {
    for (const row of this.store.segments({ stream: context.stream_id, limit: 20 }).items)
      if (row.speaker_scope === context.scope && row.speaker_state === 'pending')
        this.store.annotateSpeakers(row.segment_id, { speaker_scope: context.scope, speaker_id: null,
          speaker_state: 'unavailable', speaker_turns: [], speaker_method: 'nemotron-streaming' });
  }
  async finish(channel) {
    const context = this.contexts.get(channel.stream_id);
    if (!context || context.session_id !== channel.session_id) return;
    try {
      const reply = await this.engine.request('finish', context.scope); context.finished = true;
      this.applyPending(context, reply);
      return { state: 'complete', scope: context.scope, processed_until_ms: context.next_ms, error: null };
    } catch (error) {
      this.metrics.errors++; this.metrics.last_error = error.message; this.failPending(context);
      return { state: 'unavailable', scope: context.scope, error: error.message };
    }
    finally { await this.release(context).catch(() => {}); this.metrics.streams = this.contexts.size; }
  }
  async close() {
    for (const context of [...this.contexts.values()]) await this.release(context).catch(() => {});
    await this.engine.stop();
  }
}
