import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerRequest } from '../web/lib/http.mjs';
import { publicSnapshot } from '../web/lib/model.mjs';
import { TranscriptState, TranscriptHistory } from '../public/client-state.mjs';
import { ViewerStage } from '../public/viewer-stage.mjs';
import { publicationHealth } from '../src/delivery-health.mjs';
import { Store } from '../src/store.mjs';
import { createViewer } from '../src/viewer.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const draft = { stream_id: 'ch0', session_id: 'session', segment_id: 'draft', sequence: 1, version: 1,
  timeline_epoch: 0, start_ms: 0, end_ms: 10000, text: '회의를 시작합니다.', ai_corrected: false, display_state: 'draft' };
const manifest = { stream_id: 'ch0', broadcast_id: null, complete: true, segment_ids: [] };
const snapshot = { event_id: 1, streams: [0, 1].map(n => ({ stream_id: 'ch' + n, name: '회의 ' + n, page_url: '' })),
  segments: [0, 1].map(n => ({ ...draft, stream_id: 'ch' + n, segment_id: 'corrected' + n, ai_corrected: true })),
  live_policy: 'whisper-draft-v1', live_segments: [draft], live_pending: [manifest], states: [], gaps: [], before: { ch0: 1, ch1: 2 } };
const storage = { read: async () => ({ value: { kind: 'snapshot', published_ms: 12345, snapshot, minutes_index: [] } }) };

test('selected text channels retain all channel metadata and use conditional responses', async () => {
  const request = (query, headers) => viewerRequest(new Request('https://fixture.vercel.app/api/viewer/snapshot?' + query, { headers }), { storage });
  const empty = await request('text_streams='); const metadata = await empty.json();
  assert.equal(metadata.streams.length, 2); assert.equal(metadata.segments.length, 0); assert.equal(metadata.live_segments.length, 0);
  const selected = await request('text_streams=ch0'); const body = await selected.json();
  assert.equal(body.streams.length, 2); assert.equal(body.segments.length, 1); assert.equal(body.segments[0].stream_id, 'ch0');
  assert.deepEqual(body.live_pending, [manifest]); assert.deepEqual(Object.keys(body.before), ['ch0']);
  assert.ok(selected.headers.get('etag'));
  const same = await request('text_streams=ch0', { 'If-None-Match': selected.headers.get('etag') });
  assert.equal(same.status, 304); assert.equal(await same.text(), '');
  assert.equal((await request('text_streams=ch1', { 'If-None-Match': selected.headers.get('etag') })).status, 200);
  assert.equal((await request('text_streams=ch99')).status, 400);
});

test('complete pending manifests retire missed drafts without losing corrected history or hiding pending drafts', () => {
  const state = new TranscriptState(); const history = new TranscriptHistory();
  state.reset({ ...snapshot, live_pending: [{ ...manifest, segment_ids: ['draft'] }] });
  history.update([draft]);
  state.reset({ ...snapshot, live_segments: [] });
  history.reconcilePending(state.livePending.get('ch0'), null);
  assert.equal(history.items[0].display_state, 'reconciling'); assert.equal(history.items[0].text, '');
  history.update([{ ...draft, version: 2, display_state: 'corrected', ai_corrected: true, text: '보정된 발언입니다.' }]);
  history.reconcilePending(manifest, null); assert.equal(history.items[0].text, '보정된 발언입니다.');
  for (const value of [undefined, { ...manifest, complete: false }, { ...manifest, broadcast_id: 'another' }, { ...manifest, segment_ids: ['draft'] }]) {
    const pending = new TranscriptHistory(); pending.update([draft]); pending.reconcilePending(value, null);
    assert.equal(pending.items[0].display_state, 'draft');
  }
});

