import { mkdirSync, statSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
import { speakerReviewPython, speakingCapture } from './speaker-acoustics.mjs';
import { ALIGNMENT_METHOD } from './video-alignment.mjs';

// Parts of a meeting that live collection missed are transcribed from the official council replay (다시보기) and added to the
// same meeting record as collection sessions of their own (2026-11-26: six afternoon meetings were sent only over the council
// stream, which the collector did not recognize until 18:53). The replay goes through the live path: the channel session,
// speaker diarization, the silence gates and the AI correction, so the minutes treat it like collected audio.
const MIN_PART_MS = 20_000;
const BYTES_PER_MS = 32;
const CLUSTER_GAP_MS = 60_000;
const MARGIN_MS = 15_000;
const RESUME_GAP_MS = 120_000;
const ACTIVE = ['running', 'draining', 'degraded', 'reconnecting'];

// The uncovered parts of [0, videoMs), shorter parts left out.
export function missingRanges(videoMs, covered, minimum = MIN_PART_MS) {
  const spans = covered.map(([a, b]) => [Math.max(0, a), Math.min(videoMs, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const missing = []; let at = 0;
  for (const [a, b] of spans) { if (a > at) missing.push([at, a]); at = Math.max(at, b); }
  if (videoMs > at) missing.push([at, videoMs]);
  return missing.filter(([a, b]) => b - a >= minimum);
}
// The council replay leaves out recesses, so a live session that is mostly recess matches the replay only where people spoke
// (2026-11-26: the evening sessions held 1 to 3 minutes of speech after an hour of recess). Public speech is grouped into
// stretches with gaps under a minute, and each stretch is matched on its own.
export function speechClusters(rows, gap = CLUSTER_GAP_MS) {
  const clusters = [];
  for (const row of [...rows].sort((a, b) => a.start_ms - b.start_ms)) {
    const last = clusters.at(-1);
    if (last && row.start_ms - last.to_ms <= gap) last.to_ms = Math.max(last.to_ms, row.end_ms);
    else clusters.push({ from_ms: row.start_ms, to_ms: row.end_ms });
  }
  return clusters;
}
// The replay offset of one stretch: its matched probes agree within 100 ms and make up at least half of the voiced probes
// (scripts/verify-video-alignment.py, one 30-second probe every 5 minutes from 15 seconds in).
export function clusterOffset(probes) {
  const voiced = probes.filter(probe => probe.status !== 'silent').length;
  const matched = probes.filter(probe => probe.status === 'matched' && Number.isFinite(probe.offset_s)).map(probe => probe.offset_s).sort((a, b) => a - b);
  if (!matched.length || matched.at(-1) - matched[0] > 0.1 || matched.length * 2 < voiced) return null;
  return Math.round(matched[Math.floor(matched.length / 2)] * 1000);
}
const DECLARED = /정회(?:를|을)?\s*(?:선포|하겠습니다|토록|하도록|합니다)/;
const wording = row => (row.corrected_text ?? '') + ' ' + (row.raw_text ?? '');
// Recesses the council cut out of a replay: a declared recess followed within two minutes of replay time by the resumption.
// A replay that keeps a recess has minutes of silence there, which give no sentences, so the declaration stands alone.
export function recessCuts(rows) {
  const ordered = rows.filter(row => row.speech_activity?.state !== 'silence').sort((a, b) => a.start_ms - b.start_ms);
  const cuts = [];
  ordered.forEach((row, index) => {
    const declared = DECLARED.exec(wording(row)); if (!declared) return;
    const sameRow = /속개/.test(wording(row).slice(declared.index));
    const resumed = sameRow ? row : ordered.slice(index + 1, index + 4).find(next => /속개/.test(wording(next)));
    if (!resumed || resumed.start_ms - row.end_ms > RESUME_GAP_MS) return;
    const at_ms = sameRow ? Math.round((row.start_ms + row.end_ms) / 2) : row.end_ms;
    if (!cuts.some(cut => Math.abs(cut.at_ms - at_ms) < 30_000)) cuts.push({ at_ms, text: (row.corrected_text ?? row.raw_text ?? '').slice(0, 300) });
  });
  return cuts;
}
// The resumption a chair announced: '18시까지 정회' (an hour before 8 is read as afternoon) or '10분간 정회'.
export function announcedResume(text, date, paused) {
  if (!text) return null;
  const clock = /(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?\s*까지/.exec(text);
  if (clock && /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    const hour = Number(clock[1]) < 8 ? Number(clock[1]) + 12 : Number(clock[1]);
    const value = Date.parse(date + 'T' + String(hour).padStart(2, '0') + ':' + String(clock[2] ?? 0).padStart(2, '0') + ':00+09:00');
    return Number.isFinite(value) ? value : null;
  }
  const minutes = /(\d{1,3})\s*분\s*(?:간|동안)/.exec(text);
  return minutes && Number.isFinite(paused) ? paused + Number(minutes[1]) * 60_000 : null;
}
// Wall time of each piece of a recovered part split at its recess cuts. The first piece starts at start_ms. A later piece
// resumes at the recess end the official list showed (recess_spans), else at the announced time, else right after the
// previous piece. end_ms, when known (a matched live stretch that follows, or the end of the broadcast), places the last piece;
// a part without cuts takes it only within 15 minutes of the start estimate, since a larger difference means an unseen cut.
export function wallClock({ length_ms, cuts = [], start_ms, end_ms = null, spans = [], date = '' }) {
  const bounds = [0, ...cuts.map(cut => cut.at_ms).filter(at => at > 0 && at < length_ms).sort((a, b) => a - b), length_ms];
  const said = new Map(cuts.map(cut => [cut.at_ms, cut.text]));
  const recesses = spans.filter(span => Number.isFinite(span.from_ms) && Number.isFinite(span.to_ms)).sort((a, b) => a.from_ms - b.from_ms);
  const pieces = [{ from_ms: 0, to_ms: bounds[1], wall_ms: start_ms, basis: 'start' }];
  for (let index = 1; index + 1 < bounds.length; index++) {
    const previous = pieces.at(-1); const paused = previous.wall_ms + bounds[index] - previous.from_ms;
    const recess = recesses.find(span => span.to_ms > paused);
    if (recess) recesses.splice(0, recesses.indexOf(recess) + 1);
    const announced = recess ? null : announcedResume(said.get(bounds[index]), date, paused);
    pieces.push({ from_ms: bounds[index], to_ms: bounds[index + 1], wall_ms: Math.max(paused, recess?.to_ms ?? announced ?? paused),
      basis: recess ? 'recess-mark' : announced !== null ? 'announced' : 'continuous' });
  }
  if (Number.isFinite(end_ms)) {
    const last = pieces.at(-1); const previous = pieces.at(-2); const wall_ms = end_ms - (last.to_ms - last.from_ms);
    const fits = previous ? last.basis !== 'recess-mark' && wall_ms >= previous.wall_ms + previous.to_ms - previous.from_ms
      : Math.abs(wall_ms - last.wall_ms) <= 900_000;
    if (fits) Object.assign(last, { wall_ms, basis: 'end' });
  }
  return pieces;
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
const runProcess = (binary, args, signal) => new Promise((resolvePromise, reject) => {
  const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal });
  child.stderr.resume(); child.on('error', reject);
  child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(binary.split(/[\\/]/).at(-1) + ' failed: ' + code)));
});
async function copyRange(sourcePath, targetPath, start, length) {
  const source = await open(sourcePath, 'r'); const target = await open(targetPath, 'w');
  try {
    for (let done = 0; done < length;) {
      const buffer = Buffer.alloc(Math.min(32_000 * 60, length - done));
      const { bytesRead } = await source.read(buffer, 0, buffer.length, start + done);
      if (!bytesRead) break; await target.write(buffer.subarray(0, bytesRead)); done += bytesRead;
    }
  } finally { await source.close(); await target.close(); }
}
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
  // Matches each speech stretch of the live sessions against the replay. Sessions recovered earlier from the same replay
  // cover the replay time they were cut from, so a second run adds nothing twice.
  async place(id, replay, pcm, directory, signal) {
    const sessions = this.registry.sessions(id); const entries = {}; const covered = []; const unplaced = []; const pieces = [];
    const rows = this.registry.segments(id).filter(row => row.ai_corrected === true && publicSpeech(row) && (row.timeline_epoch ?? 0) === 0);
    const recordings = resolve(this.config.recordings ?? 'data/recordings');
    for (const session of sessions) {
      if (session.replay_recovery) {
        if (session.replay_recovery.media_url !== replay.media_url) continue;
        const { from_ms, to_ms } = session.replay_recovery;
        covered.push([from_ms, to_ms]); entries[session.session_id] = { offset_ms: from_ms }; continue;
      }
      const source = resolve(recordings, session.stream_id ?? '', session.session_id, 'audio.pcm');
      if (!existsSync(source)) continue;
      const length = statSync(source).size / BYTES_PER_MS;
      for (const cluster of speechClusters(rows.filter(row => row.session_id === session.session_id))) {
        const from = Math.max(0, Math.floor(cluster.from_ms - MARGIN_MS)); const to = Math.min(length, cluster.to_ms + MARGIN_MS);
        if (to > from) pieces.push({ session, cluster, from, to, source, file: resolve(directory, 'cluster-' + pieces.length + '.pcm') });
      }
    }
    if (pieces.length) {
      for (const piece of pieces) await copyRange(piece.source, piece.file, piece.from * BYTES_PER_MS, Math.floor(piece.to - piece.from) * BYTES_PER_MS);
      const review = speakerReviewPython(this.config); const output = resolve(directory, 'clusters.json');
      await runProcess(this.config.alignmentPython ?? (existsSync(review) ? review : this.config.diarizationPython ?? 'python'),
        [resolve('scripts/verify-video-alignment.py'), pcm, output, ...pieces.map(piece => piece.file)], signal);
      const probes = JSON.parse(readFileSync(output, 'utf8')).probes ?? [];
      for (const piece of pieces) {
        const offset = clusterOffset(probes.filter(probe => probe.session === piece.file));
        const { session_id } = piece.session; const { from_ms, to_ms } = piece.cluster;
        if (offset === null) { unplaced.push({ session_id, from_ms, to_ms }); continue; }
        // Collection time t of the session is replay time t + shift.
        const shift = offset - piece.from;
        covered.push([from_ms + shift, to_ms + shift]);
        (entries[session_id] ??= { offset_ms: shift, ranges: [], live: true }).ranges.push({ from_ms, to_ms, offset_ms: shift });
      }
    }
    return { entries, covered, unplaced };
  }
  // The measured offsets are stored as the meeting's video alignment, which the minutes use for video time; a complete
  // measurement of the same replay keeps its sessions.
  async saveAlignment(id, replay, job, entries) {
    if (this.videoAlignment.pending) await this.videoAlignment.pending;
    const previous = this.review.get('video-alignment:' + id);
    const sessions = {};
    for (const [sessionId, { live, ...entry }] of Object.entries(entries)) sessions[sessionId] = { ...entry, video_ms: job.video_ms, method: live ? 'speech-stretch' : 'replay-recovery' };
    for (const part of job.parts) if (part.session_id) sessions[part.session_id] = { offset_ms: part.from_ms, video_ms: job.video_ms, method: 'replay-recovery' };
    if (previous?.phase === 'complete' && previous.media_url === replay.media_url) Object.assign(sessions, previous.sessions);
    if (!Object.keys(sessions).length) return;
    this.review.save('video-alignment:' + id, { phase: 'complete', method: ALIGNMENT_METHOD, source: 'council_vod', media_url: replay.media_url,
      page_url: replay.page_url, video_id: null, media_seconds: job.media_seconds, started_ms: job.started_ms, updated_ms: Date.now(),
      sessions, checked: Object.keys(sessions).length, measured_by: 'replay-recovery' });
    this.store.emit('broadcast', id);
  }
  async run(id, job) {
    const signal = this.controller.signal; const directory = resolve(this.config.replayRecoveryDirectory ?? 'data/replay-recovery', id);
    try {
      let record = this.registry.get(id);
      const replay = await findReplay(record, { fetchHtml: this.fetchHtml, signal });
      if (!replay) { this.save(id, { ...job, phase: 'waiting', error: '공식 다시보기 영상이 아직 없습니다.' }); return; }
      job.replay = replay;
      if (!record.replay_url) { this.registry.save({ ...record, replay_url: replay.media_url, replay_page: replay.page_url }); record = this.registry.get(id); }
      mkdirSync(directory, { recursive: true });
      const aac = resolve(directory, 'replay.aac'); const pcm = resolve(directory, 'replay.pcm');
      job.media_seconds = (await this.download(replay.media_url, aac, { signal })).seconds;
      await runProcess(resolve(this.config.ffmpeg ?? 'bin/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'aac', '-i', aac, '-ac', '1', '-ar', '16000', '-f', 's16le', pcm], signal);
      const videoMs = Math.floor(statSync(pcm).size / BYTES_PER_MS);
      // Speech that could not be matched is left as it is; the replay is still recovered around the matched stretches.
      const { entries, covered, unplaced } = await this.place(id, replay, pcm, directory, signal);
      Object.assign(job, { video_ms: videoMs, covered, unplaced, parts: missingRanges(videoMs, covered).map(([from_ms, to_ms]) => ({ from_ms, to_ms, phase: 'waiting' })) });
      this.save(id, job);
      if (job.dry) { this.save(id, { ...job, phase: 'checked' }); return; }
      // The replay leaves out recesses, so its clock runs behind the wall clock. A part takes the wall time from the scheduled
      // start; a part after a matched stretch continues from the end of that stretch.
      const stretches = Object.entries(entries).filter(([, entry]) => entry.live).flatMap(([sessionId, entry]) => {
        const session = this.registry.sessions(id).find(item => item.session_id === sessionId);
        return entry.ranges.map(range => ({ replay_start: range.from_ms + range.offset_ms, wall_start: session.started_ms + range.from_ms,
          replay_end: range.to_ms + range.offset_ms, wall_end: session.started_ms + range.to_ms }));
      });
      const start = record.aired_from_ms ?? seoulMs(record.scheduled_at) ?? Date.now();
      for (const part of job.parts) {
        if (this.closed) throw new Error('closed');
        if (speakingCapture(this.scheduler)) throw new HttpError(409, '발언 수집이 시작되어 복구를 멈췄습니다. 수집이 끝난 뒤 다시 시작해 주세요.');
        part.phase = 'transcribing'; this.save(id, job);
        const before = stretches.filter(item => item.replay_end <= part.from_ms + 1000).sort((a, b) => b.replay_end - a.replay_end)[0];
        const wall = before ? before.wall_end + (part.from_ms - before.replay_end) : start + part.from_ms;
        part.session_id = await this.transcribe(record, pcm, part, wall, directory);
        part.phase = 'done'; this.save(id, job);
      }
      this.retime(id, replay, videoMs, stretches);
      await this.saveAlignment(id, replay, job, entries);
      this.save(id, { ...job, phase: 'completed', ended_ms: Date.now() });
      this.store.audit({ action: 'replay.recovery', broadcast_id: id, parts: job.parts.length,
        seconds: Math.round(job.parts.reduce((sum, part) => sum + part.to_ms - part.from_ms, 0) / 1000) });
    } catch (error) {
      if (this.closed) return;
      this.save(id, { ...job, phase: 'failed', error: error.status ? error.message : '다시보기 복구에 실패했습니다.', detail: String(error.message).slice(0, 200) });
    } finally {
      if (existsSync(directory)) for (const name of readdirSync(directory)) if (/^(?:replay\.(?:aac|pcm)|part\.pcm|cluster-\d+\.pcm|clusters\.json)$/.test(name)) rmSync(resolve(directory, name), { force: true });
    }
  }
  async transcribe(record, pcm, part, started, directory) {
    const channel = record.stream_id;
    if (ACTIVE.includes(this.scheduler.channels.get(channel)?.state) || this.inputs.isActive(channel)) throw new HttpError(409, '복구할 채널이 수집 중입니다.');
    // The part is cut from the replay audio, which is 16 kHz mono 16-bit PCM.
    const file = resolve(directory, 'part.pcm');
    await copyRange(pcm, file, part.from_ms * BYTES_PER_MS, (part.to_ms - part.from_ms) * BYTES_PER_MS);
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
        const session = JSON.parse(row.document);
        this.store.saveSession({ ...session, started_ms: started, ended_ms: started + (part.to_ms - part.from_ms),
          replay_recovery: { media_url: this.registry.get(record.id).replay_url ?? null, from_ms: part.from_ms, to_ms: part.to_ms, recovered_ms: Date.now() } });
      }
      rmSync(file, { force: true });
    }
    return state.session_id;
  }
  async close() { this.closed = true; this.controller.abort(); await this.pending; }
  // Gives every session recovered from this replay the wall time of its speech (wallClock): the session start and end, the
  // pieces between recess cuts (wall_clock), and each sentence's received time, which the public transcript shows as '수신'.
  // It runs again on every recovery of the meeting, so later marks (a recorded broadcast end) correct earlier estimates.
  retime(id, replay, videoMs, stretches) {
    const record = this.registry.get(id); const date = String(record.scheduled_at ?? '').slice(0, 10);
    const start = record.aired_from_ms ?? seoulMs(record.scheduled_at);
    const rows = this.registry.segments(id);
    for (const session of this.registry.sessions(id).filter(item => item.replay_recovery?.media_url === replay.media_url)) {
      const { from_ms, to_ms } = session.replay_recovery;
      const before = stretches.filter(item => item.replay_end <= from_ms + 1000).sort((a, b) => b.replay_end - a.replay_end)[0];
      const after = stretches.find(item => Math.abs(item.replay_start - to_ms) <= 3000);
      const start_ms = before ? before.wall_end + (from_ms - before.replay_end) : Number.isFinite(start) ? start + from_ms : session.started_ms;
      const end_ms = after ? after.wall_start : to_ms >= videoMs - 3000 ? record.aired_until_ms ?? null : null;
      const own = rows.filter(row => row.session_id === session.session_id);
      const pieces = wallClock({ length_ms: to_ms - from_ms, cuts: recessCuts(own), start_ms, end_ms, spans: record.recess_spans ?? [], date });
      const wallAt = at => { const piece = pieces.findLast(item => item.from_ms <= at) ?? pieces[0]; return Math.round(piece.wall_ms + at - piece.from_ms); };
      const update = this.store.db.prepare("UPDATE segments SET document=json_set(document,'$.audio_received_ms',?) WHERE id=?");
      this.store.transaction(() => { for (const row of own) update.run(wallAt(row.end_ms), row.segment_id); });
      const last = pieces.at(-1);
      this.store.saveSession({ ...session, started_ms: pieces[0].wall_ms, ended_ms: last.wall_ms + last.to_ms - last.from_ms, wall_clock: pieces });
    }
    this.store.emit('broadcast', id);
  }
}
