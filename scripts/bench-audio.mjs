import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine } from '../src/engine.mjs';
import { FileInputs } from '../src/files.mjs';
import { createService } from '../src/server.mjs';
import { percentile } from './viewer-client.mjs';

const [mode = 'capacity', countText = '8', durationText = '30', configPath = 'config.local.json',
  outputPath = 'reports/audio-' + Date.now(), chunkText] = process.argv.slice(2);
const count = Number(countText); const duration = Number(durationText);
if (!['capacity', 'realtime', 'integrated'].includes(mode) || !Number.isInteger(count) || count < 1 || count > 8
  || !Number.isInteger(duration) || duration < 5 || duration > 7200) throw new Error('Invalid benchmark arguments');
const config = JSON.parse(readFileSync(configPath));
if (chunkText) config.chunkSeconds = Number(chunkText);
if (![5, 10].includes(config.chunkSeconds)) throw new Error('Use 5 or 10 seconds');
const output = resolve(outputPath); mkdirSync(output, { recursive: true });
config.database = output + '/events.sqlite'; config.engineLog = output + '/engine.log';
if (existsSync(config.database)) throw new Error('Use a new report directory; existing evidence must not be overwritten');
config.adminToken = randomBytes(32).toString('hex'); config.viewerToken = randomBytes(32).toString('hex');
const sources = Array.from({ length: count }, (_, i) => {
  const path = config.benchmarkPcm?.['ch' + (i + 1)] ?? 'data/synthetic-speech/ch' + (i + 1) + '.pcm';
  const bytes = readFileSync(path);
  if (bytes.length < duration * 32000 && !config.loopInput) throw new Error('Audio shorter than requested duration: ' + path);
  if (config.loopInput && !config.collectorInput) throw new Error('Looped input requires FFmpeg collectors');
  return { id: 'ch' + (i + 1), path, bytes: bytes.subarray(0, duration * 32000),
    original_seconds: bytes.length / 32000,
    sha256: createHash('sha256').update(bytes.subarray(0, duration * 32000)).digest('hex') };
});
const store = new Store(config.database); const engine = new WhisperEngine(config);
const scheduler = new Scheduler(store, engine, config); const inputs = new FileInputs(scheduler, config);
const service = createService({ store, scheduler, inputs, config });
const gpuSamples = []; let monitorBusy = false; let viewerProcess; let reconnectMs = null;
const cpuTotals = () => cpus().reduce((sum,cpu) => ({ idle:sum.idle+cpu.times.idle,
  total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0) }), {idle:0,total:0});
