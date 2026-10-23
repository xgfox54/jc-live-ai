import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { EnginePool } from '../src/engine.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { FileInputs } from '../src/files.mjs';
import { LiveDiarization } from '../src/live-diarization.mjs';
import { createService } from '../src/server.mjs';
import { ResourceSampler, percentile } from './bench-resources.mjs';

const [mode, secondsText, outputText, manifestPath, countText = '8'] = process.argv.slice(2);
const seconds = Number(secondsText); const count = Number(countText); const output = resolve(outputText);
if (!['realtime', 'capacity'].includes(mode) || !Number.isInteger(seconds) || seconds < 10 || seconds > 7200
  || !Number.isInteger(count) || count < 1 || count > 8) throw new Error('Invalid benchmark arguments');
mkdirSync(output, { recursive: true });
if (existsSync(output + '/events.sqlite')) throw new Error('Use a new output directory');
const base = JSON.parse(readFileSync('config.local.json'));
const config = Object.fromEntries(['worker', 'model', 'device', 'beam', 'batch', 'chunkSeconds', 'queueChunks', 'silenceRms',
  'ffmpeg', 'diarizationDirectory', 'diarizationPython', 'diarizationChunkFrames', 'speechGate', 'segmentSeconds', 'decode', 'workers', 'flashAttention']
  .filter(key => base[key] !== undefined).map(key => [key, base[key]]));
