import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine } from '../src/engine.mjs';
import { FileInputs } from '../src/files.mjs';
import { createService } from '../src/server.mjs';
const captureOnly = process.argv.includes('--capture-only');
const output = resolve('reports/council-' + (captureOnly ? 'capture' : 'gpu'));
mkdirSync(output, { recursive: true });
const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
Object.assign(config, { database: output + '/events.sqlite', engineLog: output + '/engine.log',
  recordings: output + '/recordings', recordAudio: true, adminToken: randomBytes(32).toString('hex'),
  viewerToken: randomBytes(32).toString('hex') });
if (existsSync(config.database)) throw Error('Use a fresh report directory');
const store = new Store(config.database);
const engine = captureOnly ? { ready: true, metadata: { fixture: 'capture-only, no transcription' },
  start: async () => {}, stop: async () => {}, transcribe: async () => ({ spans: [], inference_ms: 0 }) } : new WhisperEngine(config);
const scheduler = new Scheduler(store, engine, config); const inputs = new FileInputs(scheduler, config);
const service = createService({ store, scheduler, inputs, config });
const started = Date.now(); const registered = [];
try {
  await engine.start(); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = 'http://127.0.0.1:' + service.server.address().port;
  async function post(path, value) {
    const response = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + config.adminToken },
      body: value ? JSON.stringify(value) : undefined });
    const body = await response.json(); if (!response.ok) throw Error(body.error); return body;
  }
  for (const [index, seq] of ['7010', '7035'].entries()) {
    const id = 'ch' + (index + 1);
    registered.push(await post('/api/admin/streams', { stream_id: id, name: 'Official council ' + seq,
      kind: 'council', page_url: 'https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=' + seq,
      approved: true, approval_note: 'User requested council source; official player verified on 2026-10-20' }));
    await post('/api/admin/streams/' + id + '/start');
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && scheduler.states().some(state => state.total_received_s < 30 && !state.error)) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await inputs.close(); for (const stream of registered) scheduler.stop(stream.stream_id);
  while (scheduler.busy) await new Promise(resolve => setTimeout(resolve, 20));
  const recordings = scheduler.states().map(state => {
    const path = config.recordings + '/' + state.stream_id + '/' + state.session_id + '/audio.pcm';
    return { stream_id: state.stream_id, path, bytes: existsSync(path) ? statSync(path).size : 0 };
  });
  const result = { checked_at: new Date().toISOString(), elapsed_s: (Date.now() - started) / 1000,
    mode: captureOnly ? 'real official source collection; inference fixture, no STT claim' : 'real official source collection and shared GPU transcription',
    states: scheduler.states(), metrics: scheduler.metrics, sources: registered.map(({ approval_note, prompt, ...source }) => source),
    recordings, transcripts: registered.flatMap(source => store.segments({ stream: source.stream_id }).items) };
  result.passed = result.states.length === 2 && result.states.every(state => state.total_received_s >= 30 && !state.error)
    && result.recordings.every(recording => recording.bytes >= 30 * 32000);
  if (!captureOnly) result.passed &&= result.transcripts.length > 0;
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
} finally { await inputs.close(); await scheduler.close(); if (service.server.listening) await service.close(); store.close(); }