let previousCpu = cpuTotals(); let lastNativeSample = 0; let nativeProcesses = null;
let viewerResults = { connections: 0, subscriptions: 0, missing_segment_versions: 0 };
async function viewerCommand(payload) {
  const reply = once(viewerProcess, 'message'); viewerProcess.send(payload);
  const result = (await reply)[0]; if (result.error) throw new Error(result.error); return result;
}
const monitor = setInterval(() => {
  if (monitorBusy) return; monitorBusy = true;
  execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,utilization.memory', '--format=csv,noheader,nounits'],
    { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      const cpu = cpuTotals(); const delta = cpu.total - previousCpu.total;
      gpuSamples.push({ time_ms: Date.now(), gpu: error ? null : stdout.trim(), node_rss: process.memoryUsage().rss,
        system_cpu_percent: delta ? 100 * (1 - (cpu.idle - previousCpu.idle) / delta) : null,
        native_processes: nativeProcesses, database_bytes: existsSync(config.database) ? statSync(config.database).size : null });
      previousCpu = cpu; monitorBusy = false;
      if (Date.now() - lastNativeSample > 30000 && engine.child?.pid) {
        lastNativeSample = Date.now();
        const pids = [engine.child.pid, process.pid, viewerProcess?.pid].filter(Number.isInteger).join(',');
        execFile('powershell.exe', ['-NoProfile', '-Command',
          'Get-Process -Id ' + pids + ' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PeakWorkingSet64,CPU | ConvertTo-Json -Compress'],
        { windowsHide:true, timeout:10000 }, (error, output) => {
          if (!error) { try { nativeProcesses = { sampled_at:Date.now(), processes:JSON.parse(output) }; } catch { nativeProcesses = null; } }
        });
      }
    });
}, 2000);
try {
  console.error('stage: engine-start');
  await engine.start();
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  for (const source of sources) {
    const stream = { stream_id: source.id, name: source.id, kind: 'file', approved: true, approval_note: 'benchmark fixture', prompt: '' };
    store.saveStream(stream); scheduler.start(stream);
  }
  if (mode === 'integrated') {
    console.error('stage: connect-viewers');
    viewerProcess = fork(new URL('./viewer-host.mjs', import.meta.url), [], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    await viewerCommand({ action: 'connect', base: 'http://127.0.0.1:' + service.server.address().port,
      token: config.viewerToken, count: 300, publicFeed: config.publicFeed === true });
  }
  const begin = Date.now(); const cpuStart = process.cpuUsage();
  console.error('stage: feed-audio');
  let interrupted = false; let fedSeconds = 0;
  const collectors = config.collectorInput ? sources.map(source => inputs.start(
    store.streams().find(s => s.stream_id === source.id), source.path, mode !== 'capacity', { raw: true, duration, loop: config.loopInput })) : [];
  for (let second = 0; second < duration; second++) {
    if (existsSync(output + '/stop.request')) { interrupted = true; await inputs.close(); break; }
    fedSeconds = second + 1;
    if (mode !== 'capacity') {
      const delay = begin + second * 1000 - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    for (const source of config.collectorInput ? [] : sources) {
      const channel = scheduler.channel(source.id);
      if (mode === 'capacity') while (channel.queue.length >= config.queueChunks - 1) await new Promise(resolve => setTimeout(resolve, 5));
      scheduler.feed(source.id, { session_id: channel.session_id, epoch: channel.timeline_epoch,
        seq: channel.next_seq, pcm: source.bytes.subarray(second * 32000, (second + 1) * 32000) });
    }
    if (mode === 'integrated' && second === Math.floor(duration / 2)) {
      console.error('stage: reconnect-viewers');
      reconnectMs = (await viewerCommand({ action: 'reconnect' })).reconnect_ms;
    }
    if (second % 30 === 0) writeFileSync(output + '/progress.json', JSON.stringify({
      elapsed_s: second, total_s: duration, updated_at: new Date().toISOString(), metrics: scheduler.metrics,
      states: scheduler.states(), viewers: { ...service.feed.metrics, active: service.feed.clients.size }
    }, null, 2));
  }
  if (collectors.length) await Promise.all(collectors);
  if (mode !== 'capacity' && !interrupted) {
    const delay = begin + duration * 1000 - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  for (const source of sources) scheduler.stop(source.id);
  while (scheduler.busy) await new Promise(resolve => setTimeout(resolve, 10));
  const wall = (Date.now() - begin) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const segments = sources.flatMap(source => {
    const rows = []; let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const page = store.segments({ stream: source.id, before, limit: 200 });
      if (!page.items.length) break;
      rows.push(...page.items); before = page.before;
    }
    return rows;
  });
  const byStream = sources.map(source => {
    const samples = scheduler.samples.filter(s => s.stream_id === source.id);
    return { stream_id: source.id, jobs: samples.length, audio_s: samples.reduce((sum, s) => sum + s.unique_s, 0),
      p50_ms: percentile(samples.map(s => s.readiness_ms), 0.5), p95_ms: percentile(samples.map(s => s.readiness_ms), 0.95),
      p99_ms: percentile(samples.map(s => s.readiness_ms), 0.99),
      max_ms: Math.max(...samples.map(s => s.readiness_ms)), over_30s: samples.filter(s => s.readiness_ms > 30000).length,
      first_half_queue_p95: percentile(samples.slice(0, Math.ceil(samples.length / 2)).map(s => s.queue_ms), 0.95),
      second_half_queue_p95: percentile(samples.slice(Math.ceil(samples.length / 2)).map(s => s.queue_ms), 0.95) };
  });
  const expectedEvents = viewerProcess ? store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind<>'metric'").get().count * 300 : null;
  if (viewerProcess) viewerResults = await viewerCommand({ action: 'summary', expected_events: expectedEvents,
    segments: segments.map(({ segment_id, version }) => ({ segment_id, version })) });
  const report = { mode, source: config.benchmarkSourceDescription ?? (config.benchmarkPcm ? 'operator configured PCM' : 'eight distinct synthetic Korean TTS files'),
    looped_input: Boolean(config.loopInput), distinct_source_audio_s: sources.reduce((sum,s)=>sum+Math.min(duration,s.original_seconds),0),
    audio_accounting: config.loopInput ? 'processed audio includes repeated playback; no transcript result cache' : 'source audio without overlap',
    input_path: config.collectorInput ? 'independent FFmpeg processes' : 'scheduler PCM injection',
    interrupted, completed_feed_seconds: fedSeconds,
    started_at: new Date(begin).toISOString(), streams: count, input_duration_s: duration, measured_wall_s: wall,
    capacity_audio_s_per_wall_s: scheduler.metrics.unique_audio_s / wall,
    capacity_interpretation: mode === 'capacity' ? 'saturated offline throughput, includes scheduler and persistence' : 'observed paced input; not maximum capacity',
    engine: engine.metadata, model_sha256: createHash('sha256').update(readFileSync(config.model)).digest('hex'),
    chunk_seconds: config.chunkSeconds, overlap_seconds: 0, batch: 1, beam: config.beam, silence_rms: config.silenceRms,
    metrics: scheduler.metrics, by_stream: byStream, states: scheduler.states(), viewers: viewerResults,
    viewer_connections_end: service.feed.clients.size + service.viewerFeed.clients.size,
    viewer_endpoint: config.publicFeed ? '/api/viewer/events' : '/api/events',
    expected_events: expectedEvents,
    missing_events: viewerProcess ? expectedEvents - viewerResults.received_events : null,
    missing_segment_versions: viewerResults.missing_segment_versions,
    simultaneous_reconnect_ms: reconnectMs, node_cpu_us: cpu, rss_bytes: process.memoryUsage().rss,
    audio_sources: sources.map(({ id, sha256, original_seconds }) => ({ id, sha256, original_seconds })) };
  writeFileSync(output + '/summary.json', JSON.stringify(report, null, 2));
  writeFileSync(output + '/samples.json', JSON.stringify(scheduler.samples, null, 2));
  writeFileSync(output + '/resources.json', JSON.stringify(gpuSamples, null, 2));
  writeFileSync(output + '/transcripts.json', JSON.stringify(segments, null, 2));
  const incomplete = scheduler.states().some(s => Math.abs(s.total_processed_s - duration) > 0.1);
  if (interrupted || incomplete || scheduler.metrics.errors || scheduler.metrics.gaps
    || (viewerProcess && (report.missing_events || report.missing_segment_versions || report.viewer_connections_end !== 300))) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(monitor);
  if (viewerProcess) { const exited = once(viewerProcess, 'exit'); viewerProcess.send({ action: 'stop' }); await exited; }
  await scheduler.close(); if (service.server.listening) await service.close(); store.close();
}
