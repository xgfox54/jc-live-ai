import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine } from '../src/engine.mjs';
import { FileInputs } from '../src/files.mjs';
import { createService } from '../src/server.mjs';
import { videoId } from '../src/validate.mjs';

const input = process.argv[2];
if (!input) throw new Error('Pass a local speech audio path or an approved YouTube replay URL.');
const remote = input.startsWith('https://');
const id = remote ? videoId(input) : 'smoketest00';
if (!id) throw new Error('A concrete YouTube video URL is required.');
const directory = resolve('reports/automation-' + Date.now()); mkdirSync(directory, { recursive: true });
const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
for (const key of ['worker', 'model', 'ffmpeg', 'ytdlp']) config[key] = resolve(config[key]);
Object.assign(config, { engineLog: directory + '/engine.log', database: directory + '/events.sqlite',
  recordings: directory + '/recordings', minutesDirectory: directory + '/minutes', recordAudio: false });
const store = new Store(config.database); const engine = new WhisperEngine(config);
const scheduler = new Scheduler(store, engine, config); const inputs = new FileInputs(scheduler, config);
let launches = 0;
const startYouTube = inputs.startYouTube.bind(inputs);
inputs.startYouTube = stream => {
  launches++;
  if (remote) return startYouTube(stream);
  const upstream = spawn(config.ffmpeg, ['-nostdin', '-v', 'error', '-i', resolve(input), '-vn', '-f', 'wav', 'pipe:1'],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  upstream.result = new Promise(resolve => {
    upstream.once('error', () => resolve({ error: true })); upstream.once('close', code => resolve({ code }));
  });
  upstream.stderr.resume();
  return inputs.start(stream, 'pipe:0', false, { upstream });
};
let phase = 'waiting';
const service = createService({ store, scheduler, config, inputs,
  probe: async source => ({ phase, source, key: 'youtube:' + source.video_id }) });
const source = { page_url: 'https://www.youtube.com/watch?v=' + id, video_id: id,
  title: remote ? '검증용 공식 다시보기 수집' : '검증용 합성 음성 · 실제 회의 아님',
  sources: ['https://www.youtube.com/watch?v=' + id], kind: 'youtube', phase: 'waiting', discovered_from: 'youtube' };
service.discovery.scanSources = async () => [source, source];
let result;
try {
  await engine.start();
  await service.discovery.scan(); await service.discovery.scan();
  assert.equal(store.streams().length, 1); await service.monitor.tick(); assert.equal(launches, 0);
  phase = 'live'; const stream = store.streams()[0]; await service.monitor.check(stream); assert.equal(launches, 1);
  const deadline = Date.now() + 180000; let manuallyStopped = false;
  while (Date.now() < deadline) {
    const state = scheduler.channel(stream.stream_id);
    if (state.error) throw new Error(state.error);
    if (remote && state.total_received_s >= 30 && !manuallyStopped) {
      service.monitor.setEnabled(store.streams()[0], false); await inputs.stop(stream.stream_id); manuallyStopped = true;
    }
    if (state.state === 'stopped') break;
    await delay(100);
  }
  const state = scheduler.channel(stream.stream_id); assert.equal(state.state, 'stopped'); assert.ok(state.total_received_s >= 10);
  assert.equal(scheduler.metrics.errors, 0); assert.equal(scheduler.metrics.gaps, 0); service.minutes.flush();
  const minutes = service.registry.minutes(stream.broadcast_id);
  assert.ok(minutes); assert.equal(minutes.status, 'draft');
  if (!remote) assert.ok(minutes.segment_count > 0);
  assert.equal(JSON.parse(readFileSync(directory + '/minutes/' + minutes.id + '.json')).segment_count, minutes.segment_count);
  const recordedBytes = statSync(directory + '/recordings/' + stream.stream_id + '/' + state.session_id + '/audio.pcm').size;
  assert.equal(recordedBytes / 32000, state.total_received_s);
  result = { passed: true, tested_at: new Date().toISOString(), detection: 'simulated official directory and waiting-to-live transition',
    audio: remote ? 'approved official YouTube replay; 30-second collection with beginning option' : 'local synthetic speech through real FFmpeg pipe',
    engine: engine.metadata, launches, recordedBytes, received_s: state.total_received_s, processed_s: state.total_processed_s,
    gaps: scheduler.metrics.gaps, segment_count: minutes.segment_count, minutes_status: minutes.status,
    broadcast_id: stream.broadcast_id, report_directory: directory };
  writeFileSync(directory + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  await service.discovery.close(); await service.monitor.close(); await inputs.close(); await scheduler.close();
  service.minutes.close(); store.close();
}
