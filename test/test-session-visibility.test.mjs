import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { createViewer, viewerSnapshot } from '../src/viewer.mjs';

function fixture(t, broadcast) {
  const store = new Store(':memory:');
  const registry = new BroadcastRegistry(store);
  store.saveStream({ stream_id: 'ch1', name: '회의', ...(broadcast ? { broadcast_id: broadcast } : {}) });
  const scheduler = { states: () => [], channels: new Map(), config: {} };
  const context = { store, registry, scheduler, config: {} };
  const viewer = createViewer(context);
  t.after(() => { viewer.feed.close(); store.close(); });
  const session = (id, testRun) => {
    const state = { session_id: id, stream_id: 'ch1', state: 'interrupted', ...(testRun ? { test_run: true } : {}) };
    store.saveSession(state);
    if (broadcast) registry.db.prepare('INSERT INTO broadcast_sessions VALUES(?,?)').run(id, broadcast);
    return state;
  };
  const segment = (id, corrected = true) => {
    const row = store.segment({ stream_id: 'ch1', session_id: id, start_ms: 0, end_ms: 5000,
      raw_text: '오늘 회의 안건을 설명하겠습니다.', ready_ms: Date.now() - 120000,
      live_preview: true, preview_updated_ms: Date.now() });
    return corrected ? store.correct(row.segment_id, { version: 1, origin: 'ai', text: '오늘 회의 안건을 설명하겠습니다.' }) : row;
  };
  return { ...context, viewer, session, segment };
}

for (const broadcast of [undefined, 'real-broadcast']) {
  test(`public snapshots exclude test sessions with broadcast ${broadcast ?? 'absent'}`, t => {
    const f = fixture(t, broadcast);
    f.session('actual'); const actual = f.segment('actual');
    const state = f.session('test-only', true); f.segment('test-only'); f.segment('test-only', false);
    f.store.event('gap', { stream_id: 'ch1', session_id: 'test-only', start_ms: 0 });
    f.scheduler.states = () => [{ ...state, test_run: undefined }];
    const result = viewerSnapshot(f, ['ch1']);
    assert.deepEqual(result.segments.map(row => row.segment_id), [actual.segment_id]);
    assert.deepEqual(result.live_segments.map(row => row.segment_id), [actual.segment_id]);
    assert.deepEqual(result.states, []);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.health[0].status, 'waiting');
    assert.equal(result.health[0].stages.correction, 'waiting');
    assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM segments').get().total, 3);
  });
}

test('test session backlog never causes public correction delay', t => {
  const f = fixture(t); f.session('test-only', true); f.segment('test-only', false);
  assert.equal(viewerSnapshot(f, ['ch1']).health[0].status, 'waiting');
});

test('broadcast test flag excludes unflagged sessions before public limits and health reads', async t => {
  const f = fixture(t); f.session('actual'); const actual = f.segment('actual');
  f.registry.save({ id: 'test-broadcast', test_run: true });
  f.session('test-only');
  f.registry.db.prepare('INSERT INTO broadcast_sessions VALUES(?,?)').run('test-only', 'test-broadcast');
  for (let i = 0; i < 10001; i++) f.segment('test-only', false);
  f.segment('test-only');
  const draft = f.segment('actual', false);
  f.store.event('gap', { stream_id: 'ch1', session_id: 'test-only', start_ms: 0 });
  assert.equal(f.store.states()[0].test_run, undefined);
  const snapshot = viewerSnapshot(f, ['ch1']);
  assert.equal(snapshot.health[0].status, 'waiting');
  assert.deepEqual(snapshot.states, []); assert.deepEqual(snapshot.gaps, []);
  assert.deepEqual(snapshot.segments.map(row => row.segment_id), [actual.segment_id]);
  assert.deepEqual(new Set(snapshot.live_segments.map(row => row.segment_id)), new Set([actual.segment_id, draft.segment_id]));
  assert.deepEqual(snapshot.live_pending, [{ stream_id: 'ch1', broadcast_id: null, complete: true, segment_ids: [draft.segment_id] }]);
  const visible = f.store.events(0, 30000).map(event => f.viewer.feed.project(event)).filter(Boolean);
  assert.equal(visible.some(event => event.payload.session_id === 'test-only'), false);
  let body;
  f.viewer.handle({ method: 'GET' }, { writeHead() {}, end(text) { body = JSON.parse(text); } },
    new URL('http://localhost/api/viewer/segments?stream=ch1'));
  assert.deepEqual(body.items.map(row => row.segment_id), [actual.segment_id]);
});

