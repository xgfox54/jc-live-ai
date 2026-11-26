import { createLiveProbe } from './live-probe.mjs';
import { viewerStream } from './viewer.mjs';
import { HttpError } from './validate.mjs';
import { sampleSound, WATCH_MS } from './recess-watch.mjs';

export const supportsAutoStart = stream => ['youtube', 'council'].includes(stream.kind);
export const autoEnabled = stream => stream.approved && supportsAutoStart(stream) && stream.auto_start !== false;
// Broadcast time reached by a collection. A resumed collection reads its backlog faster than real time, so its receive
// clock runs ahead of the broadcast until it catches up; the read start plus the audio received is the earlier bound.
export const receivedUntil = session => !Number.isFinite(session?.last_receive_ms) ? null
  : Number.isFinite(session.content_from_ms) ? Math.min(session.last_receive_ms, session.content_from_ms + (session.total_received_s ?? 0) * 1000)
  : session.last_receive_ms;

const seoulDate = ms => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(ms);
// A meeting's own date: the part date of a part record, the scheduled date, or the day it was first seen.
const meetingDate = record => record.part_date ?? String(record.scheduled_at ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? seoulDate(record.first_seen_ms ?? 0);

export class BroadcastMonitor {
  constructor(context) {
    Object.assign(this, context);
    this.probe = context.probe ?? createLiveProbe(context.config);
    this.now = context.now ?? Date.now;
    this.interval = 30000; this.pending = new Map(); this.status = new Map(); this.owned = new Map(); this.closed = false;
    this.listen = context.listen ?? ((source, signal) => sampleSound(context.config, source, signal)); this.watch = new Map();
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
  // Earlier collections of the same meeting (an input break or an engine restart) are continued after the audio they received.
  recordedUntil(stream) {
    if (!this.registry || !stream.broadcast_id) return Number.isFinite(stream.resume_after_ms) ? stream.resume_after_ms : null;
    const reached = this.registry.sessions(stream.broadcast_id).map(receivedUntil).filter(Number.isFinite);
    return reached.length ? Math.max(...reached) : null;
  }
  setEnabled(stream, enabled) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, '자동 감지 설정값을 확인해 주세요.');
    if (enabled && !supportsAutoStart(stream)) throw new HttpError(400, '주소 방식의 방송만 자동 감지를 지원합니다.');
    this.invalidate(stream.stream_id);
    const saved = { ...stream, auto_start: enabled, auto_completed_key: null, beginning_fallback: enabled ? false : stream.beginning_fallback ?? false, resume_after_ms: null };
    if (stream.broadcast_id && this.registry) {
      this.registry.suspend(stream.broadcast_id, !enabled);
      if (enabled) { const record = this.registry.get(stream.broadcast_id); if (record) this.registry.save({ ...record, completed: false }); }
    }
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
    let unreachable = false;
    try {
      if (!this.scheduler.engine.ready || !this.scheduler.accepting) throw new Error('전사 엔진 준비 후 다시 확인합니다.');
      const result = await this.probe(stream, signal).catch(error => { unreachable = true; throw error; });
      const current = this.store.streams().find(item => item.stream_id === id);
      if (this.closed || signal.aborted || !current || JSON.stringify(current) !== JSON.stringify(stream) || !autoEnabled(current)) return;
      let phase = result.phase;
      const channel = this.scheduler.channels.get(id);
      const liveEdge = !stream.capture_from_start || stream.beginning_fallback === true;
      const quiet = Number.isFinite(channel?.last_receive_ms) && this.now() - channel.last_receive_ms >= 30000;
      if (result.phase === 'ended' && this.owned.has(id) && liveEdge && quiet) {
        await this.inputs.stop(id, 'eof'); this.scheduler.stop(id, 'eof');
      } else if (result.phase === 'live' && !this.active(id)) {
        const finished = current.broadcast_id && !current.recess_watch && result.key?.startsWith('hls:') ? this.registry?.get(current.broadcast_id) : null;
        if (stream.auto_completed_key === result.key)
          phase = stream.recess_watch?.key === result.key ? await this.watchRecess(current, result, signal) : 'completed';
        // A council committee stream that comes back after its meeting adjourned carries the committee's next meeting
        // (2026-11-27: 5차 행정자치위원회 adjourned at 23:59 and 6차 opened at 00:05 on the same stream, and 6차 was collected
        // into 5차). The channel waits for the official list to give it that meeting (BroadcastDiscovery.assign).
        else if (finished?.completed === true) phase = 'completed';
        else {
          const source = { ...result.source, auto_start: true };
          if (source.video_id !== stream.video_id || source.media_url !== stream.media_url) {
            this.store.saveStream(source); this.store.event('stream', viewerStream(source));
          }
          // Reading from the start again would collect the meeting twice, and the live edge would skip the break.
          const videoMs = await this.handoff?.resume(source);
          if (signal.aborted || this.closed) return;
          if (Number.isFinite(videoMs)) source.resume_video_ms = videoMs;
          const recorded = this.handoff?.settings ? null : this.recordedUntil(current);
          if ((current.resume_after_ms ?? null) !== recorded || (recorded !== null && !current.beginning_fallback)) {
            const resume = recorded === null ? { resume_after_ms: null } : { beginning_fallback: true, resume_after_ms: recorded };
            Object.assign(source, resume);
            this.store.saveStream({ ...this.store.streams().find(item => item.stream_id === id), ...resume });
          }
          this.begin(source, { automatic: true, key: result.key }); phase = 'collecting';
        }
      } else if (this.active(id)) phase = 'collecting';
      if (current.broadcast_id && this.registry) {
        // Only a changed phase is saved: each save signals a broadcast change, which rebuilds and republishes its minutes.
        const record = this.registry.get(current.broadcast_id); const recordPhase = this.active(id) ? 'live' : result.phase;
        // The official list drops a meeting once its broadcast ends, so the end of the broadcast is marked here (airTimes).
        const offAir = ['offline', 'ended'].includes(recordPhase) && ['live', 'waiting'].includes(record?.phase) && !record?.aired_until_ms;
        if (record && record.phase !== recordPhase) this.registry.save({ ...record, phase: recordPhase, ...(offAir ? { aired_until_ms: this.now() } : {}) });
      }
      if (['offline', 'ended', 'waiting'].includes(result.phase) && stream.auto_completed_key?.startsWith('hls:'))
        this.store.saveStream({ ...current, auto_completed_key: null });
      // A closed broadcast that has ended needs no resumption watch.
      if (current.recess_watch && ['offline', 'ended'].includes(result.phase)) {
        this.watch.delete(id); this.store.saveStream({ ...this.store.streams().find(item => item.stream_id === id), recess_watch: null });
      }
      const failures = phase === 'collecting' && !this.scheduler.channels.get(id)?.last_receive_ms ? previous?.failures ?? 0 : 0;
      this.status.set(id, { phase, checked_ms: this.now(), next_check_ms: this.now() + this.interval, failures });
    } catch (error) {
      if (this.closed || signal.aborted) return;
      const failures = (previous?.failures ?? 0) + 1;
      this.status.set(id, { phase: 'retry', error: error.message, failures,
        checked_ms: this.now(), next_check_ms: this.now() + Math.min(300000, this.interval * 2 ** Math.min(failures - 1, 4)) });
      if (unreachable) this.endUnreachable(stream);
    }
  }
  // Ends a collection whose broadcast stays on air while the meeting does not continue (2026-11-24 교육위원회: recess from
  // 12:05 with the stream on into the night). The input ends as at the end of the broadcast: the record is completed, the same
  // broadcast is not collected again, and the stream keeps a resumption watch (watchRecess). note is shown in the minutes.
  async closeCollection(stream, note = '') {
    const id = stream.stream_id;
    if (!this.active(id)) throw new HttpError(409, '수집 중인 방송이 아닙니다.');
    if (typeof note !== 'string' || note.length > 500) throw new HttpError(400, '마감 안내는 500자 이내로 입력해 주세요.');
    const result = await this.probe(stream, AbortSignal.timeout(60000)).catch(() => null);
    if (result?.phase !== 'live') throw new HttpError(409, '생방송 중으로 확인된 방송만 마감합니다. 방송이 끝나면 수집도 자동으로 끝납니다.');
    await this.inputs.stop(id, 'eof'); this.scheduler.stop(id, 'eof');
    const current = this.store.streams().find(item => item.stream_id === id);
    const saved = { ...current, auto_completed_key: result.key, resume_after_ms: null,
      recess_watch: { key: result.key, broadcast_id: current.broadcast_id ?? null, closed_ms: this.now() } };
    this.store.saveStream(saved); this.store.event('stream', viewerStream(saved)); this.watch.delete(id);
    const record = current.broadcast_id && this.registry?.get(current.broadcast_id);
    if (record) this.registry.save({ ...record, completed: true, phase: 'ended', ...(note.trim() ? { close_note: note.trim() } : {}) });
    this.status.set(id, { phase: 'watching', checked_ms: this.now(), next_check_ms: this.now() + this.interval });
    return saved;
  }
  // A broadcast whose collection was ended on air is sampled every WATCH_MS. Sound in two samples in a row (a resumed meeting; a single sound
  // can be a microphone check) starts collection again. The live playlist is read back from the last silent sample, so the
  // start of the resumed speech is kept. A resumption on a later day than the meeting's goes to a part record for that day.
  async watchRecess(stream, result, signal) {
    const id = stream.stream_id; const state = this.watch.get(id) ?? { checked_ms: 0, quiet_ms: stream.recess_watch.closed_ms, heard: 0 };
    if (this.now() - state.checked_ms < WATCH_MS) return 'watching';
    const level = await this.listen(result.source ?? stream, signal).catch(() => null);
    if (signal.aborted || this.closed) return 'watching';
    state.checked_ms = this.now();
    if (level && !level.sound) { state.quiet_ms = state.checked_ms; state.heard = 0; }
    else if (level) state.heard++;
    this.watch.set(id, state);
    if (state.heard < 2) return 'watching';
    this.watch.delete(id);
    const current = this.store.streams().find(item => item.stream_id === id);
    const source = { ...current, ...result.source, auto_start: true, broadcast_id: this.resumeTarget(current), auto_completed_key: null, recess_watch: null,
      beginning_fallback: true, resume_after_ms: state.quiet_ms };
    this.store.saveStream(source); this.store.event('stream', viewerStream(source));
    this.begin(source, { automatic: true, key: result.key });
    return 'collecting';
  }
  // The record a resumed collection continues: the closed record on its own date, otherwise the part record of today.
  resumeTarget(stream) {
    const record = stream.broadcast_id && this.registry?.get(stream.broadcast_id);
    if (!record) return stream.broadcast_id ?? null;
    const today = seoulDate(this.now());
    if (today === meetingDate(record)) {
      const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(this.now());
      this.registry.save({ ...record, completed: false, ...(record.close_note ? { close_note: record.close_note + ' ' + time + '부터 방송 소리가 다시 들려 수집을 이어 갔습니다.' } : {}) });
      return record.id;
    }
    return this.registry.continuation(record, today, this.now()).id;
  }
  // The official page drops its player when a meeting ends, so a broadcast that cannot be checked ten minutes after the
  // meeting's last received audio has ended; its channel is then free for the committee's next broadcast.
  // The stream stays enabled, and collection starts again if the same broadcast is found live.
  endUnreachable(stream) {
    const current = this.store.streams().find(item => item.stream_id === stream.stream_id);
    if (!current?.broadcast_id || !this.registry || this.active(stream.stream_id)) return;
    const record = this.registry.get(current.broadcast_id); const reached = this.recordedUntil(current);
    if (!record || record.completed || reached === null || this.now() - reached < 600_000) return;
    this.registry.save({ ...record, completed: true, phase: 'ended' });
  }
  begin(stream, options = {}) {
    if (this.active(stream.stream_id)) throw new HttpError(409, '이미 수집 중입니다.');
    if (this.store.streams().some(other => other.stream_id !== stream.stream_id && this.active(other.stream_id)
      && ((stream.video_id && other.video_id === stream.video_id) || (stream.broadcast_id && other.broadcast_id === stream.broadcast_id))))
      throw new HttpError(409, '같은 방송을 다른 슬롯에서 수집하고 있습니다.');
    const state = this.scheduler.start(stream);
    this.minutes?.attach(stream, state);
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
      // An input cut off while audio was still arriving, with the end check still finding the broadcast live (an encoder
      // break), reconnects. One that waited minutes without audio (a stalled broadcast) or whose end could not be checked
      // (2026-11-05 18:57: the official page had dropped its player after adjournment) completes as before.
      const cutOff = channel.input_end_reason === 'end_unverified' && channel.input_end_live === true
        && this.now() - channel.last_receive_ms < 120_000;
      if (channel.recording_failed) {
        this.setEnabled(current, false);
        this.status.set(stream.stream_id, { phase: 'blocked', error: '원음 저장에 실패했거나 저장 한도에 도달했습니다. 저장 공간과 한도를 확인한 뒤 자동 감지를 다시 켜 주세요.' });
      } else if (!channel.error && !cutOff) {
        if (stream.broadcast_id && this.registry) {
          const record = this.registry.get(stream.broadcast_id);
          if (record) this.registry.save({ ...record, completed: true, phase: 'ended' });
        }
        this.store.saveStream({ ...current, auto_completed_key: options.key, resume_after_ms: null });
        this.status.set(stream.stream_id, { phase: 'completed', checked_ms: this.now(), next_check_ms: this.now() + this.interval });
      } else if (!channel.error) {
        // Reconnect after the received audio; restarting a from-start capture would collect the meeting twice.
        this.store.saveStream({ ...current, beginning_fallback: true, resume_after_ms: receivedUntil(channel) ?? current.resume_after_ms ?? null });
        this.status.set(stream.stream_id, { phase: 'retry', error: '방송 수신이 끊겨 이어서 다시 연결합니다.', failures: 0,
          checked_ms: this.now(), next_check_ms: this.now() + 5000 });
      } else {
        const updates = {};
        if (stream.capture_from_start && !stream.beginning_fallback && channel.input_failed) {
          updates.beginning_fallback = true;
          this.store.event('gap', { stream_id: stream.stream_id, session_id: state.session_id,
            reason: 'beginning_collection_failed', extent: 'unknown' });
        }
        // A resumed collection keeps its resume point current so the next reconnection does not read received audio again.
        const reached = receivedUntil(channel);
        if (current.resume_after_ms && reached !== null) updates.resume_after_ms = reached;
        if (Object.keys(updates).length) this.store.saveStream({ ...current, ...updates });
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
