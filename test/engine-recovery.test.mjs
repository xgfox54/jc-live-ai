import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine, EnginePool } from '../src/engine.mjs';

const config = { chunkSeconds: 5, queueChunks: 2, silenceRms: 0, recoveryRetryMs: 5 };
const fakeEngine = () => ({ ready: true, metadata: {}, stop: async () => {},
  transcribe: async job => ({ spans: [{ text: job.prompt || 'recovered speech' }], inference_ms: 1 }) });
function feed(scheduler, id, count = 5) {
  const c = scheduler.channel(id);
  for (let n = 0; n < count; n++) scheduler.feed(id, { session_id: c.session_id,
    epoch: c.timeline_epoch, seq: c.next_seq, pcm: Buffer.alloc(32000, 20) });
}
async function until(check) {
  const end = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function workerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jc-recovery-'));
  const worker = join(dir, 'fake-worker.cjs');
  writeFileSync(worker, `const {createInterface}=require('node:readline');
console.log(JSON.stringify({ready:true}));
createInterface({input:process.stdin}).on('line',line=>{const j=JSON.parse(line);
setTimeout(()=>console.log(JSON.stringify({id:j.id,spans:[{text:j.prompt}],inference_ms:1})),80);
});`);
  return { dir, config: { worker: process.execPath, model: worker, beam: 1, device: 'cpu',
    engineLog: join(dir, 'worker.log'), restartBaseMs: 20, restartMaxMs: 40, restartLimit: 3 } };
}

test('killed worker recovers in-flight and outage audio once for each of eight channels', async () => {
  const f = workerFixture(); const store = new Store(join(f.dir, 'db.sqlite'));
  const engine = new WhisperEngine(f.config); await engine.start();
  const scheduler = new Scheduler(store, engine, config);
  try {
    for (let n = 1; n <= 8; n++) scheduler.start({ stream_id: 'ch' + n, prompt: 'channel ' + n });
    feed(scheduler, 'ch1'); assert.ok(engine.pending); engine.child.kill();
    await until(() => !engine.ready);
    for (let n = 1; n <= 8; n++) feed(scheduler, 'ch' + n);
    assert.ok([...scheduler.channels.values()].every(c => c.queue.every(job => !job.pcm)));
    await until(() => scheduler.metrics.jobs === 9 && !scheduler.busy);
    assert.equal(scheduler.metrics.gaps, 0);
    const segments = store.snapshot([...scheduler.channels.keys()]).segments;
    assert.equal(segments.length, 9);
    assert.equal(new Set(segments.map(s => JSON.stringify([s.session_id, s.timeline_epoch, s.start_ms, s.end_ms]))).size, 9);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM live_recovery_jobs').get().n, 0);
  } finally { await scheduler.close(); store.close(); rmSync(f.dir, { recursive: true }); }
});

test('spawn errors after initial readiness stop at the configured restart bound', async () => {
  const f = workerFixture(); const engine = new WhisperEngine(f.config); await engine.start();
  try {
    engine.config.worker = join(f.dir, 'missing-worker.exe'); engine.child.kill();
    await until(() => engine.restartAttempts === 3 && !engine.restartTimer);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(engine.restartAttempts, 3); assert.equal(engine.ready, false);
  } finally { await engine.stop(); rmSync(f.dir, { recursive: true }); }
});

test('disk queue reopens and skips already committed transcript by session epoch and bounds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-durable-')); const database = join(dir, 'db.sqlite');
  let store = new Store(database); const engine = fakeEngine(); let scheduler = new Scheduler(store, engine, config);
  scheduler.start({ stream_id: 'ch1', prompt: 'saved' }); engine.ready = false; feed(scheduler, 'ch1', 15);
  const c = scheduler.channel('ch1');
  assert.equal(c.queue.length, 3); assert.equal(scheduler.metrics.gaps, 0);
  store.segment({ stream_id: 'ch1', session_id: c.session_id, timeline_epoch: 0, start_ms: 0, end_ms: 5000, raw_text: 'saved' });
  await scheduler.close(); store.close();
  store = new Store(database); store.recover(); scheduler = new Scheduler(store, fakeEngine(), config);
  try {
    await until(() => scheduler.metrics.jobs === 2 && !scheduler.busy);
    assert.equal(store.snapshot(['ch1']).segments.length, 3);
    assert.equal(scheduler.channel('ch1').state, 'stopped');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM live_recovery_jobs').get().n, 0);
  } finally { await scheduler.close(); store.close(); rmSync(dir, { recursive: true }); }
});

test('healthy pool worker remains available while another worker is down', () => {
  const pool = new EnginePool({}, 2);
  pool.engines[1].ready = true;
  assert.equal(pool.ready, true); assert.equal(pool.available, 1);
});

test('two minutes of outage audio exceed the old queue limit without dropping chunks', async () => {
  const store = new Store(':memory:'); const engine = fakeEngine();
  const scheduler = new Scheduler(store, engine, config);
  scheduler.start({ stream_id: 'ch1' }); engine.ready = false;
  try {
    feed(scheduler, 'ch1', 120);
    assert.equal(scheduler.channel('ch1').queue.length, 24);
    assert.equal(scheduler.metrics.gaps, 0);
    assert.equal(store.db.prepare('SELECT sum(length(pcm)) AS bytes FROM live_recovery_jobs').get().bytes, 120 * 32000);
    engine.ready = true;
    await until(() => scheduler.metrics.jobs === 24 && !scheduler.busy);
    assert.equal(store.snapshot(['ch1']).segments.length, 24);
  } finally { await scheduler.close(); store.close(); }
});

test('repeated transport failure is bounded and another channel completes', async () => {
  const store = new Store(':memory:'); const engine = fakeEngine(); let attempts = 0;
  engine.transcribe = async job => {
    if (job.stream_id === 'ch1') { attempts++; throw Object.assign(new Error('transport'), { code: 'ENGINE_UNAVAILABLE' }); }
    return { spans: [{ text: 'other channel' }], inference_ms: 1 };
  };
  const scheduler = new Scheduler(store, engine, { ...config, recoveryRetryMs: 1 });
  try {
    scheduler.start({ stream_id: 'ch1' }); scheduler.start({ stream_id: 'ch2' });
    feed(scheduler, 'ch1'); feed(scheduler, 'ch2');
    await until(() => scheduler.metrics.gaps === 1 && !scheduler.busy);
    assert.equal(attempts, 9); assert.equal(scheduler.metrics.jobs, 1);
    assert.equal(store.snapshot(['ch2']).segments.length, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM live_recovery_jobs').get().n, 0);
  } finally { await scheduler.close(); store.close(); }
});
