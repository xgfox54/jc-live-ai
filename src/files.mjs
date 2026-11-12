import { playlistResume, videoOffset } from './handoff.mjs';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, mkdirSync, writeFileSync, statSync, fsync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { resolveYouTube } from './youtube.mjs';
import { resolveCouncil } from './council.mjs';
import { stopProcessTree } from './subprocess.mjs';
import { createLiveProbe } from './live-probe.mjs';
import { AudioTimeline, saveAudioTimeline } from './audio-timeline.mjs';

// Where a resumed collection starts in the YouTube live playlist (about one hour of 5-second segments): the first segment
// that begins no earlier than 30 seconds before the resume point, by the playlist's #EXT-X-PROGRAM-DATE-TIME clock.
// A stalled playlist starts at its newest segment. Without date markers the segment count is estimated from the clock.
export function resumeStart(playlist, after, now = Date.now()) {
  let clock = null; const starts = [];
  for (const line of playlist?.split(/\r?\n/) ?? []) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) clock = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) { starts.push(clock); clock = clock === null ? null : clock + parseFloat(line.slice(8)) * 1000; }
  }
  if (starts.length && starts.every(Number.isFinite)) {
    const found = starts.findIndex(start => start >= after - 30_000);
    const index = found === -1 ? starts.length - 1 : found;
    return { index: index - starts.length, from_ms: starts[index] };
  }
  const count = Math.min(700, Math.max(1, Math.ceil((now - after) / 5000) + 1));
  return { index: -count, from_ms: now - count * 5000 };
}
async function readLivePlaylist(url, signal) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) return null;
  const chunks = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 8_388_608) return null; chunks.push(part); }
  return Buffer.concat(chunks).toString('utf8');
}

