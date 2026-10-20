import { createLiveProbe } from './live-probe.mjs';
import { viewerStream } from './viewer.mjs';
import { HttpError } from './validate.mjs';

export const supportsAutoStart = stream => ['youtube', 'council'].includes(stream.kind);
export const autoEnabled = stream => stream.approved && supportsAutoStart(stream) && stream.auto_start !== false;

export class BroadcastMonitor {
  constructor(context) {
    Object.assign(this, context);
    this.probe = context.probe ?? createLiveProbe(context.config);
    this.now = context.now ?? Date.now;
    this.interval = 30000; this.pending = new Map(); this.status = new Map(); this.owned = new Map(); this.closed = false;
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick();
  }
  states() {
    return this.store.streams().map(stream => ({ stream_id: stream.stream_id, enabled: Boolean(autoEnabled(stream)),
      supported: supportsAutoStart(stream), interval_seconds: 30,
      phase: autoEnabled(stream) ? 'waiting' : 'disabled', ...this.status.get(stream.stream_id) }));
  }
  active(id) {
    return this.inputs.isActive?.(id) || ['running', 'draining'].includes(this.scheduler.channels.get(id)?.state);
  }
  invalidate(id) {
    this.pending.get(id)?.controller.abort(); this.status.delete(id);
  }
  setEnabled(stream, enabled) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, '자동 감지 설정값을 확인해 주세요.');
    if (enabled && !supportsAutoStart(stream)) throw new HttpError(400, '주소 방식의 방송만 자동 감지를 지원합니다.');
    this.invalidate(stream.stream_id);
    const saved = { ...stream, auto_start: enabled, auto_completed_key: null };
    this.store.saveStream(saved); this.store.event('stream', viewerStream(saved));
    return saved;
  }
  tick() {
    if (this.closed) return;
    return Promise.allSettled(this.store.streams().filter(autoEnabled).map(stream => {
      if ((this.status.get(stream.stream_id)?.next_check_ms ?? 0) <= this.now()) return this.check(stream);
    }));
  }
  check(stream) {
    const id = stream.stream_id;
    if (this.closed || this.pending.has(id)) return this.pending.get(id)?.task;
    const controller = new AbortController();
    const task = this.inspect(stream, controller.signal).finally(() => this.pending.delete(id));
    this.pending.set(id, { controller, task }); return task;
  }
  async inspect(stream, signal) {
    const id = stream.stream_id; const previous = this.status.get(id);
    this.status.set(id, { ...previous, phase: 'checking' });
    try {
      if (!this.scheduler.engine.ready || !this.scheduler.accepting) throw new Error('전사 엔진 준비 후 다시 확인합니다.');
      const result = await this.probe(stream, signal);
      const current = this.store.streams().find(item => item.stream_id === id);
      if (this.closed || signal.aborted || !current || JSON.stringify(current) !== JSON.stringify(stream) || !autoEnabled(current)) return;
      let phase = result.phase;
      if (result.phase === 'ended' && this.owned.has(id)) {
        await this.inputs.stop(id); this.scheduler.stop(id);
      } else if (result.phase === 'live' && !this.active(id)) {
        if (stream.auto_completed_key === result.key) phase = 'completed';
        else {
          const source = { ...result.source, auto_start: true };
          if (source.video_id !== stream.video_id || source.media_url !== stream.media_url) {
            this.store.saveStream(source); this.store.event('stream', viewerStream(source));
          }
          this.begin(source, { automatic: true, key: result.key }); phase = 'collecting';
        }
      } else if (this.active(id)) phase = 'collecting';
      if (['offline', 'ended', 'waiting'].includes(result.phase) && stream.auto_completed_key?.startsWith('hls:'))
        this.store.saveStream({ ...current, auto_completed_key: null });
      const failures = phase === 'collecting' && !this.scheduler.channels.get(id)?.last_receive_ms ? previous?.failures ?? 0 : 0;
      this.status.set(id, { phase, checked_ms: this.now(), next_check_ms: this.now() + this.interval, failures });
    } catch (error) {
      if (this.closed || signal.aborted) return;
      const failures = (previous?.failures ?? 0) + 1;
      this.status.set(id, { phase: 'retry', error: error.message, failures,
        checked_ms: this.now(), next_check_ms: this.now() + Math.min(300000, this.interval * 2 ** Math.min(failures - 1, 4)) });
    }
  }
  begin(stream, options = {}) {
    if (this.active(stream.stream_id)) throw new HttpError(409, '이미 수집 중입니다.');
    const state = this.scheduler.start(stream);
    const source = options.automatic ? { ...stream, auto_record: true } : stream;
    if (options.automatic) this.owned.set(stream.stream_id, state.session_id);
    let task;
    switch (stream.kind) {
      case 'youtube': task = this.inputs.startYouTube(source); break;
      case 'council': task = this.inputs.startCouncil(source); break;
      case 'file': task = this.inputs.start(source, this.config.files[stream.stream_id], true); break;
      case 'capture': return state;
      default: this.scheduler.stop(stream.stream_id); throw new HttpError(400, '지원하지 않는 입력 방식입니다.');
    }
    Promise.resolve(task).catch(error => {
      const channel = this.scheduler.channels.get(stream.stream_id);
      if (channel?.session_id === state.session_id) { channel.error = error.message; this.scheduler.stop(stream.stream_id); }
    }).finally(() => {
      if (!options.automatic) return;
      this.owned.delete(stream.stream_id);
      if (this.closed) return;
      const current = this.store.streams().find(item => item.stream_id === stream.stream_id);
      if (!current || !autoEnabled(current) || current.page_url !== stream.page_url) return;
      const channel = this.scheduler.channels.get(stream.stream_id);
      if (channel?.session_id !== state.session_id) return;
      if (channel.recording_failed) {
        this.setEnabled(current, false);
        this.status.set(stream.stream_id, { phase: 'blocked', error: '원음 저장에 실패했거나 저장 한도에 도달했습니다. 저장 공간과 한도를 확인한 뒤 자동 감지를 다시 켜 주세요.' });
      } else if (!channel.error) {
        this.store.saveStream({ ...current, auto_completed_key: options.key });
        this.status.set(stream.stream_id, { phase: 'completed', checked_ms: this.now(), next_check_ms: this.now() + this.interval });
      } else {
        const failures = (this.status.get(stream.stream_id)?.failures ?? 0) + 1;
        this.status.set(stream.stream_id, { phase: 'retry', error: '수집 연결이 끊겼습니다. 방송 상태 확인 후 다시 연결합니다.', failures,
          checked_ms: this.now(), next_check_ms: this.now() + Math.min(300000, this.interval * 2 ** Math.min(failures - 1, 4)) });
      }
    });
    return state;
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const entry of this.pending.values()) entry.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(entry => entry.task));
  }
}
