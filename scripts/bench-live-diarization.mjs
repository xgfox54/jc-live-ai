import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, totalmem } from 'node:os';
import { Store } from '../src/store.mjs';
import { WhisperEngine } from '../src/engine.mjs';
import { LiveDiarization } from '../src/live-diarization.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { FileInputs } from '../src/files.mjs';
import { ResourceSampler, percentile } from './bench-resources.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2); const seconds = Number(args[0] ?? 60);
const directory = resolve(args[1] ?? 'reports/live-diarization-20261021/live-smoke');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const count = Number(option('--inputs', '8')); const capacity = args.includes('--capacity');
const replayPath = option('--replay', null);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600 || !Number.isInteger(count) || count < 1 || count > 8)
  throw new Error('Expected 10..3600 seconds and 1..8 inputs');
if (capacity && !replayPath) throw new Error('Capacity runs require recorded audio');
await mkdir(directory, { recursive: true });
const base = JSON.parse(await readFile('config.local.json', 'utf8'));
const config = Object.fromEntries(['worker','model','device','beam','batch','chunkSeconds','queueChunks','silenceRms',
  'ffmpeg','ytdlp','diarizationDirectory','diarizationPython','diarizationChunkFrames'].filter(key => base[key] !== undefined).map(key => [key, base[key]]));
for (const key of ['worker','model','ffmpeg','ytdlp']) config[key] = resolve(config[key]);
Object.assign(config, { chunkSeconds: Number(option('--chunk', String(config.chunkSeconds))),
  diarizationDirectory: resolve(base.diarizationDirectory ?? 'bin/diarization'),
  diarizationPython: base.diarizationPython ?? 'C:/Python314/python.exe',
  diarizationChunkFrames: Number(option('--diar-chunk', '64')), liveDiarization: true,
  engineLog: directory + '/asr.log', diarizationLog: directory + '/diarization.log',
  recordAudio: true, recordings: directory + '/recordings', maxRecordingBytes: (seconds + 180) * 32000 });
const replay = replayPath ? JSON.parse(await readFile(replayPath, 'utf8')) : null;
const sourceDocument = replay ?? JSON.parse(await readFile(option('--sources', 'reports/live-diarization-20261021/news-sources.json'), 'utf8'));
const sources = sourceDocument.sources.slice(0, count);
const result = { started_at: new Date().toISOString(), mode: capacity ? 'capacity' : replay ? 'recorded-realtime' : 'youtube-live',
  requested_seconds: seconds, requested_inputs: count, sources, config, passed: false,
  machine: { cpu: cpus()[0].model, logical_cpus: cpus().length, ram_mb: totalmem() / 1048576 },
  scope: 'Actual GPU ASR and CPU streaming diarization; no AI correction, public publication or viewer load' };
const store = new Store(directory + '/test.sqlite'); const engine = new WhisperEngine(config);
const scheduler = new Scheduler(store, engine, config); scheduler.diarizer = new LiveDiarization(store, config);
scheduler.metrics.diarization = scheduler.diarizer.metrics;
const inputs = new FileInputs(scheduler, config); const resources = new ResourceSampler(); const resourceSamples = [];
const tasks = []; const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false; let deadlineTimer;
const ownedPids = () => [process.pid, engine.child?.pid, scheduler.diarizer.engine.child?.pid,
  ...[...inputs.children.values()].map(child => child.pid)].filter(Number.isSafeInteger);
