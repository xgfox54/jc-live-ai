import { mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { HttpError } from './validate.mjs';
import { councilHtml, councilMetadata } from './official-directory.mjs';
import { ARCHIVE_URL, parseCouncilArchive } from './council-archive.mjs';
import { parseCouncilPlayer, councilReplay, downloadReplayAudio } from './council.mjs';
import { normalize } from './committees.mjs';
import { agendaPrompt } from './agenda-prompt.mjs';
import { publicSpeech } from './silence-filter.mjs';
import { speakingCapture } from './speaker-acoustics.mjs';

// Parts of a meeting that live collection missed are transcribed from the official council replay (다시보기) and added to the
// same meeting record as collection sessions of their own (2026-11-26: six afternoon meetings were sent only over the council
// stream, which the collector did not recognize until 18:53). The replay goes through the live path: the channel session,
// speaker diarization, the silence gates and the AI correction, so the minutes treat it like collected audio.
const MIN_PART_MS = 20_000;
const BYTES_PER_MS = 32;
const ACTIVE = ['running', 'draining', 'degraded', 'reconnecting'];

// The uncovered parts of [0, videoMs), shorter parts left out.
export function missingRanges(videoMs, covered, minimum = MIN_PART_MS) {
  const spans = covered.map(([a, b]) => [Math.max(0, a), Math.min(videoMs, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const missing = []; let at = 0;
  for (const [a, b] of spans) { if (a > at) missing.push([at, a]); at = Math.max(at, b); }
  if (videoMs > at) missing.push([at, videoMs]);
  return missing.filter(([a, b]) => b - a >= minimum);
}
// Replay time covered by aligned collection sessions: each matched range maps collection time onto the replay (video-alignment.mjs).
export function coveredRanges(alignment, sessions, durationOf) {
  const covered = [];
  for (const session of sessions) {
    const entry = alignment?.phase === 'complete' ? alignment.sessions?.[session.session_id] : null;
    if (!entry) continue;
    const length = durationOf(session);
    for (const range of entry.ranges ?? [{ from_ms: null, to_ms: null, offset_ms: entry.offset_ms }])
      covered.push([(range.from_ms ?? 0) + range.offset_ms, (range.to_ms ?? length) + range.offset_ms]);
  }
  return covered;
}
// The replay of the meeting in the council archive: same date and committee, and the detail page's 일시 equal to the schedule.
export async function findReplay(record, { fetchHtml = councilHtml, signal } = {}) {
  if (record.replay_url) return { media_url: councilReplay(record.replay_url), page_url: record.replay_page ?? null };
  const date = String(record.scheduled_at ?? '').slice(0, 10); const committee = normalize(record.committee ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !committee) return null;
  const rows = parseCouncilArchive(await fetchHtml(ARCHIVE_URL, signal)).filter(row => row.date === date && normalize(row.title) === committee);
  for (const row of rows) {
    const html = await fetchHtml(row.page_url, signal);
    if (councilMetadata(html).scheduled_at.replace(/\s+/g, ' ').trim() !== String(record.scheduled_at).trim()) continue;
    try { const player = parseCouncilPlayer(html); if (player.media_url) return { media_url: councilReplay(player.media_url), page_url: row.page_url }; }
    catch { /* a detail page without its replay player yet */ }
  }
  return null;
}
const ffmpeg = (binary, args, signal) => new Promise((resolvePromise, reject) => {
  const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal });
  child.stderr.resume(); child.on('error', reject);
  child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error('ffmpeg failed: ' + code)));
});
const seoulMs = text => { const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(text ?? ''); return match ? Date.parse(match[1] + 'T' + match[2] + ':' + match[3] + ':00+09:00') : null; };

