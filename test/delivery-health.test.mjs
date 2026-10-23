import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';
import { deliveryHealth, publicationHealth } from '../src/delivery-health.mjs';
import { viewerSnapshot } from '../src/viewer.mjs';
import { reviewRequest } from '../src/review-http.mjs';

function fixture(t) {
  const now = Date.now();
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveStream({ stream_id: 'ch1', name: '시험', page_url: '', prompt: 'PRIVATE_PROMPT' });
  const state = { stream_id: 'ch1', session_id: 'session1', state: 'running', timeline_epoch: 0,
    started_ms: now - 120000, last_receive_ms: now - 1000, last_processed_ms: now - 2000,
    last_processing_result: 'silent', audio_received_until: 10000, audio_processed_until: 10000, queue_length: 0 };
  const scheduler = { config: {}, engine: { ready: true }, states: () => [state], channels: new Map() };
  return { store, scheduler, state, now, config: {}, row: (ready = now - 70000, raw = '회의 발언입니다.', fields = {}) =>
    store.segment({ stream_id: 'ch1', session_id: 'session1', start_ms: 0, end_ms: 5000,
      raw_text: raw, ready_ms: ready, timeline_epoch: 0, ...fields }) };
}

test('fresh processed silence never creates a correction delay; old speech backlog does', t => {
  const f = fixture(t);
  let report = deliveryHealth(f, ['ch1'], { now: f.now, admin: true });
  assert.equal(report.health[0].status, 'silent');
  assert.equal(report.health[0].pending_corrections, 0);
  f.row(f.now - 120000, '감사합니다. 감사합니다.', { speech_activity: { state: 'silence' } });
  report = deliveryHealth(f, ['ch1'], { now: f.now, admin: true });
  assert.equal(report.health[0].status, 'silent');
  const row = f.row();
  report = deliveryHealth(f, ['ch1'], { now: f.now, admin: true });
  assert.equal(report.health[0].status, 'correction_delayed');
  assert.deepEqual(report.health[0].alerts, ['correction']);
  f.store.correct(row.segment_id, { version: row.version, origin: 'ai', text: '교정된 발언입니다.' });
  report = deliveryHealth(f, ['ch1'], { now: f.now });
  assert.equal(report.health[0].status, 'silent');
  assert.ok(report.health[0].last_corrected_ms >= f.now);
});

test('ingestion, engine failure, and recent correction processing have independent stage states', t => {
  const f = fixture(t); f.row(f.now - 5000);
  let report = deliveryHealth(f, ['ch1'], { now: f.now });
  assert.equal(report.health[0].status, 'processing');
  assert.equal(report.health[0].stages.correction, 'processing');
  f.state.last_receive_ms = f.now - 30000;
  f.scheduler.engine.ready = false;
  report = deliveryHealth(f, ['ch1'], { now: f.now, admin: true });
  assert.equal(report.health[0].stage, 'transcription');
  assert.deepEqual(report.health[0].alerts, ['ingestion', 'transcription']);
  f.scheduler.engine.ready = true; f.state.last_receive_ms = f.now;
  report = deliveryHealth(f, ['ch1'], { now: f.now });
  assert.equal(report.health[0].status, 'processing');
  f.state.queue_length = 1; f.state.queue_oldest_ms = 45000;
  assert.equal(deliveryHealth(f, ['ch1'], { now: f.now }).health[0].stage, 'transcription');
});

test('pending reads are bounded and public snapshot and admin diagnostics exclude private content', async t => {
  const f = fixture(t);
  const plan = f.store.db.prepare(`EXPLAIN QUERY PLAN SELECT document FROM segments WHERE session_id=?
    AND json_extract(document,'$.ai_corrected')=0 ORDER BY start_ms LIMIT ?`).all('session1', 257);
  assert.ok(plan.some(row => row.detail.includes('segment_delivery')));
  assert.ok(plan.every(row => !row.detail.includes('SCAN segments')));
  for (let i = 0; i < 300; i++) f.row(f.now - 70000, 'PRIVATE_TRANSCRIPT');
  f.state.error = 'PRIVATE_PATH_CREDENTIAL';
  const report = deliveryHealth(f, ['ch1'], { now: f.now, admin: true });
  assert.equal(report.health[0].pending_corrections, 256);
  assert.equal(report.health[0].pending_count_limited, true);
  const snapshot = viewerSnapshot(f, ['ch1']);
  assert.equal(snapshot.health.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|raw_text|queue_length|pending_corrections/);
  let response;
  const handled = await reviewRequest({ ...f, correctionAI: { settings: () => ({ provider: 'local', model: 'test' }) } },
    { method: 'GET' }, { writeHead() {}, end(value) { response = JSON.parse(value); } },
    new URL('http://local/api/admin/workspace/diagnostics'));
  assert.equal(handled, true);
  assert.equal(response.delivery.health[0].pending_count_limited, true);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|raw_text/);
});

test('publication failure and recovery are derived from actual publisher attempts without network', async t => {
  const f = fixture(t); const registry = new BroadcastRegistry(f.store);
  let broken = true; let sends = 0;
  const publisher = new CloudPublisher({ ...f, registry, minutes: { flush() {} }, now: () => f.now,
    settings: { endpoint: 'https://fixture.vercel.app/api/sync', secret: 'c'.repeat(64), interval_ms: 60000 },
    fetcher: async () => { sends++; if (broken) throw new Error('PRIVATE_CONNECTION'); return { ok: true }; } });
  await publisher.flush();
  assert.equal(sends, 1);
  assert.equal(publicationHealth({ cloudSync: publisher }, f.now).status, 'delayed');
  const delayed = deliveryHealth({ ...f, cloudSync: publisher }, ['ch1'], { now: f.now });
  assert.equal(delayed.health[0].stage, 'publication');
  assert.doesNotMatch(JSON.stringify(delayed), /PRIVATE_|endpoint|secret|error/);
  broken = false; await publisher.flush();
  assert.equal(sends, 2);
  assert.equal(publicationHealth({ cloudSync: publisher }, f.now).status, 'published');
  assert.equal(publicationHealth({ cloudSync: publisher }, f.now + 180001).status, 'delayed');
  await publisher.close();
});

test('health only uses the selected current broadcast session', t => {
  const f = fixture(t); f.row();
  new BroadcastRegistry(f.store);
  f.store.saveStream({ stream_id: 'ch1', name: '새 방송', page_url: '', broadcast_id: 'new-broadcast' });
  const snapshot = viewerSnapshot({ ...f, registry: { forSession: () => 'old-broadcast' } }, ['ch1']);
  assert.equal(snapshot.health[0].status, 'waiting');
  assert.equal(snapshot.health[0].last_received_ms, null);
});
