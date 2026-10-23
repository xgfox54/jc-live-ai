import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { committees, CHANNEL_IDS } from '../public/committees.mjs';
import { initializeCommitteeChannels, matchCommittee } from '../src/committees.mjs';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { BroadcastDiscovery } from '../src/broadcast-discovery.mjs';
import { createService } from '../src/server.mjs';
import { publicSnapshot } from '../web/lib/model.mjs';

const config = { chunkSeconds: 5, queueChunks: 4, silenceRms: 0 };
const engine = () => ({ ready: true, metadata: { fixture: true }, transcribe: async () => ({ spans: [], inference_ms: 0 }), stop: async () => {} });
test('official roster and every bundled photograph match recorded sources', () => {
  const manifest = JSON.parse(readFileSync(new URL('../licenses/committee-members/manifest.json', import.meta.url)));
  assert.equal(committees.length, 12); assert.equal(new Set(CHANNEL_IDS).size, 13); assert.equal(CHANNEL_IDS[0], 'ch0');
  assert.deepEqual(committees.map(c => c.members.length), [11, 7, 6, 6, 6, 6, 6, 7, 15, 12, 9, 9]);
  assert.equal(manifest.images.length, 44);
  for (const c of committees) {
    assert.equal(c.members.filter(m => m.role === '위원장').length, 1);
    assert.equal(new Set(c.members.map(m => m.id)).size, c.members.length);
    assert.match(c.source_url, /^https:\/\/www\.council\.jeju\.kr\//);
    for (const m of c.members) {
      assert.match(m.profile_url, /^https:\/\/www\.council\.jeju\.kr\/member\//);
      const image = manifest.images.find(i => i.photo === m.photo);
      assert.equal(image.source_url, m.photo_source);
      const bytes = readFileSync(new URL('../public' + m.photo, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
    }
  }
});
test('committee detection sends plenary, unknown and ambiguous titles to channel 0 and normalizes 4.3', () => {
  for (const c of committees) assert.equal(matchCommittee({ title: '제455회 제2차 ' + c.name }).stream_id, c.stream_id);
  assert.equal(matchCommittee({ title: '제1차 4.3 특별위원회' }).stream_id, 'ch11');
  assert.equal(matchCommittee({ title: '제455회 본회의' }).stream_id, 'ch0');
  assert.equal(matchCommittee({ title: '행정자치위원회 환경도시위원회' }).stream_id, 'ch0');
  assert.equal(matchCommittee({ committee: '환경도시위원회', title: '공식 방송' }).stream_id, 'ch5');
});
test('bootstrap preserves existing source and history and creates only missing fixed channels', () => {
  const store = new Store(':memory:');
  try {
    store.saveStream({ stream_id: 'ch2', name: 'Existing', kind: 'capture', prompt: 'preserve' });
    initializeCommitteeChannels(store); initializeCommitteeChannels(store);
    assert.equal(store.streams().length, 13);
    assert.equal(store.streams().find(s => s.stream_id === 'ch2').prompt, 'preserve');
    assert.equal(store.streams().find(s => s.stream_id === 'ch0').name, '채널0번');
    assert.equal(store.streams().find(s => s.stream_id === 'ch12').approved, false);
    assert.equal(store.streams().find(s => s.stream_id === 'ch12').auto_start, false);
  } finally { store.close(); }
});
test('discovery uses the correct fixed channel, sends plenary sessions to channel 0 and queues same-channel broadcasts', async () => {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store); const busy = new Set();
  initializeCommitteeChannels(store);
  const discovery = new BroadcastDiscovery({ store, registry, config, monitor: { pending: new Map(), active: id => busy.has(id), invalidate: () => {} } });
  const candidate = (n, title) => ({ title, kind: 'youtube', phase: 'live', page_url: 'https://www.youtube.com/watch?v=' + String(n).padStart(11, '0'),
    video_id: String(n).padStart(11, '0'), sources: [] });
  try {
    const first = registry.upsert(candidate(1, '제1차 규제개혁특별위원회')); discovery.assign();
    assert.equal(store.streams().find(s => s.stream_id === 'ch12').broadcast_id, first.id);
    busy.add('ch12'); const next = registry.upsert(candidate(2, '제2차 규제개혁특별위원회'));
    const unknown = registry.upsert(candidate(3, '제455회 본회의')); discovery.assign();
    assert.equal(store.streams().find(s => s.stream_id === 'ch12').broadcast_id, first.id);
    assert.equal(registry.get(next.id).queued, true);
    const plenary = store.streams().find(s => s.stream_id === 'ch0');
    assert.equal(plenary.broadcast_id, unknown.id); assert.equal(plenary.auto_start, true); assert.equal(plenary.name, '채널0번');
    assert.equal(registry.get(unknown.id).stream_id, 'ch0'); assert.equal(registry.get(unknown.id).queued, false);
    // A second non-committee broadcast waits until channel 0 is free.
    busy.add('ch0'); const other = registry.upsert(candidate(4, '제455회 제3차 본회의')); discovery.assign();
    assert.equal(registry.get(other.id).queued, true); busy.delete('ch0');
    busy.clear(); registry.save({ ...registry.get(first.id), completed: true }); discovery.assign();
    assert.equal(store.streams().find(s => s.stream_id === 'ch12').broadcast_id, next.id);
  } finally { await discovery.close(); store.close(); }
});
test('twelve channels share an eight-input admission limit and release capacity on stop', async () => {
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, engine(), config);
  try {
    for (const id of CHANNEL_IDS.slice(0, 8)) scheduler.start({ stream_id: id });
    assert.throws(() => scheduler.start({ stream_id: 'ch12' }), /최대 8개/);
    scheduler.stop('ch1'); assert.equal(scheduler.start({ stream_id: 'ch12' }).state, 'running');
  } finally { await scheduler.close(); store.close(); }
});
test('public and admin HTTP support ch0 and ch12 while pending channels cannot start', async () => {
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, engine(), config); initializeCommitteeChannels(store);
  const service = createService({ store, scheduler, inputs: { stop: async () => {} }, config: { ...config, adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64) } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); const base = 'http://127.0.0.1:' + service.server.address().port;
  try {
    const snapshot = await (await fetch(base + '/api/viewer/snapshot')).json();
    assert.equal(snapshot.streams.length, 13); assert.equal(publicSnapshot(snapshot).streams.length, 13);
    assert.equal((await fetch(base + '/api/viewer/snapshot?streams=ch12')).status, 200);
    assert.equal((await fetch(base + '/api/viewer/snapshot?streams=ch0')).status, 200);
    assert.equal((await fetch(base + '/api/viewer/snapshot?streams=ch13')).status, 400);
    const response = await fetch(base + committees[11].members[0].photo); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
    const headers = { Authorization: 'Bearer ' + 'a'.repeat(64) };
    assert.equal((await fetch(base + '/api/admin/streams/ch12/start', { method: 'POST', headers })).status, 409);
    assert.equal((await fetch(base + '/api/admin/streams/ch0/start', { method: 'POST', headers })).status, 409);
    assert.equal((await fetch(base + '/api/admin/streams', { headers })).status, 200);
  } finally { await scheduler.close(); await service.close(); store.close(); }
});
