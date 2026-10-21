import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';

async function fixture(t) {
  const store = new Store(':memory:');
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64), chunkSeconds: 5, queueChunks: 2, silenceRms: 0, maxClients: 350 };
  const engine = { ready: true, metadata: {}, stop: async () => {},
    transcribe: async () => ({ spans: [{ text: 'test-only' }], inference_ms: 0 }) };
  const scheduler = new Scheduler(store, engine, config);
  const service = createService({ store, scheduler, config, inputs: { stop: async () => {}, start: () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = 'http://127.0.0.1:' + service.server.address().port;
  t.after(async () => { await scheduler.close(); await service.close(); store.close(); });
  return { store, base, service, config };
}
test('HTTP enforces admin authorization, same origin and safe source registration', async t => {
  // Given
  const { base, config } = await fixture(t);
  const path = base + '/api/admin/streams';
  const body = JSON.stringify({ stream_id: 'ch1', name: 'test', page_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    approved: true, approval_note: 'synthetic test', kind: 'capture' });
  // When
  const denied = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + config.viewerToken }, body });
  const crossOrigin = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + config.adminToken, Origin: 'https://evil.test' }, body });
  const allowed = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + config.adminToken }, body });
  // Then
  assert.equal(denied.status, 401); assert.equal(crossOrigin.status, 403); assert.equal(allowed.status, 201);
});
test('SSE replays events committed between snapshot and subscription', async t => {
  // Given
  const { base, store, config } = await fixture(t);
  const headers = { Authorization: 'Bearer ' + config.adminToken };
  const snapshot = await (await fetch(base + '/api/snapshot?streams=ch1', { headers })).json();
  store.segment({ stream_id: 'ch1', session_id: 's1', start_ms: 0, raw_text: 'after snapshot' });
  // When
  const abort = new AbortController();
  const response = await fetch(base + '/api/events?streams=ch1&after=' + snapshot.event_id, { headers, signal: abort.signal });
  const reader = response.body.getReader(); const chunk = await reader.read();
  // Then
  assert.match(new TextDecoder().decode(chunk.value), /after snapshot/);
  await reader.cancel(); abort.abort();
});
test('old cursors receive bounded reset instead of unbounded replay', async t => {
  // Given
  const { base, store, config } = await fixture(t);
  for (let i = 0; i < 2002; i++) store.event('status', { stream_id: 'ch1', sequence: i });
  // When
  const response = await fetch(base + '/api/events?streams=ch1&after=0', { headers: { Authorization: 'Bearer ' + config.adminToken } });
  const result = await response.text();
  // Then
  assert.match(result, /"kind":"reset"/); assert.ok(result.length < 1000);
});
test('viewer delivery counts exclude internal metrics while cursors still advance', async t => {
  const { base, store, config } = await fixture(t);
  store.event('metric', { stream_id: 'ch1', readiness_ms: 12000 });
  store.event('status', { stream_id: 'ch1', state: 'running' });
  const abort = new AbortController();
  const response = await fetch(base + '/api/viewer/events?streams=ch1&after=0', {
    signal: abort.signal
  });
  const reader = response.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(chunk, /"kind":"metric"/);
  assert.match(chunk, /id: 2/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind<>'metric'").get().count, 1);
  await reader.cancel(); abort.abort();
});