for (const key of ['worker', 'model', 'ffmpeg', 'diarizationDirectory']) config[key] = resolve(config[key]);
writeFileSync(output + '/runtime-config.json', JSON.stringify(config, null, 2));
Object.assign(config, { manualMode: true, liveDiarization: true, altRecognizer: false, recordAudio: false,
  database: output + '/events.sqlite', engineLog: output + '/engine.log', diarizationLog: output + '/diarization.log',
  minutesDirectory: output + '/minutes', speakerLabels: output + '/speaker-labels.json',
  adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex') });
if (config.device !== 'gpu') throw new Error('GPU configuration required');
const prior = JSON.parse(readFileSync(manifestPath));
const sources = prior.sources.slice(0, count).map((source, index) => {
  const recording = prior.recordings.find(item => item.video_id === source.video_id);
  if (!source.approved || !recording) throw new Error('Approved recording required');
  const bytes = readFileSync(recording.file);
  const sourceMeta = JSON.parse(readFileSync(resolve(recording.file, '../source.json')));
  if (sourceMeta.page_url !== source.page_url || bytes.length < 320000 || bytes.length % 2) throw new Error('Recording provenance or PCM length mismatch');
  return { stream_id: 'ch' + (index + 1), name: source.name, page_url: source.page_url, channel_id: source.channel_id,
    file: recording.file, original_seconds: bytes.length / 32000, sha256: createHash('sha256').update(bytes).digest('hex') };
});
if (sources.length !== count || new Set(sources.map(s => s.sha256)).size !== count
  || new Set(sources.map(s => s.channel_id)).size !== count) throw new Error('Independent recordings required');
writeFileSync(output + '/sources.json', JSON.stringify(sources, null, 2));
const store = new Store(config.database); const engine = new EnginePool(config);
const scheduler = new Scheduler(store, engine, config); scheduler.diarizer = new LiveDiarization(store, config);
scheduler.metrics.diarization = scheduler.diarizer.metrics;
const inputs = new FileInputs(scheduler, config); const service = createService({ store, scheduler, inputs, config });
const sampler = new ResourceSampler(); const resources = []; const collectors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let viewerProcess; let begun; let inputFinished = false; let reconnect = null; let backlogSince = null;
const result = { mode, requested_seconds: seconds, requested_inputs: count, requested_clients: 300,
  started_at: new Date().toISOString(), passed: false,
  scope: 'Current GPU Whisper, CPU Nemotron, independent FFmpeg, SQLite, 300 public SSE clients on loopback. Actual live drafts, no AI correction or cloud publishing.',
  repeated_playback: sources.some(s => seconds > s.original_seconds), cloud_sync_enabled: false };
const ownedPids = () => [process.pid, viewerProcess?.pid, ...engine.engines.map(e => e.child?.pid),
  scheduler.diarizer.engine.child?.pid, ...[...inputs.children.values()].map(c => c.pid)].filter(Number.isSafeInteger);
const hardDeadline = setTimeout(() => {
  writeFileSync(output + '/deadline.json', JSON.stringify({ at: new Date().toISOString(), owned_pids: ownedPids(), reason: 'Hard deadline' }));
  for (const pid of ownedPids().filter(pid => pid !== process.pid)) {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch {}
  }
  process.exit(2);
}, (seconds + 600) * 1000);
async function command(payload) {
  const reply = once(viewerProcess, 'message', { signal: AbortSignal.timeout(20000) });
  viewerProcess.send(payload); const [response] = await reply;
  if (response.error) throw new Error(response.error); return response;
}
async function capture(phase) {
  const states = scheduler.states();
  const sample = { ...await sampler.sample(ownedPids()), elapsed_s: (Date.now() - begun) / 1000, phase, states,
    lag_seconds: states.map(s => ({ stream_id: s.stream_id, seconds: s.total_received_s - s.total_processed_s })),
    active_clients: service.viewerFeed.clients.size, metrics: structuredClone(scheduler.metrics) };
  resources.push(sample); appendFileSync(output + '/resources.jsonl', JSON.stringify(sample) + '\n');
  writeFileSync(output + '/progress.json', JSON.stringify(sample, null, 2));
  return states;
}
try {
  await engine.start(); await scheduler.diarizer.start();
  result.engine = engine.metadata; result.diarization = scheduler.diarizer.engine.metadata;
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  viewerProcess = fork(new URL('./viewer-host.mjs', import.meta.url), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  result.connection = await command({ action: 'connect', base: 'http://127.0.0.1:' + service.server.address().port,
    token: config.viewerToken, count: 300, publicFeed: true });
  begun = Date.now(); result.measurement_started_at = new Date(begun).toISOString();
  for (const source of sources) {
    const stream = { stream_id: source.stream_id, name: source.name, kind: 'file', approved: true, prompt: '' };
    store.saveStream(stream); scheduler.start(stream);
    collectors.push(inputs.start(stream, source.file, mode === 'realtime', { raw: true, local: true, duration: seconds,
      loop: seconds > source.original_seconds }));
  }
  Promise.all(collectors).then(() => { inputFinished = true; });
  writeFileSync(output + '/started.json', JSON.stringify({ pid: process.pid, owned_pids: ownedPids(), port: service.server.address().port,
    started_at: result.measurement_started_at, deadline_at: new Date(Date.now() + (seconds + 580) * 1000).toISOString() }, null, 2));
  while (!inputFinished) {
    const elapsed = (Date.now() - begun) / 1000;
    if (elapsed > seconds + 300 || existsSync(output + '/stop.request')) throw new Error('Input deadline or operator stop');
    if (mode === 'realtime' && elapsed >= seconds / 2 && reconnect === null) reconnect = await command({ action: 'reconnect' });
    const states = await capture('feeding');
    const excessiveBacklog = mode === 'realtime' && states.some(s => s.total_received_s - s.total_processed_s > 120);
    backlogSince = excessiveBacklog ? backlogSince ?? Date.now() : null;
    if (backlogSince !== null && Date.now() - backlogSince > 30000) throw new Error('Backlog exceeded 120 seconds for 30 seconds');
    if (states.some(s => s.error)) throw new Error('Input error');
    await sleep(1000);
  }
  await Promise.all(collectors); result.feed_wall_s = (Date.now() - begun) / 1000;
  const drain = Date.now();
  while (scheduler.busy || scheduler.finishes.size || scheduler.states().some(s => s.queue_length > 0)) {
    if (Date.now() - drain > 180000) throw new Error('Drain deadline exceeded');
    await capture('draining'); await sleep(1000);
  }
  result.drain_seconds = (Date.now() - drain) / 1000;
  result.wall_seconds = (Date.now() - begun) / 1000;
  const rows = store.db.prepare('SELECT document FROM segments').all().map(row => JSON.parse(row.document));
  const expected = store.events(0, 10000000).filter(event => event.kind !== 'metric' && service.viewerFeed.project(event)).length * 300;
  result.viewers = await command({ action: 'summary', expected_events: expected, segments: rows.map(({ segment_id, version }) => ({ segment_id, version })) });
  result.expected_deliveries = expected; result.missing_deliveries = expected - result.viewers.received_events;
  result.reconnect = reconnect; result.active_clients = service.viewerFeed.clients.size; result.feed = service.viewerFeed.metrics;
  result.states = scheduler.states(); result.metrics = scheduler.metrics;
  result.audio_per_wall_second = scheduler.metrics.unique_audio_s / result.wall_seconds;
  result.latency = { readiness_p95_ms: percentile(scheduler.samples.map(s => s.readiness_ms), .95),
    queue_p95_ms: percentile(scheduler.samples.map(s => s.queue_ms), .95),
    speaker_p95_ms: percentile(rows.map(r => r.speaker_latency_ms), .95) };
  result.speakers = { total: rows.length, pending: rows.filter(r => r.speaker_state === 'pending').length,
    unavailable: rows.filter(r => r.speaker_state === 'unavailable').length,
    assigned_or_multiple: rows.filter(r => ['assigned', 'multiple'].includes(r.speaker_state)).length };
  const steady = resources.filter(s => s.phase === 'feeding' && s.elapsed_s >= 30);
  result.steady = { warmup_excluded_seconds: 30, observed_seconds: steady.length ? steady.at(-1).elapsed_s - steady[0].elapsed_s : 0,
    first_lag_seconds: steady[0]?.lag_seconds ?? [], last_lag_seconds: steady.at(-1)?.lag_seconds ?? [],
    readiness_p95_ms: percentile(scheduler.samples.filter(s => s.end_ms >= 30000).map(s => s.readiness_ms), .95) };
  result.functional_pass = result.states.every(s => Math.abs(s.total_received_s - seconds) < .1 && Math.abs(s.total_processed_s - seconds) < .1)
    && scheduler.metrics.errors === 0 && scheduler.metrics.gaps === 0 && scheduler.diarizer.metrics.errors === 0
    && sources.every(source => rows.some(row => row.stream_id === source.stream_id))
    && result.speakers.pending === 0 && result.speakers.unavailable === 0
    && result.active_clients === 300 && result.missing_deliveries === 0 && result.viewers.missing_segment_versions === 0
    && result.viewers.minimum_segment_versions === rows.length && result.viewers.live_segment_deliveries > 0;
  result.realtime_budget_pass = result.latency.readiness_p95_ms <= 30000 && result.latency.speaker_p95_ms !== null && result.latency.speaker_p95_ms <= 30000
    && result.viewers.readiness_including_transport.filter(s => sources.some(source => source.stream_id === s.stream_id))
      .every(s => s.samples > 0 && s.p95_ms <= 30000);
  result.passed = result.functional_pass && (mode === 'capacity' ? result.audio_per_wall_second >= count : result.realtime_budget_pass);
  writeFileSync(output + '/samples.json', JSON.stringify(scheduler.samples));
  writeFileSync(output + '/transcripts.json', JSON.stringify(rows));
} catch (error) {
  result.error = error.message; process.exitCode = 1;
} finally {
  writeFileSync(output + '/samples.json', JSON.stringify(scheduler.samples));
  writeFileSync(output + '/transcripts.json', JSON.stringify(store.db.prepare('SELECT document FROM segments').all().map(row => JSON.parse(row.document))));
  result.final_states = scheduler.states(); result.final_metrics = scheduler.metrics;
  result.resources = { cpu_p95_percent: percentile(resources.map(s => s.cpu_percent), .95),
    gpu_p95_percent: percentile(resources.map(s => s.gpu_percent), .95),
    gpu_peak_memory_mb: Math.max(0, ...resources.map(s => s.gpu_memory_mb ?? 0)),
    owned_peak_memory_mb: Math.max(0, ...resources.map(s => s.worker_memory_mb ?? 0)),
    host_peak_used_memory_mb: Math.max(0, ...resources.map(s => s.host_used_memory_mb ?? 0)) };
  await inputs.close(); await Promise.allSettled(collectors); await scheduler.close();
  if (viewerProcess?.connected) { const exited = once(viewerProcess, 'exit'); viewerProcess.send({ action: 'stop' }); await exited; }
  await service.liveCorrection.close(); await service.speakerDirectory.close(); await service.schedule.close();
  if (service.server.listening) await service.close(); else { service.feed.close(); service.viewerFeed.close(); service.minutes.close(); }
  store.close(); clearTimeout(hardDeadline); result.finished_at = new Date().toISOString();
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
if (!result.passed) process.exitCode = 1;