test('drafts held on the pending list are not looked up and a missing sentence is looked up twice at most', async () => {
  // Given a draft held for review (still pending) and a sentence that left the pending list, both outside the state window
  const history = new TranscriptHistory();
  history.update([{ ...draft, segment_id: 'held', sequence: 10 }, { ...draft, segment_id: 'gone', sequence: 20 }]);
  history.reconcilePending({ ...manifest, segment_ids: ['held'] }, null);
  const requests = [];
  const stage = Object.assign(Object.create(ViewerStage.prototype), { history, lookups: new Map(), sourceEpoch: 0,
    stream: { stream_id: 'ch0', broadcast_id: null }, render() {},
    options: { state: new TranscriptState(), api: async url => { requests.push(url); return { json: async () => ({ items: [], before: 0 }) }; } } });
  // When the lookup runs three times, each after its 30-second wait
  for (let round = 0; round < 3; round++) { stage.reconcileAfter = 0; await stage.reconcileDrafts(); }
  // Then only the sentence that left the list was looked up, twice, and the held draft stays readable
  assert.deepEqual(requests, ['/api/segments?stream=ch0&limit=200&before=21', '/api/segments?stream=ch0&limit=200&before=21']);
  assert.equal(history.items.find(item => item.segment_id === 'held').display_state, 'draft');
});

test('cloud manifest validation preserves explicit completeness and rejects malformed identifiers', () => {
  assert.deepEqual(publicSnapshot(snapshot).live_pending, [manifest]);
  assert.throws(() => publicSnapshot({ ...snapshot, live_pending: [{ ...manifest, complete: 'yes' }] }));
  assert.throws(() => publicSnapshot({ ...snapshot, live_pending: [{ ...manifest, segment_ids: ['bad/id'] }] }));
  assert.deepEqual(publicSnapshot({ ...snapshot, live_policy: 'unknown' }).live_pending, []);
});

test('archive failures do not mark successful live publication as delayed', () => {
  const now = Date.now(); const view = { enabled: true, phase: 'retry', live_phase: 'published', archive_phase: 'retry', published_ms: now };
  const context = { cloudSync: { view: () => view } };
  assert.equal(publicationHealth(context, now).status, 'published');
  view.live_phase = 'retry'; assert.equal(publicationHealth(context, now).status, 'delayed');
  view.live_phase = 'published'; assert.equal(publicationHealth(context, now + 180001).status, 'delayed');
});

test('local viewer serves selected text with all metadata and conditional responses', async () => {
  const store = new Store(':memory:');
  store.saveStream({ stream_id: 'ch0', name: '회의', page_url: '' });
  const row = store.segment({ session_id: 'session', stream_id: 'ch0', start_ms: 0, end_ms: 1000, raw_text: '회의 발언입니다.' });
  store.correct(row.segment_id, { version: 1, origin: 'ai', text: '회의 발언입니다.' });
  const viewer = createViewer({ store, scheduler: { states: () => [] }, config: {} });
  const server = createServer((req, res) => viewer.handle(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/api/viewer/snapshot?text_streams=';
    const first = await fetch(url); const data = await first.json();
    assert.equal(data.streams.length, 1); assert.equal(data.segments.length, 0);
    assert.equal((await fetch(url, { headers: { 'If-None-Match': first.headers.get('etag') } })).status, 304);
    assert.equal((await (await fetch(url + 'ch0')).json()).segments.length, 1);
  } finally { viewer.feed.close(); await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('the newest page of a record without sentences carries one undrawn start row', async () => {
  const store = new Store(':memory:');
  store.saveStream({ stream_id: 'ch0', name: '회의', page_url: '' });
  const viewer = createViewer({ store, scheduler: { states: () => [] }, config: {} });
  const server = createServer((req, res) => viewer.handle(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const page = async before => (await fetch('http://127.0.0.1:' + server.address().port + '/api/viewer/segments?stream=ch0&limit=2000&before=' + before)).json();
  try {
    // Given no published sentence: the newest page ends the reload of screens loaded before 2026-11-25
    const newest = await page(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(newest.items.map(item => [item.segment_id, item.display_state, item.text, item.sequence]), [['record-start', 'removed', '', 1]]);
    assert.equal(newest.before, 0);
    assert.deepEqual((await page(500)).items, []);
    // When a sentence is published, the page holds that sentence only
    const row = store.segment({ session_id: 'session', stream_id: 'ch0', start_ms: 0, end_ms: 1000, raw_text: '회의 발언입니다.' });
    store.correct(row.segment_id, { version: 1, origin: 'ai', text: '회의 발언입니다.' });
    assert.deepEqual((await page(Number.MAX_SAFE_INTEGER)).items.map(item => item.segment_id), [row.segment_id]);
  } finally { viewer.feed.close(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
