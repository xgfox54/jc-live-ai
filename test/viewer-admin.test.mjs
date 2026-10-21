import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';
import { toggleSelection } from '../public/selection.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-viewer-'));
  const configPath = join(dir, 'config.json');
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64),
    chunkSeconds: 5, queueChunks: 2, silenceRms: 0, recordAudio: false, maxRecordingBytes: 1000000 };
  writeFileSync(configPath, JSON.stringify(config));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { ready: true, stop: async () => {} }, config);
  const service = createService({ store, scheduler, config, configPath, inputs: { stop: async () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  t.after(async () => { await scheduler.close(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, scheduler, config, configPath, base: 'http://127.0.0.1:' + service.server.address().port };
}
test('selection caps playback at two and permits replacing either selection', () => {
  const available = ['ch1', 'ch2', 'ch3'];
  let result = toggleSelection([], 'ch1', available);
  result = toggleSelection(result.ids, 'ch2', available);
  assert.deepEqual(result.ids, ['ch1', 'ch2']);
  assert.equal(toggleSelection(result.ids, 'ch3', available).limited, true);
  assert.deepEqual(toggleSelection(result.ids, 'ch3', available).ids, result.ids);
  result = toggleSelection(result.ids, 'ch1', available);
  assert.deepEqual(toggleSelection(result.ids, 'ch3', available).ids, ['ch2', 'ch3']);
  assert.deepEqual(toggleSelection([], 'ch8', available).ids, []);
});
test('public viewer excludes admin metadata and rejects writes and foreign origins', async t => {
  const { store, base } = await fixture(t);
  store.saveStream({ stream_id: 'ch1', name: 'Sample', video_id: 'abcdefghijk',
    page_url: 'https://www.youtube.com/watch?v=abcdefghijk', prompt: 'private-prompt',
    approval_note: 'private-approval', resolved_url: 'private-source' });
  store.saveSession({ stream_id: 'ch1', session_id: 's1', state: 'interrupted', error: 'private-path' });
  store.event('gap', { stream_id: 'ch1', reason: 'private-reason', start_ms: 0 });
  const response = await fetch(base + '/api/viewer/snapshot');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Sample/); assert.doesNotMatch(body, /private-/);
  assert.equal((await fetch(base + '/api/viewer/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/viewer/snapshot', { headers: { Origin: 'https://evil.test' } })).status, 403);
  for (const path of ['/api/admin/streams', '/api/admin/settings', '/api/admin/metrics']) {
    assert.equal((await fetch(base + path)).status, 401);
  }
  assert.equal((await fetch(base + '/admin')).status, 200);
});
test('public event feed removes private errors and registration updates reach viewers', async t => {
  const { store, base, config } = await fixture(t);
  const response = await fetch(base + '/api/admin/streams', { method: 'POST',
    headers: { Authorization: 'Bearer ' + config.adminToken },
    body: JSON.stringify({ stream_id: 'ch1', name: 'Registered', kind: 'capture',
      page_url: 'https://www.youtube.com/watch?v=abcdefghijk', approved: true, approval_note: 'private-approval', prompt: 'private-prompt' }) });
  assert.equal(response.status, 201);
  store.event('status', { stream_id: 'ch1', state: 'degraded', error: 'private-error' });
  const abort = new AbortController();
  const stream = await fetch(base + '/api/viewer/events?streams=ch1&after=0', { signal: abort.signal });
  const reader = stream.body.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /의회운영위원회/); assert.match(text, /degraded/); assert.doesNotMatch(text, /private-/);
  await reader.cancel(); abort.abort();
});
test('admin settings persist across repeated saves and reject invalid or busy changes', async t => {
  const { base, config, configPath, scheduler } = await fixture(t);
  const changes = { chunkSeconds: 10, queueChunks: 4, silenceRms: 0.001, recordAudio: true, maxRecordingBytes: 2000000 };
  const save = body => fetch(base + '/api/admin/settings', { method: 'POST',
    headers: { Authorization: 'Bearer ' + config.adminToken }, body: JSON.stringify(body) });
  assert.equal((await save(changes)).status, 200);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).queueChunks, 4);
  assert.equal((await save({ ...changes, queueChunks: 5 })).status, 200);
  assert.equal(config.queueChunks, 5);
  assert.equal((await save({ ...changes, queueChunks: 25 })).status, 400);
  assert.equal((await save({ ...changes, adminToken: 'change' })).status, 400);
  scheduler.busy = true;
  assert.equal((await save(changes)).status, 409);
  scheduler.busy = false;
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).queueChunks, 5);
  assert.equal(config.adminToken, 'a'.repeat(64));
});
test('automatic monitoring controls require admin and manual stop persists disabled state', async t => {
  const { base, config, store } = await fixture(t); config.ytdlp = 'test-only';
  const headers = { Authorization: 'Bearer ' + config.adminToken };
  const path = base + '/api/admin/streams/ch1/auto';
  assert.equal((await fetch(path, { method: 'POST', body: '{"enabled":true}' })).status, 401);
  const registered = await fetch(base + '/api/admin/streams', { method: 'POST', headers,
    body: JSON.stringify({ stream_id: 'ch1', kind: 'youtube', name: 'Auto test', approved: true,
      approval_note: 'test-only', page_url: 'https://www.youtube.com/watch?v=abcdefghijk' }) });
  assert.equal(registered.status, 201); assert.equal(store.streams()[0].auto_start, true);
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{"enabled":"true"}' })).status, 400);
  assert.equal((await fetch(base + '/api/admin/streams/ch1/stop', { method: 'POST', headers })).status, 200);
  assert.equal(store.streams()[0].auto_start, false);
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{"enabled":true}' })).status, 200);
  assert.equal(store.streams()[0].auto_start, true);
  const viewer = await (await fetch(base + '/api/viewer/snapshot')).text();
  assert.doesNotMatch(viewer, /auto_start|monitoring|auto_completed/);
});
