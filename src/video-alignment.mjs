import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from './validate.mjs';
import { finalReadiness } from './final-speakers.mjs';
import { councilReplay, downloadReplayAudio } from './council.mjs';
import { speakerReviewPython, speakingCapture } from './speaker-acoustics.mjs';

export const ALIGNMENT_METHOD = 'audio-match-v1';
// The official council replay is preferred because the council's YouTube copies are made private after the meeting.
export function alignmentSource(record) {
  try {
    if (record.replay_url) return { source: 'council_vod', media_url: councilReplay(record.replay_url), page_url: record.replay_page ?? null, video_id: null };
  } catch { /* an invalid stored address falls back to YouTube */ }
  return /^[A-Za-z0-9_-]{11}$/.test(record.video_id ?? '') ? { source: 'youtube', media_url: null, page_url: null, video_id: record.video_id } : null;
}
// Consecutive matched probes whose offsets agree within 100 ms form a run, and a run needs at least three probes.
// A session is accepted when its runs cover at least 80% of the voiced probes that fall inside the video under a run's offset.
// A recording may start before a replay that covers only the meeting (negative offset) or skip a stretch (a second run).
// Each run maps the collection time between its outer probes; the first and last runs extend to the session start and end.
// Between runs, and outside the video, collection time stays unchanged.
export function acceptedOffsets(result, sessionFiles) {
  const accepted = {}; const probe = (result.probe_seconds ?? 30) * 1000;
  const video = Number.isFinite(result.video_seconds) ? Math.round(result.video_seconds * 1000) : null;
  for (const [sessionId, file] of Object.entries(sessionFiles)) {
    const probes = (result.probes ?? []).filter(item => item.session === file).sort((a, b) => a.pcm_s - b.pcm_s);
    const runs = [];
    for (const item of probes.filter(item => item.status === 'matched' && Number.isFinite(item.offset_s))) {
      const run = runs.at(-1);
      if (run && Math.abs(item.offset_s - run[0].offset_s) <= 0.1) run.push(item); else runs.push([item]);
    }
    const reliable = runs.filter(run => run.length >= 3).map(run => {
      const offsets = run.map(item => item.offset_s).sort((a, b) => a - b);
      return { run, offset_ms: Math.round(offsets[Math.floor(offsets.length / 2)] * 1000), spread_ms: Math.round((offsets.at(-1) - offsets[0]) * 1000) };
    });
    const inside = probes.filter(item => item.status !== 'silent' && reliable.some(({ offset_ms }) => {
      const at = item.pcm_s * 1000 + offset_ms; return at >= 0 && (video === null || at + probe <= video); }));
    const matched = reliable.reduce((sum, { run }) => sum + run.length, 0);
    if (!matched || matched / inside.length < 0.8) continue;
    const ranges = reliable.map(({ run, offset_ms }, index) => ({ from_ms: index ? Math.round(run[0].pcm_s * 1000) : null,
      to_ms: index < reliable.length - 1 ? Math.round(run.at(-1).pcm_s * 1000 + probe) : null, offset_ms }));
    accepted[sessionId] = { offset_ms: reliable[0].offset_ms, matched, probes: probes.length, spread_ms: Math.max(...reliable.map(item => item.spread_ms)),
      video_ms: video, ...(ranges.length > 1 ? { ranges } : {}) };
  }
  return accepted;
}
// Sessions that can be shifted: a single timeline epoch only, because a later epoch restarts at zero while the recording continues.
export function videoOffsets(alignment, sessions, segments) {
  const offsets = new Map();
  if (alignment?.phase !== 'complete' || alignment.method !== ALIGNMENT_METHOD) return offsets;
  for (const session of sessions) {
    const item = alignment.sessions?.[session.session_id];
    if (!item || segments.some(row => row.session_id === session.session_id && (row.timeline_epoch ?? 0) !== 0)) continue;
    offsets.set(session.session_id, item);
  }
  return offsets;
}
// The offset that moves [start_ms, end_ms] of collection time onto the video, or null when the span is outside
// the matched ranges or the video. Results stored before ranges existed have one offset for the whole session.
export function videoShift(entry, start_ms, end_ms) {
  const range = (entry.ranges ?? [{ from_ms: null, to_ms: null, offset_ms: entry.offset_ms }])
    .find(item => (item.from_ms === null || start_ms >= item.from_ms) && (item.to_ms === null || end_ms <= item.to_ms));
  if (!range || start_ms + range.offset_ms < 0 || (Number.isFinite(entry.video_ms) && end_ms + range.offset_ms > entry.video_ms)) return null;
  return range.offset_ms;
}
const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], ...options });
  let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 1_800_000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('exit', code => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(command.split(/[\\/]/).at(-1) + ' failed: ' + code)); });
});
export class VideoAlignment {
  constructor({ registry, review, store, config, scheduler }) {
    Object.assign(this, { registry, review, store, config, scheduler }); this.pending = null; this.closed = false; this.controller = new AbortController();
    for (const record of registry.list()) {
      const previous = review.get('video-alignment:' + record.id);
      if (previous?.phase === 'running') review.save('video-alignment:' + record.id, previous.replaces ?? { ...previous, phase: 'interrupted', updated_ms: 0 });
      // A merged record keeps one collection clock and is never aligned; a measurement left from before the merge no longer
      // describes it (a6713355 kept a failure from 13 November).
      else if (record.merged_from && previous && previous.phase !== 'complete') review.remove('video-alignment:' + record.id);
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
    const source = alignmentSource(record);
    if (record.merged_from) throw new HttpError(409, '다른 PC의 기록을 합친 회의록은 수집 시각을 그대로 사용하므로 영상 시간을 대조하지 않습니다.');
    if (!source) throw new HttpError(400, '공식 다시보기 영상이나 공식 유튜브 영상이 연결된 회의만 대조할 수 있습니다.');
    if (!Object.keys(this.sessionFiles(id)).length) throw new HttpError(400, '대조할 녹음 파일이 없습니다.');
    // A completed result stays in force if a new measurement fails.
    const previous = this.review.get('video-alignment:' + id);
    const job = { phase: 'running', method: ALIGNMENT_METHOD, ...source, started_ms: Date.now(), updated_ms: Date.now(),
      ...(previous?.phase === 'complete' ? { replaces: previous } : {}) };
    this.review.save('video-alignment:' + id, job);
    this.pending = this.run(id, job).finally(() => { this.pending = null; });
    return job;
  }
  async run(id, { replaces, ...job }) {
    const directory = resolve(this.config.alignmentDirectory ?? 'data/verification', id);
    mkdirSync(directory, { recursive: true });
    const key = 'video-alignment:' + id; const signal = this.controller.signal;
    const keep = error => ({ ...replaces, rerun_failed_ms: Date.now(), rerun_error: error });
    try {
      for (const name of readdirSync(directory)) if (/^video\./.test(name)) rmSync(resolve(directory, name), { force: true });
      let input;
      if (job.media_url) {
        input = resolve(directory, 'video.aac');
        job.media_seconds = (await downloadReplayAudio(job.media_url, input, { signal })).seconds;
      } else {
        await run(resolve(this.config.ytdlp ?? 'bin/yt-dlp.exe'), ['--no-warnings', '--no-progress', '--no-playlist', '-f', 'bestaudio',
          '-o', resolve(directory, 'video.%(ext)s'), '--', 'https://www.youtube.com/watch?v=' + job.video_id], { signal });
        const audio = readdirSync(directory).find(name => /^video\.(?:m4a|webm|mp4|opus)$/.test(name));
        if (!audio) throw new Error('video audio missing');
        input = resolve(directory, audio);
      }
      await run(resolve(this.config.ffmpeg ?? 'bin/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', ...(job.media_url ? ['-f', 'aac'] : []),
        '-i', input, '-ac', '1', '-ar', '16000', '-f', 's16le', resolve(directory, 'video.pcm')], { signal });
      const files = this.sessionFiles(id); const output = resolve(directory, 'alignment.json');
      // The script needs numpy, which the diarization Python did not have on 2026-11-14; alignments run with it failed.
      const review = speakerReviewPython(this.config);
      await run(this.config.alignmentPython ?? (existsSync(review) ? review : this.config.diarizationPython ?? 'python'),
        [resolve('scripts/verify-video-alignment.py'), resolve(directory, 'video.pcm'), output, ...Object.values(files)], { signal });
      const sessions = acceptedOffsets(JSON.parse(readFileSync(output, 'utf8')), files);
      const complete = Object.keys(sessions).length > 0;
      const result = { ...job, phase: complete ? 'complete' : 'failed', sessions, checked: Object.keys(files).length,
        error: complete ? null : '녹음과 영상 음성이 일치하는 세션을 찾지 못했습니다.', updated_ms: Date.now() };
      this.review.save(key, complete || !replaces ? result : keep(result.error));
      this.review.store.audit?.({ action: 'video.alignment', broadcast_id: id, source: job.source, sessions: Object.keys(sessions).length, checked: result.checked });
      this.store.emit('broadcast', id);
    } catch (error) {
      if (this.closed) return; // left running: the next start restores the previous result or retries
      const message = '공식 영상을 내려받거나 음성을 대조하지 못했습니다.';
      this.review.save(key, replaces ? keep(message) : { ...job, phase: 'failed', error: message, detail: error.message.slice(0, 200), updated_ms: Date.now() });
      if (replaces) this.store.emit('broadcast', id);
    } finally { for (const name of ['video.pcm', 'video.aac']) rmSync(resolve(directory, name), { force: true }); }
  }
  // After collection has settled (the same end rule as the speaker review), one attempt per meeting;
  // a failed attempt is retried after six hours. A result measured on YouTube is measured again once the official replay is known.
  // It waits while a channel is taking in speech; a channel silent for 10 minutes (a recess) does not hold it back (speakingCapture).
  auto() {
    if (this.closed || this.pending || this.config.manualMode || speakingCapture(this.scheduler)) return;
    for (const record of this.registry.list()) {
      const source = alignmentSource(record);
      // A merged record keeps one collection clock; audio matching would move only the session that has a recording.
      if (record.test_run || record.merged_from || !source || !['ready', 'empty', 'correcting'].includes(finalReadiness(this.registry, record.id))) continue;
      const previous = this.review.get('video-alignment:' + record.id);
      const moved = previous && !previous.media_url && source.media_url && Date.now() - (previous.rerun_failed_ms ?? 0) >= 21_600_000;
      if (!moved && (previous?.phase === 'complete' || previous?.phase === 'running' || (previous && Date.now() - previous.updated_ms < 21_600_000))) continue;
      if (!Object.keys(this.sessionFiles(record.id)).length) continue;
      try { this.start(record.id); return; } catch { /* Next tick retries another meeting. */ }
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller.abort(); await this.pending; }
}

