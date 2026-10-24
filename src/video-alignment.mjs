import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from './validate.mjs';
import { finalReadiness } from './final-speakers.mjs';

export const ALIGNMENT_METHOD = 'audio-match-v1';
// A session offset is accepted only when at least three probes match, at least 80% of the probes that contain
// sound match, and all matched offsets agree within 100 ms. Anything else leaves collection time unchanged.
export function acceptedOffsets(result, sessionFiles) {
  const accepted = {};
  for (const [sessionId, file] of Object.entries(sessionFiles)) {
    const probes = (result.probes ?? []).filter(probe => probe.session === file);
    const voiced = probes.filter(probe => probe.status !== 'silent');
    const matched = voiced.filter(probe => probe.status === 'matched' && Number.isFinite(probe.offset_s));
    if (matched.length < 3 || matched.length / voiced.length < 0.8) continue;
    const offsets = matched.map(probe => probe.offset_s).sort((a, b) => a - b);
    if (offsets.at(-1) - offsets[0] > 0.1 || offsets[0] < 0) continue;
    accepted[sessionId] = { offset_ms: Math.round(offsets[Math.floor(offsets.length / 2)] * 1000), matched: matched.length,
      probes: probes.length, spread_ms: Math.round((offsets.at(-1) - offsets[0]) * 1000) };
  }
  return accepted;
}
// Shifts only sessions with a single timeline epoch: a later epoch restarts at zero while the recording continues.
export function videoOffsets(alignment, sessions, segments) {
  const offsets = new Map();
  if (alignment?.phase !== 'complete' || alignment.method !== ALIGNMENT_METHOD) return offsets;
  for (const session of sessions) {
    const item = alignment.sessions?.[session.session_id];
    if (!item || segments.some(row => row.session_id === session.session_id && (row.timeline_epoch ?? 0) !== 0)) continue;
    offsets.set(session.session_id, item.offset_ms);
  }
  return offsets;
}
const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], ...options });
  let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 1_800_000);
  child.on('error', reject);
  child.on('exit', code => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(command.split(/[\\/]/).at(-1) + ' failed: ' + code)); });
});
export class VideoAlignment {
  constructor({ registry, review, store, config, scheduler }) {
    Object.assign(this, { registry, review, store, config, scheduler }); this.pending = null; this.closed = false;
    for (const record of registry.list()) {
      const previous = review.get('video-alignment:' + record.id);
      if (previous?.phase === 'running') review.save('video-alignment:' + record.id, { ...previous, phase: 'interrupted', updated_ms: 0 });
    }
    this.timer = setInterval(() => this.auto(), 600_000); this.timer.unref();
  }
  state(id) { this.review.record(id); return this.review.get('video-alignment:' + id) ?? null; }
  sessionFiles(id) {
    const root = resolve(this.config.recordings ?? 'data/recordings'); const files = {};
    for (const session of this.registry.sessions(id)) {
      const file = resolve(root, session.stream_id ?? '', session.session_id, 'audio.pcm');
      if (session.stream_id && existsSync(file)) files[session.session_id] = file;
    }
    return files;
  }
  start(id) {
    const record = this.review.record(id);
    if (this.closed || this.pending) throw new HttpError(409, '다른 영상 시간 대조 작업이 진행 중입니다.');
    if (!/^[A-Za-z0-9_-]{11}$/.test(record.video_id ?? '')) throw new HttpError(400, '공식 유튜브 영상이 연결된 회의만 대조할 수 있습니다.');
    if (!Object.keys(this.sessionFiles(id)).length) throw new HttpError(400, '대조할 녹음 파일이 없습니다.');
    const job = { phase: 'running', method: ALIGNMENT_METHOD, video_id: record.video_id, started_ms: Date.now(), updated_ms: Date.now() };
    this.review.save('video-alignment:' + id, job);
    this.pending = this.run(id, record, job).finally(() => { this.pending = null; });
    return job;
  }
  async run(id, record, job) {
    const directory = resolve(this.config.alignmentDirectory ?? 'data/verification', id);
    mkdirSync(directory, { recursive: true });
    try {
      for (const name of readdirSync(directory)) if (/^video\./.test(name)) rmSync(resolve(directory, name), { force: true });
      await run(resolve(this.config.ytdlp ?? 'bin/yt-dlp.exe'), ['--no-warnings', '--no-progress', '--no-playlist', '-f', 'bestaudio',
        '-o', resolve(directory, 'video.%(ext)s'), '--', 'https://www.youtube.com/watch?v=' + record.video_id]);
      const audio = readdirSync(directory).find(name => /^video\.(?:m4a|webm|mp4|opus)$/.test(name));
      if (!audio) throw new Error('video audio missing');
      await run(resolve(this.config.ffmpeg ?? 'bin/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(directory, audio),
        '-ac', '1', '-ar', '16000', '-f', 's16le', resolve(directory, 'video.pcm')]);
      const files = this.sessionFiles(id); const output = resolve(directory, 'alignment.json');
      await run(this.config.alignmentPython ?? this.config.diarizationPython ?? 'python',
        [resolve('scripts/verify-video-alignment.py'), resolve(directory, 'video.pcm'), output, ...Object.values(files)]);
      const sessions = acceptedOffsets(JSON.parse(readFileSync(output, 'utf8')), files);
      const result = { ...job, phase: Object.keys(sessions).length ? 'complete' : 'failed', sessions, checked: Object.keys(files).length,
        error: Object.keys(sessions).length ? null : '녹음과 영상 음성이 일치하는 세션을 찾지 못했습니다.', updated_ms: Date.now() };
      this.review.save('video-alignment:' + id, result);
      this.review.store.audit?.({ action: 'video.alignment', broadcast_id: id, sessions: Object.keys(sessions).length, checked: result.checked });
      this.store.emit('broadcast', id);
    } catch (error) {
      this.review.save('video-alignment:' + id, { ...job, phase: 'failed', error: '공식 영상을 내려받거나 음성을 대조하지 못했습니다.', detail: error.message.slice(0, 200), updated_ms: Date.now() });
    } finally { rmSync(resolve(directory, 'video.pcm'), { force: true }); }
  }
  // After collection has settled (the same end rule as the speaker review), one attempt per meeting;
  // a failed attempt is retried after six hours.
  auto() {
    if (this.closed || this.pending || this.config.manualMode || this.scheduler?.states?.().some(state => ['running', 'draining'].includes(state.state))) return;
    for (const record of this.registry.list()) {
      if (record.test_run || !record.video_id || !['ready', 'empty', 'correcting'].includes(finalReadiness(this.registry, record.id))) continue;
      const previous = this.review.get('video-alignment:' + record.id);
      if (previous?.phase === 'complete' || previous?.phase === 'running' || (previous && Date.now() - previous.updated_ms < 21_600_000)) continue;
      if (!Object.keys(this.sessionFiles(record.id)).length) continue;
      try { this.start(record.id); return; } catch { /* Next tick retries another meeting. */ }
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.pending; }
}