export class ReplayRecovery {
  constructor({ registry, review, store, config, scheduler, inputs, minutes, videoAlignment, fetchHtml = councilHtml, download = downloadReplayAudio }) {
    Object.assign(this, { registry, review, store, config, scheduler, inputs, minutes, videoAlignment, fetchHtml, download });
    this.pending = null; this.closed = false; this.controller = new AbortController();
    for (const record of registry.list()) {
      const previous = review.get('replay-recovery:' + record.id);
      if (previous?.phase === 'running') review.save('replay-recovery:' + record.id, { ...previous, phase: 'interrupted', updated_ms: Date.now() });
    }
  }
  state(id) { return this.review.get('replay-recovery:' + id); }
  view() { return this.registry.list().map(record => ({ id: record.id, title: record.title, ...(this.state(record.id) ?? {}) })).filter(item => item.phase); }
  save(id, value) { this.review.save('replay-recovery:' + id, { ...value, updated_ms: Date.now() }); }
  // dry finds the replay and the missing parts without transcribing.
  start(id, { dry = false } = {}) {
    const record = this.review.record(id);
    if (this.closed || this.pending) throw new HttpError(409, '다른 다시보기 복구 작업이 진행 중입니다.');
    if (!record.stream_id) throw new HttpError(400, '채널이 정해지지 않은 회의입니다.');
    if (this.registry.sessions(id).some(session => ACTIVE.includes(session.state))) throw new HttpError(409, '수집이 끝난 회의만 복구합니다.');
    if (!dry && speakingCapture(this.scheduler)) throw new HttpError(409, '발언을 수집 중인 채널이 있어 복구를 미룹니다.');
    const job = { phase: 'running', dry, started_ms: Date.now(), parts: [], error: null };
    this.save(id, job);
    this.pending = this.run(id, job).finally(() => { this.pending = null; });
    return job;
  }
  async align(id) { if (this.videoAlignment.pending) await this.videoAlignment.pending; this.videoAlignment.start(id); await this.videoAlignment.pending; }
  async run(id, job) {
    const signal = this.controller.signal; const directory = resolve(this.config.replayRecoveryDirectory ?? 'data/replay-recovery', id);
    try {
      let record = this.registry.get(id);
      const replay = await findReplay(record, { fetchHtml: this.fetchHtml, signal });
      if (!replay) { this.save(id, { ...job, phase: 'waiting', error: '공식 다시보기 영상이 아직 없습니다.' }); return; }
      job.replay = replay;
      if (!record.replay_url) { this.registry.save({ ...record, replay_url: replay.media_url, replay_page: replay.page_url }); record = this.registry.get(id); }
      // Live sessions with speech are matched against the replay first; the parts outside every match are missing.
      const sessions = this.registry.sessions(id).filter(session => !session.replay_recovery);
      const spoken = new Set(this.registry.segments(id).filter(row => row.ai_corrected === true && publicSpeech(row)).map(row => row.session_id));
      let alignment = this.review.get('video-alignment:' + id);
      if (sessions.some(session => spoken.has(session.session_id)) && (alignment?.phase !== 'complete' || alignment.media_url !== replay.media_url)) {
        await this.align(id); alignment = this.review.get('video-alignment:' + id);
      }
      const placed = session => alignment?.phase === 'complete' && alignment.sessions?.[session.session_id];
      const unplaced = sessions.filter(session => spoken.has(session.session_id) && !placed(session));
      if (unplaced.length) throw new HttpError(409, '수집 구간 ' + unplaced.length + '개를 다시보기와 맞추지 못해 복구하지 않았습니다.');
      mkdirSync(directory, { recursive: true });
      const aac = resolve(directory, 'replay.aac'); const pcm = resolve(directory, 'replay.pcm');
      job.media_seconds = (await this.download(replay.media_url, aac, { signal })).seconds;
      await ffmpeg(resolve(this.config.ffmpeg ?? 'bin/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'aac', '-i', aac, '-ac', '1', '-ar', '16000', '-f', 's16le', pcm], signal);
      const videoMs = Math.floor(statSync(pcm).size / BYTES_PER_MS);
      const recordings = resolve(this.config.recordings ?? 'data/recordings');
      const durationOf = session => { const file = resolve(recordings, session.stream_id ?? '', session.session_id, 'audio.pcm'); return existsSync(file) ? statSync(file).size / BYTES_PER_MS : 0; };
      const covered = coveredRanges(alignment, sessions.filter(session => spoken.has(session.session_id)), durationOf);
      Object.assign(job, { video_ms: videoMs, covered, parts: missingRanges(videoMs, covered).map(([from_ms, to_ms]) => ({ from_ms, to_ms, phase: 'waiting' })) });
      this.save(id, job);
      if (job.dry) { this.save(id, { ...job, phase: 'checked' }); return; }
      // Replay time r happened at anchor.wall + (r - anchor.replay): the first aligned session gives the anchor, else the scheduled start.
      const anchorSession = sessions.find(placed);
      const anchor = anchorSession ? { wall: anchorSession.started_ms, replay: alignment.sessions[anchorSession.session_id].offset_ms }
        : { wall: seoulMs(record.scheduled_at) ?? Date.now(), replay: 0 };
      for (const part of job.parts) {
        if (this.closed) throw new Error('closed');
        if (speakingCapture(this.scheduler)) throw new HttpError(409, '발언 수집이 시작되어 복구를 멈췄습니다. 수집이 끝난 뒤 다시 시작해 주세요.');
        part.phase = 'transcribing'; this.save(id, job);
        part.session_id = await this.transcribe(record, pcm, part, anchor, directory);
        part.phase = 'done'; this.save(id, job);
      }
      // The recovered sessions are replay audio, so a new match places them on the replay clock.
      if (job.parts.length) await this.align(id);
      this.save(id, { ...job, phase: 'completed', ended_ms: Date.now() });
      this.store.audit({ action: 'replay.recovery', broadcast_id: id, parts: job.parts.length,
        seconds: Math.round(job.parts.reduce((sum, part) => sum + part.to_ms - part.from_ms, 0) / 1000) });
    } catch (error) {
      if (this.closed) return;
      this.save(id, { ...job, phase: 'failed', error: error.status ? error.message : '다시보기 복구에 실패했습니다.', detail: String(error.message).slice(0, 200) });
    } finally {
      for (const name of ['replay.aac', 'replay.pcm', 'part.pcm']) rmSync(resolve(directory, name), { force: true });
    }
  }
  async transcribe(record, pcm, part, anchor, directory) {
    const channel = record.stream_id;
    if (ACTIVE.includes(this.scheduler.channels.get(channel)?.state) || this.inputs.isActive(channel)) throw new HttpError(409, '복구할 채널이 수집 중입니다.');
    // The part is cut from the replay audio, which is 16 kHz mono 16-bit PCM.
    const file = resolve(directory, 'part.pcm'); const length = (part.to_ms - part.from_ms) * BYTES_PER_MS;
    const source = await open(pcm, 'r'); const target = await open(file, 'w');
    try {
      for (let done = 0; done < length;) {
        const buffer = Buffer.alloc(Math.min(32_000 * 60, length - done));
        const { bytesRead } = await source.read(buffer, 0, buffer.length, part.from_ms * BYTES_PER_MS + done);
        if (!bytesRead) break; await target.write(buffer.subarray(0, bytesRead)); done += bytesRead;
      }
    } finally { await source.close(); await target.close(); }
    const stream = { stream_id: channel, name: record.title, kind: 'file', page_url: '', video_id: null, broadcast_id: record.id,
      approved: true, approval_note: '공식 다시보기 복구', prompt: agendaPrompt(record), auto_start: false, auto_record: true };
    const before = this.registry.get(record.id);
    const restore = () => { const current = this.registry.get(record.id);
      this.registry.save({ ...current, phase: before.phase, completed: before.completed, capture_from_start: before.capture_from_start,
        beginning_fallback: before.beginning_fallback, capture_mode: before.capture_mode }); };
    const state = this.scheduler.start(stream); this.minutes.attach(stream, state);
    // attach() marks the record live; it goes straight back so the site does not show the finished meeting as on air.
    restore();
    // A replay holds long recesses; only clear sound is recognized throughout, as in an officially declared recess.
    this.scheduler.channels.get(channel).sound_gate = true;
    try {
      await this.inputs.start(stream, file, false, { local: true, raw: true });
      while (this.scheduler.channels.get(channel)?.session_id === state.session_id && this.scheduler.channels.get(channel).state !== 'stopped')
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
    } finally {
      // The record keeps its finished state, and the session takes the time the part was spoken.
      restore();
      const row = this.store.db.prepare('SELECT document FROM sessions WHERE id=?').get(state.session_id);
      if (row) {
        const session = JSON.parse(row.document); const started = anchor.wall + (part.from_ms - anchor.replay);
        this.store.saveSession({ ...session, started_ms: started, ended_ms: started + (part.to_ms - part.from_ms),
          replay_recovery: { media_url: record.replay_url ?? null, from_ms: part.from_ms, to_ms: part.to_ms, recovered_ms: Date.now() } });
      }
      rmSync(file, { force: true });
    }
    return state.session_id;
  }
  async close() { this.closed = true; this.controller.abort(); await this.pending; }
}