export class FileInputs {
  constructor(scheduler, config) { this.scheduler = scheduler; this.config = config; this.children = new Map(); this.resolving = new Map(); this.endProbe = createLiveProbe(config); }
  isActive(id) { return this.children.has(id) || this.resolving.has(id); }
  startYouTube(stream) {
    return this.startResolved(stream, async signal => ({ url: await resolveYouTube(this.config, stream, signal), youtube: true }));
  }
  startCouncil(stream) {
    return this.startResolved(stream, async signal => {
      const source = await resolveCouncil(stream.page_url, signal);
      if (source.resolved_kind !== stream.resolved_kind || source.video_id !== stream.video_id
        || source.media_url !== stream.media_url) throw new Error('Official source changed; register the broadcast again');
      return source.resolved_kind === 'hls' ? { url: source.media_url, hls: true }
        : { url: await resolveYouTube(this.config,
          { ...stream, page_url: 'https://www.youtube.com/watch?v=' + source.video_id }, signal), youtube: true };
    });
  }
  startResolved(stream, resolveSource) {
    const controller = new AbortController();
    const task = (async () => {
      try {
        const source = await resolveSource(controller.signal);
        if (!controller.signal.aborted) {
          if (source.youtube && Number.isFinite(stream.resume_video_ms)) {
            const response = await fetch(source.url, { signal: controller.signal });
            if (!response.ok) throw new Error('Cannot read resume playlist');
            let resume;
            try { resume = playlistResume(await response.text(), stream.resume_video_ms); }
            catch (error) {
              if (!(error instanceof Error)) throw error;
              return await this.startYouTubeArchive(stream, Math.max(0, stream.resume_video_ms - 10000));
            }
            await this.start(stream, source.url, false, { remote: true, liveStartIndex: resume.index });
          } else if (source.youtube && stream.capture_from_start && !stream.beginning_fallback) await this.startYouTubeArchive(stream);
          else {
            const beginning = stream.capture_from_start && !stream.beginning_fallback;
            // After an interrupted collection the live playlist is read from just before the last received audio so the
            // break is filled; reading then continues at the live edge.
            const playlist = source.youtube && !beginning && Number.isFinite(stream.resume_after_ms)
              ? await readLivePlaylist(source.url, controller.signal).catch(() => null) : undefined;
            if (controller.signal.aborted) return;
            const resume = playlist === undefined ? null : resumeStart(playlist, stream.resume_after_ms);
            if (resume) this.scheduler.channel(stream.stream_id).content_from_ms = resume.from_ms;
            await this.start(stream, source.url, !beginning && !resume, { remote: true, fromStart: source.hls && beginning, liveStartIndex: resume?.index ?? 0 });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const channel = this.scheduler.channel(stream.stream_id); channel.error = error.message;
          channel.input_failed = true;
          this.scheduler.store.event('gap', { stream_id: stream.stream_id, session_id: channel.session_id,
            reason: 'source_resolution_failed', extent: 'unknown' });
          this.scheduler.stop(stream.stream_id);
        }
      } finally { this.resolving.delete(stream.stream_id); }
    })();
    this.resolving.set(stream.stream_id, { controller, task }); return task;
  }
  startYouTubeArchive(stream, discardMs = 0) {
    const directory = resolve(this.config.recordings ?? 'data/recordings', stream.stream_id,
      this.scheduler.channel(stream.stream_id).session_id, 'source');
    mkdirSync(directory, { recursive: true });
    const upstream = spawn(resolve(this.config.ytdlp), ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir',
      '--js-runtimes', 'node:' + process.execPath, '--live-from-start', '--no-wait-for-video',
      '--no-playlist', '--no-progress', '--no-part', '--socket-timeout', '15', '--retries', '3',
      '--fragment-retries', '3', '--format', 'bestaudio', '--output', '-',
      '--ffmpeg-location', dirname(resolve(this.config.ffmpeg)),
      'https://www.youtube.com/watch?v=' + stream.video_id],
    { shell: false, windowsHide: true, cwd: directory,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    upstream.result = new Promise(resolve => {
      upstream.once('error', () => resolve({ error: true }));
      upstream.once('close', code => resolve({ code }));
    });
    upstream.stderr.resume();
    return this.start(stream, 'pipe:0', false, { upstream, discardMs });
  }
  start(stream, path, realtime = true, options = {}) {
    const args = ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-copyts'];
    if (realtime) args.push('-re');
    if (options.loop) args.push('-stream_loop', '-1');
    if (options.remote) args.push('-protocol_whitelist', 'https,tls,tcp', '-rw_timeout', '15000000');
    if (options.upstream) args.push('-protocol_whitelist', 'pipe');
    if (options.local) args.push('-protocol_whitelist', 'file,pipe');
    if (options.fromStart) args.push('-live_start_index', '0');
    if (options.liveStartIndex) args.push('-live_start_index', String(options.liveStartIndex));
    if (options.raw) args.push('-f', 's16le', '-ar', '16000', '-ac', '1');
    args.push('-i', path);
    if (options.duration) args.push('-t', String(options.duration));
    args.push('-vn', '-af', (options.discardMs > 0 ? 'atrim=start=' + (options.discardMs / 1000) + ',' : '') + 'aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,asettb=1/16000,ashowinfo',
      '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1');
    const child = spawn(this.config.ffmpeg, args, { shell: false, windowsHide: true,
      stdio: [options.upstream ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (options.upstream) {
      child.stdin.on('error', () => {});
      options.upstream.stdout.pipe(child.stdin);
    }
    this.children.set(stream.stream_id, child);
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ error: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const timeline = new AudioTimeline();
    child.stderr.setEncoding('utf8'); child.stderr.on('data', text => timeline.write(text));
    child.once('exit', code => { if (code !== 0 && options.upstream) stopProcessTree(options.upstream); });
    const task = (async () => {
      let buffer = Buffer.alloc(0); let seq = 0; let recording; let recordingError; let recordedBytes = 0; let endReason = 'manual'; let lastReceivedMs; let decodedBytes = 0; let timelinePath; let checkpointAt = 0; let captureComplete = false; let recordingOpened = false;
      try {
        if (this.config.recordAudio || stream.auto_record) {
          const channel = this.scheduler.channel(stream.stream_id);
          const directory = resolve(this.config.recordings ?? 'data/recordings', stream.stream_id, channel.session_id);
          mkdirSync(directory, { recursive: true });
          writeFileSync(directory + '/source.json', JSON.stringify({ page_url: stream.page_url ?? '',
            stream_id: stream.stream_id, session_id: channel.session_id, format: 's16le', sample_rate: 16000,
            channels: 1, started_at: new Date().toISOString(),
            capture_from_start: Boolean(stream.capture_from_start && !stream.beginning_fallback), coverage: 'unverified' }, null, 2), { flag: 'wx' });
          timelinePath = directory + '/audio-timeline.json';
          recording = createWriteStream(directory + '/audio.pcm', { flags: 'wx' });
          recording.once('open', () => { recordingOpened = true; });
          recording.on('error', error => { recordingError = error; child.kill(); });
        }
        for await (const part of child.stdout) {
          lastReceivedMs = Date.now(); decodedBytes += part.length;
          const timingChannel = this.scheduler.channel(stream.stream_id);
          timingChannel.video_id = stream.video_id;
          timingChannel.resume_floor_ms = stream.resume_video_ms ?? null;
          if (stream.video_id) timingChannel.video_offset_ms = videoOffset(timeline);
          if (recordingError) throw recordingError;
          if (recording) {
            recordedBytes += part.length;
            if (recordedBytes > (this.config.maxRecordingBytes ?? 1382400000)) {
              this.scheduler.channel(stream.stream_id).recording_failed = true;
              throw new Error('Recording quota reached');
            }
            await new Promise((resolve, reject) => recording.write(part, error => error ? reject(error) : resolve()));
            if (Date.now() - checkpointAt >= 1000) {
              await promisify(fsync)(recording.fd);
              saveAudioTimeline(timelinePath, timeline.checkpoint(recording.bytesWritten));
              checkpointAt = Date.now();
            }
          }
          buffer = Buffer.concat([buffer, part]);
          while (buffer.length >= 32_000) {
            const state = this.scheduler.channel(stream.stream_id);
            if (!realtime) {
              while (state.queue.length >= this.config.queueChunks - 1 && state.state === 'running')
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            this.scheduler.feed(stream.stream_id, { session_id: state.session_id, epoch: state.timeline_epoch,
              seq: seq++, pcm: buffer.subarray(0, 32_000) }, { receivedMs: lastReceivedMs });
            buffer = buffer.subarray(32_000);
          }
        }
        const result = await exited;
        if (options.upstream && !child.killed) {
          const source = await options.upstream.result;
          if (source.error || source.code !== 0) throw new Error('YouTube beginning collector failed');
        }
        if (recordingError) throw recordingError;
        if (result.error || (result.code !== 0 && !child.killed)) throw new Error('Audio decoder failed');
        captureComplete = result.code === 0 && !child.killed && !child.stopRequested;
        const state = this.scheduler.channel(stream.stream_id);
        if (buffer.length && state.state === 'running') this.scheduler.feed(stream.stream_id,
          { session_id: state.session_id, epoch: state.timeline_epoch, seq, pcm: buffer }, { receivedMs: lastReceivedMs });
        if (child.stopReason === 'eof') endReason = 'eof';
        else if (!child.killed && !child.stopRequested && result.code === 0) {
          endReason = options.duration ? 'duration_limit' : 'eof';
          if (endReason === 'eof' && ['youtube', 'council'].includes(stream.kind)) {
            child.endProbeController = new AbortController();
            const ended = await this.endProbe(stream, child.endProbeController.signal).catch(() => null);
            if (ended?.phase !== 'ended' && !(ended?.key?.startsWith('youtube:') && ended.phase === 'offline')) endReason = 'end_unverified';
            // Only a check that still finds the broadcast live shows the input was cut off mid-broadcast.
            this.scheduler.channel(stream.stream_id).input_end_live = ended?.phase === 'live';
          }
          if (child.stopRequested) endReason = child.stopReason ?? 'manual';
        }
      } catch (error) {
        endReason = 'error';
        if (recordingError || ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EEXIST'].includes(error.code))
          this.scheduler.channel(stream.stream_id).recording_failed = true;
        if (!child.killed || recordingError) {
          this.scheduler.channel(stream.stream_id).input_failed = true;
          this.scheduler.store.event('gap', { stream_id: stream.stream_id,
            session_id: this.scheduler.channel(stream.stream_id).session_id, reason: 'collector_failed', extent: 'unknown' });
          this.scheduler.channel(stream.stream_id).error = error.message;
        }
        child.kill();
      } finally {
        if (options.upstream) await stopProcessTree(options.upstream);
        if (recording && !recording.destroyed) {
          const finished = new Promise(resolve => recording.end(resolve)); await finished;
        }
        if (timelinePath && recordingOpened) {
          await exited;
          try {
            const storedBytes = statSync(recording.path).size;
            if (recordingError || storedBytes !== decodedBytes) timeline.invalid = true;
            const fd = openSync(recording.path, 'r+');
            try { fsyncSync(fd); } finally { closeSync(fd); }
            saveAudioTimeline(timelinePath, timeline.finish(storedBytes, captureComplete));
          }
          catch { this.scheduler.channel(stream.stream_id).recording_failed = true; }
        }
        this.children.delete(stream.stream_id); this.scheduler.stop(stream.stream_id, endReason);
      }
    })();
    child.task = task; return task;
  }
  async stop(id, reason = 'manual') {
    if (!['manual', 'eof'].includes(reason)) throw new Error('Invalid input stop reason');
    const pending = this.resolving.get(id); pending?.controller.abort();
    const child = this.children.get(id);
    if (child) { child.stopRequested = true; child.stopReason = reason; child.endProbeController?.abort(); child.kill(); await child.task; }
    if (pending) await pending.task;
  }
  async close() { await Promise.all([...new Set([...this.children.keys(), ...this.resolving.keys()])].map(id => this.stop(id))); }
}
