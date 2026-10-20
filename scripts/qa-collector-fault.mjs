import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine } from '../src/engine.mjs';
import { FileInputs } from '../src/files.mjs';
const output = resolve('reports/collector-fault'); mkdirSync(output, { recursive: true });
const config = JSON.parse(readFileSync('data/config-real.json', 'utf8'));
Object.assign(config, { database: output + '/events.sqlite', engineLog: output + '/engine.log', recordAudio: false });
if (existsSync(config.database)) throw Error('Use a fresh report directory');
const store = new Store(config.database); const engine = new WhisperEngine(config);
const scheduler = new Scheduler(store, engine, config); const inputs = new FileInputs(scheduler, config);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await engine.start();
  for (let i = 1; i <= 8; i++) {
    const stream = { stream_id: 'ch' + i, name: 'authorized recording ' + i, kind: 'file', approved: true };
    store.saveStream(stream); scheduler.start(stream);
    inputs.start(stream, config.benchmarkPcm[stream.stream_id], true, { raw: true, duration: 60 });
  }
  await sleep(12000); const before = scheduler.states();
  const killedPid = inputs.children.get('ch1')?.pid;
  assert.ok(Number.isInteger(killedPid)); process.kill(killedPid);
  await sleep(13000); const after = scheduler.states();
  const isolated = after.filter(state => state.stream_id !== 'ch1').every(state => {
    const prior = before.find(row => row.stream_id === state.stream_id);
    return !state.error && state.total_received_s > prior.total_received_s + 10 && state.total_processed_s > prior.total_processed_s;
  });
  const failed = scheduler.channel('ch1');
  assert.equal(failed.state, 'stopped'); assert.ok(failed.error); assert.ok(isolated);
  const oldSession = failed.session_id; const stream = store.streams().find(row => row.stream_id === 'ch1');
  scheduler.start(stream); inputs.start(stream, config.benchmarkPcm.ch1, true, { raw: true, duration: 12 });
  await sleep(13000); await inputs.close();
  for (const row of store.streams()) scheduler.stop(row.stream_id);
  while (scheduler.busy) await sleep(20);
  const resumed = scheduler.channel('ch1');
  assert.notEqual(resumed.session_id, oldSession); assert.ok(resumed.total_processed_s >= 10);
  const gaps = store.db.prepare("SELECT payload FROM events WHERE kind='gap'").all().map(row => JSON.parse(row.payload));
  assert.ok(gaps.some(gap => gap.stream_id === 'ch1' && gap.reason === 'collector_failed'));
  const result = { checked_at: new Date().toISOString(), actual_process_kill: true, killed_pid: killedPid,
    input: 'eight distinct authorized recordings at real-time pace', before, after, states: scheduler.states(),
    other_seven_continued: isolated, new_session_recovery: true, gaps, metrics: scheduler.metrics };
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await inputs.close(); await scheduler.close(); store.close(); }