test('public snapshot works without broadcast registry tables', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveStream({ stream_id: 'ch1' });
  store.saveSession({ stream_id: 'ch1', session_id: 'actual', state: 'interrupted' });
  const row = store.segment({ stream_id: 'ch1', session_id: 'actual', start_ms: 0, end_ms: 5000,
    raw_text: '오늘 회의 안건을 설명하겠습니다.', live_preview: true });
  const snapshot = viewerSnapshot({ store, scheduler: { states: () => [] } }, ['ch1']);
  assert.deepEqual(snapshot.live_pending[0].segment_ids, [row.segment_id]);
  assert.equal(snapshot.states[0].session_id, 'actual');
});

test('pending manifest includes drafts beyond the live window and excludes corrected and test rows', t => {
  const f = fixture(t, 'broadcast'); f.session('actual');
  const drafts = Array.from({ length: 202 }, () => f.segment('actual', false));
  f.segment('actual'); f.session('test-only', true); f.segment('test-only', false);
  const snapshot = viewerSnapshot(f, ['ch1']);
  assert.equal(snapshot.live_segments.length, 200);
  assert.deepEqual(snapshot.live_pending, [{ stream_id: 'ch1', broadcast_id: 'broadcast', complete: true,
    segment_ids: drafts.map(row => row.segment_id) }]);
});

test('pending manifest marks a truncated channel incomplete', t => {
  const f = fixture(t); f.session('actual');
  for (let i = 0; i < 10001; i++) f.segment('actual', false);
  const [pending] = viewerSnapshot(f, ['ch1']).live_pending;
  assert.equal(pending.complete, false);
  assert.equal(pending.broadcast_id, null);
  assert.equal(pending.segment_ids.length, 10000);
});

test('public event projection excludes persisted test sessions and preserves real events', t => {
  const f = fixture(t); f.session('actual'); f.segment('actual');
  f.session('test-only', true); f.segment('test-only');
  for (const kind of ['status', 'gap']) {
    f.store.event(kind, { session_id: 'test-only', stream_id: 'ch1', state: 'interrupted', start_ms: 0 });
    f.store.event(kind, { session_id: 'actual', stream_id: 'ch1', state: 'interrupted', start_ms: 0 });
  }
  const visible = f.store.events(0).map(event => f.viewer.feed.project(event)).filter(Boolean);
  assert.equal(visible.some(event => event.payload.session_id === 'test-only'), false);
  assert.deepEqual(new Set(visible.map(event => event.kind)), new Set(['session', 'live-segment', 'status', 'gap']));
});

test('HTTP history and snapshot reach actual speech behind full pages of test sessions', async t => {
  const f = fixture(t); f.session('actual'); const actual = f.segment('actual');
  f.session('test-only', true); for (let i = 0; i < 210; i++) f.segment('test-only');
  const server = createServer((req, res) => f.viewer.handle(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/viewer/segments?stream=ch1&limit=2', '/api/viewer/snapshot?streams=ch1']) {
    const response = await fetch(base + path); assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual((body.items ?? body.segments).map(row => row.segment_id), [actual.segment_id]);
    if (body.live_segments) assert.deepEqual(body.live_segments.map(row => row.segment_id), [actual.segment_id]);
    assert.doesNotMatch(JSON.stringify(body), /test-only/);
  }
});
