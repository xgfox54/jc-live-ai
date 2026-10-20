import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { resolveYouTube } from './youtube.mjs';
import { resolveCouncil } from './council.mjs';
import { stopProcessTree } from './subprocess.mjs';

export class FileInputs {
  constructor(scheduler, config) { this.scheduler = scheduler; this.config = config; this.children = new Map(); this.resolving = new Map(); }
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
          if (source.youtube && stream.capture_from_start && !stream.beginning_fallback) await this.startYouTubeArchive(stream);
          else {
            const beginning = stream.capture_from_start && !stream.beginning_fallback;
            await this.start(stream, source.url, !beginning, { remote: true, fromStart: source.hls && beginning });
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
  startYouTubeArchive(stream) {
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
    return this.start(stream, 'pipe:0', false, { upstream });
  }
  start(stream, path, realtime = true, options = {}) {
    const args = ['-nostdin', '-v', 'error'];
    if (realtime) args.push('-re');
    if (options.loop) args.push('-stream_loop', '-1');
    if (options.remote) args.push('-protocol_whitelist', 'https,tls,tcp', '-rw_timeout', '15000000');
    if (options.upstream) args.push('-protocol_whitelist', 'pipe');
    if (options.fromStart) args.push('-live_start_index', '0');
    if (options.raw) args.push('-f', 's16le', '-ar', '16000', '-ac', '1');
    args.push('-i', path);
    if (options.duration) args.push('-t', String(options.duration));
    args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1');
    const child = spawn(this.config.ffmpeg, args, { shell: false, windowsHide: true,
      stdio: [options.upstream ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (options.upstream) {
      child.stdin.on('error', () => {});
      options.upstream.stdout.pipe(child.stdin);
    }
    this.children.set(stream.stream_id, child);
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ error: error.message }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stderr.resume();
    child.once('exit', code => { if (code !== 0 && options.upstream) stopProcessTree(options.upstream); });
    const task = (async () => {
      let buffer = Buffer.alloc(0); let seq = 0; let recording; let recordingError; let recordedBytes = 0;
      try {
        if (this.config.recordAudio || stream.auto_record) {
          const channel = this.scheduler.channel(stream.stream_id);
          const directory = resolve(this.config.recordings ?? 'data/recordings', stream.stream_id, channel.session_id);
          mkdirSync(directory, { recursive: true });
          writeFileSync(directory + '/source.json', JSON.stringify({ page_url: stream.page_url ?? '',
            stream_id: stream.stream_id, session_id: channel.session_id, format: 's16le', sample_rate: 16000,
            channels: 1, started_at: new Date().toISOString(),
            capture_from_start: Boolean(stream.capture_from_start && !stream.beginning_fallback), coverage: 'unverified' }, null, 2));
          recording = createWriteStream(directory + '/audio.pcm', { flags: 'wx' });
          recording.on('error', error => { recordingError = error; child.kill(); });
        }
        for await (const part of child.stdout) {
          if (recordingError) throw recordingError;
          if (recording) {
            recordedBytes += part.length;
            if (recordedBytes > (this.config.maxRecordingBytes ?? 460800000)) {
              this.scheduler.channel(stream.stream_id).recording_failed = true;
              throw new Error('Recording quota reached');
            }
            if (!recording.write(part)) await once(recording, 'drain');
          }
          buffer = Buffer.concat([buffer, part]);
          while (buffer.length >= 32_000) {
            const state = this.scheduler.channel(stream.stream_id);
            if (!realtime) {
              while (state.queue.length >= this.config.queueChunks - 1 && state.state === 'running')
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            this.scheduler.feed(stream.stream_id, { session_id: state.session_id, epoch: state.timeline_epoch,
              seq: seq++, pcm: buffer.subarray(0, 32_000) });
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
        const state = this.scheduler.channel(stream.stream_id);
        if (buffer.length && state.state === 'running') this.scheduler.feed(stream.stream_id,
          { session_id: state.session_id, epoch: state.timeline_epoch, seq, pcm: buffer });
      } catch (error) {
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
        this.children.delete(stream.stream_id); this.scheduler.stop(stream.stream_id);
      }
    })();
    child.task = task; return task;
  }
  async stop(id) {
    const pending = this.resolving.get(id); pending?.controller.abort();
    const child = this.children.get(id);
    if (child) { child.kill(); await child.task; }
    if (pending) await pending.task;
  }
  async close() { await Promise.all([...new Set([...this.children.keys(), ...this.resolving.keys()])].map(id => this.stop(id))); }
}