async function stopInputs() { if (stopping) return; stopping = true; await inputs.close(); }
process.on('SIGINT', () => { stopInputs().catch(() => { process.exitCode = 1; }); });
try {
  if (sources.length !== count || new Set(sources.map(source => source.channel_id)).size !== count)
    throw new Error('Need distinct approved news sources');
  if (!replay) {
    await Promise.all(sources.map(async source => {
      const metadata = await run(config.ytdlp, ['--ignore-config','--no-plugin-dirs','--no-playlist','--skip-download',
        '--js-runtimes','node:' + process.execPath,'--socket-timeout','15','--retries','1',
        '--print','%(id)s\t%(channel_id)s\t%(live_status)s', source.page_url],
      { windowsHide: true, timeout: 45000, maxBuffer: 1048576 });
      const [id, channel, state] = metadata.stdout.trim().split('\t');
      if (id !== source.video_id || channel !== source.channel_id || state !== 'is_live') throw new Error('Source is not the verified live broadcast');
      source.rechecked_at = new Date().toISOString();
    }));
  }
  await engine.start(); await scheduler.diarizer.start(); result.engine = engine.metadata; result.diarization = scheduler.diarizer.engine.metadata;
  deadlineTimer = setTimeout(() => { stopInputs().catch(() => { process.exitCode = 1; }); }, (seconds + 150) * 1000);
  for (const [index, source] of sources.entries()) {
    const stream = { ...source, stream_id: 'ch' + (index + 1), kind: 'youtube', approved: true, capture_from_start: false };
    store.saveStream(stream); scheduler.start(stream);
    if (replay) {
      const recording = replay.recordings.find(item => item.video_id === source.video_id);
      if (!recording) throw new Error('Replay recording missing');
      tasks.push(inputs.start(stream, recording.file, !capacity, { raw: true, local: true, duration: seconds }));
    } else tasks.push(inputs.startYouTube(stream));
  }
  const readyDeadline = Date.now() + 60000;
  while (!scheduler.states().every(state => state.last_receive_ms)) {
    if (Date.now() > readyDeadline || scheduler.states().some(state => state.error || state.state === 'stopped'))
      throw new Error('Not all inputs received live audio');
    await sleep(250);
  }
  result.measurement_started_at = new Date().toISOString(); const started = Date.now();
  const initial = Object.fromEntries(scheduler.states().map(state => [state.stream_id, state.total_received_s]));
  result.initial_audio_s = initial;
  console.log(JSON.stringify({ event: 'measurement.start', mode: result.mode, inputs: count, seconds }));
  while (capacity ? scheduler.states().some(state => state.state !== 'stopped') : Date.now() - started < seconds * 1000) {
    if (Date.now() - started > (seconds + 90) * 1000 || stopping) break;
    const states = scheduler.states();
    resourceSamples.push({ ...await resources.sample(ownedPids()), states });
    if (states.some(state => state.error || (!replay && state.state === 'stopped'))) throw new Error('An input stopped or failed during the measurement');
    if (resourceSamples.length % 10 === 0) {
      await writeFile(directory + '/progress.json', JSON.stringify({ elapsed_s: (Date.now() - started) / 1000,
        states, metrics: scheduler.metrics }, null, 2));
      console.log(JSON.stringify({ event: 'measurement.progress', elapsed_s: (Date.now() - started) / 1000,
        jobs: scheduler.metrics.jobs, speaker_errors: scheduler.diarizer.metrics.errors }));
    }
    await sleep(1000);
  }
  result.input_window_s = (Date.now() - started) / 1000;
  result.received_in_window = scheduler.states().map(state => ({ stream_id: state.stream_id,
    seconds: state.total_received_s - initial[state.stream_id] }));
  await stopInputs(); await Promise.all(tasks);
  const drain = Date.now();
  while (scheduler.busy || scheduler.finishes.size) {
    if (Date.now() - drain > 95000) throw new Error('Queue drain deadline exceeded');
    await sleep(100);
  }
  result.drain_ms = Date.now() - drain;
  result.states = scheduler.states(); result.metrics = scheduler.metrics; result.samples = scheduler.samples;
  const rows = sources.flatMap((source, index) => store.segments({ stream: 'ch' + (index + 1), limit: 200 }).items);
  const scopes = new Map(); let scope_collisions = 0;
  for (const row of rows) if (row.speaker_scope) {
    const owner = scopes.get(row.speaker_scope);
    if (owner && owner !== row.stream_id + ':' + row.session_id + ':' + row.timeline_epoch) scope_collisions++;
    scopes.set(row.speaker_scope, row.stream_id + ':' + row.session_id + ':' + row.timeline_epoch);
  }
  result.speaker_scope_collisions = scope_collisions;
  result.speaker_scope_count = scopes.size;
  result.per_channel = sources.map((source, index) => {
    const selected = rows.filter(row => row.stream_id === 'ch' + (index + 1));
    return { name: source.name, video_id: source.video_id, rows: selected.length,
      assigned: selected.filter(row => row.speaker_state === 'assigned').length,
      multiple: selected.filter(row => row.speaker_state === 'multiple').length,
      pending: selected.filter(row => row.speaker_state === 'pending').length,
      unavailable: selected.filter(row => row.speaker_state === 'unavailable').length,
      unknown: selected.filter(row => row.speaker_state === 'unknown').length,
      speaker_ids: [...new Set(selected.flatMap(row => (row.speaker_turns ?? []).map(turn => turn.speaker_id)))].sort(),
      speaker_readiness_p95_ms: percentile(selected.map(row => row.speaker_latency_ms), .95) };
  });
  result.latency = { asr_readiness_p95_ms: percentile(scheduler.samples.map(s => s.readiness_ms), .95),
    queue_p95_ms: percentile(scheduler.samples.map(s => s.queue_ms), .95),
    diarization_inference_p95_ms: percentile(scheduler.samples.map(s => s.diarization_ms), .95),
    speaker_readiness_p95_ms: percentile(rows.map(row => row.speaker_latency_ms), .95) };
  result.audio_seconds = result.states.reduce((sum, state) => sum + state.total_received_s, 0);
  result.functional_pass = scope_collisions === 0 && scheduler.metrics.errors === 0 && scheduler.metrics.gaps === 0
    && scheduler.diarizer.metrics.errors === 0 && result.states.every(state => state.state === 'stopped' && state.queue_length === 0
      && state.total_processed_s >= state.total_received_s - .01 && state.total_received_s >= seconds - 2)
    && result.per_channel.every(channel => channel.assigned + channel.multiple > 0 && channel.pending === 0);
  result.readiness_budget_ms = 30000;
  result.passed = result.functional_pass && (capacity || (result.latency.asr_readiness_p95_ms <= 30000
    && result.latency.speaker_readiness_p95_ms <= 30000));
} catch (error) {
  result.error = String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0,500); process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer); await stopInputs(); await Promise.allSettled(tasks);
  result.final_states = scheduler.states(); result.final_metrics = scheduler.metrics;
  await scheduler.close();
  result.recordings = await Promise.all(sources.map(async (source, index) => {
    const state = scheduler.channels.get('ch' + (index + 1));
    const file = resolve(config.recordings, 'ch' + (index + 1), state?.session_id ?? '', 'audio.pcm');
    const fileStat = await stat(file).catch(() => null);
    return { video_id: source.video_id, file, bytes: fileStat?.size ?? 0, seconds: (fileStat?.size ?? 0) / 32000 };
  }));
  result.resources = resourceSamples; result.finished_at = new Date().toISOString();
  result.elapsed_s = (Date.parse(result.finished_at) - Date.parse(result.started_at)) / 1000;
  result.capacity_audio_per_wall_second = result.audio_seconds ? result.audio_seconds / result.elapsed_s : 0;
  if (capacity) {
    result.required_audio_per_wall_second = count;
    result.capacity_target_met = result.capacity_audio_per_wall_second >= count;
    result.passed = result.passed && result.capacity_target_met;
  }
  result.resource_summary = { cpu_p95_percent: percentile(resourceSamples.map(s => s.cpu_percent), .95),
    gpu_peak_memory_mb: resourceSamples.some(s => Number.isFinite(s.gpu_memory_mb))
      ? Math.max(...resourceSamples.map(s => s.gpu_memory_mb).filter(Number.isFinite)) : null,
    gpu_query_failures: resourceSamples.filter(s => s.gpu_query_error).length,
    owned_peak_memory_mb: Math.max(0, ...resourceSamples.map(s => s.worker_memory_mb ?? 0)),
    host_peak_used_memory_mb: Math.max(0, ...resourceSamples.map(s => s.host_used_memory_mb)) };
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2)); store.close();
  console.log(JSON.stringify({ event: 'measurement.finished', directory, passed: result.passed,
    functional_pass: result.functional_pass, latency: result.latency, error: result.error }));
}
if (!result.passed) process.exitCode = 1;
