import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';
import { viewerRequest } from '../web/lib/http.mjs';
import { publicSnapshot } from '../web/lib/model.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-published-'));
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64), chunkSeconds: 5, queueChunks: 4, silenceRms: 0, minutesDirectory: join(dir, 'minutes') };
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, { ready: true, stop: async () => {} }, config);
  const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
  const stream = { stream_id: 'ch1', name: '공개 정책 시험', page_url: '', kind: 'capture', approved: true };
  store.saveStream(stream); const state = scheduler.start(stream); const id = service.minutes.attach(stream, state);
  const add = text => store.segment({ stream_id: 'ch1', session_id: state.session_id, start_ms: 0, end_ms: 5000, raw_text: text });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  t.after(async () => { await scheduler.close(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, scheduler, service, config, state, id, add, base: 'http://127.0.0.1:' + service.server.address().port };
}
test('public snapshot and search require AI provenance, never fall back to raw, and paginate past pending rows', async t => {
  const f = await fixture(t); const approved = f.add('RAW_SECRET_APPROVED');
  f.store.correct(approved.segment_id, { version: 1, origin: 'ai', text: 'AI 공개 문장' });
  f.store.correct(approved.segment_id, { version: 2, text: 'AI 공개 문장 담당자 확인' });
  const manual = f.add('RAW_SECRET_MANUAL'); f.store.correct(manual.segment_id, { version: 1, text: 'MANUAL_SECRET' });
  for (let i = 0; i < 130; i++) f.add('RAW_SECRET_PENDING ' + i);
  const active = f.scheduler.channel('ch1'); active.partial = { raw_text: 'RAW_SECRET_PARTIAL', start_ms: 0, end_ms: 5000 }; f.scheduler.save(active);
  const snapshot = await (await fetch(f.base + '/api/viewer/snapshot')).json();
  assert.equal(snapshot.segments.length, 1); assert.equal(snapshot.segments[0].text, 'AI 공개 문장 담당자 확인');
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW_SECRET|MANUAL_SECRET|raw_text|corrected_text/);
  const rawSearch = await (await fetch(f.base + '/api/viewer/segments?stream=ch1&q=RAW_SECRET')).json(); assert.equal(rawSearch.items.length, 0);
  const page = await (await fetch(f.base + '/api/viewer/segments?stream=ch1&q=' + encodeURIComponent('담당자'))).json(); assert.equal(page.items.length, 1);
  for (const path of ['/api/snapshot', '/api/segments?stream=ch1', '/api/events', '/api/streams'])
    assert.equal((await fetch(f.base + path, { headers: { Authorization: 'Bearer ' + f.config.viewerToken } })).status, 401);
  const admin = await (await fetch(f.base + '/api/snapshot', { headers: { Authorization: 'Bearer ' + f.config.adminToken } })).text();
  assert.match(admin, /RAW_SECRET_PENDING/); assert.match(JSON.stringify(f.store.segments({ stream: 'ch1' })), /RAW_SECRET/);
});
test('public SSE suppresses raw and partial events but delivers AI application and subsequent human review', async t => {
  const f = await fixture(t); const row = f.add('RAW_SECRET_EVENT');
  f.store.event('partial', { stream_id: 'ch1', session_id: f.state.session_id, raw_text: 'RAW_SECRET_PARTIAL' });
  f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '공개 후보정' });
  f.store.correct(row.segment_id, { version: 2, text: '공개 후속 검토' });
  const last = f.store.event('stream', { stream_id: 'ch1', name: 'END_OF_PUBLIC_TEST' });
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 3000);
  const response = await fetch(f.base + '/api/viewer/events?streams=ch1&after=0', { signal: abort.signal }); const reader = response.body.getReader(); let wire = '';
  try { while (!wire.includes('END_OF_PUBLIC_TEST')) wire += new TextDecoder().decode((await reader.read()).value); }
  finally { clearTimeout(timer); await reader.cancel(); abort.abort(); }
  assert.match(wire, /공개 후보정/); assert.match(wire, /공개 후속 검토/); assert.match(wire, new RegExp('id: ' + last.event_id));
  assert.doesNotMatch(wire, /RAW_SECRET|raw_text|corrected_text|"kind":"partial"/);
});
test('live SSE replaces an opted-in draft while archive endpoints stay corrected-only', async t => {
  const f = await fixture(t);
  const row = f.store.segment({ stream_id: 'ch1', session_id: f.state.session_id, start_ms: 0, end_ms: 5000,
    raw_text: '신규 일차 받아쓰기입니다.', live_preview: true, preview_updated_ms: Date.now() });
  const snapshot = await (await fetch(f.base + '/api/viewer/snapshot?streams=ch1')).json();
  assert.equal(snapshot.live_segments[0].display_state, 'draft'); assert.equal(snapshot.segments.length, 0);
  // The record page holds no sentence yet: only the undrawn start row, never the draft.
  assert.deepEqual((await (await fetch(f.base + '/api/viewer/segments?stream=ch1')).json()).items.map(item => [item.segment_id, item.text]), [['record-start', '']]);
  f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '후보정을 마친 문장입니다.' });
  f.store.event('stream', { stream_id: 'ch1', name: 'END_LIVE_PREVIEW' });
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 3000);
  const response = await fetch(f.base + '/api/viewer/events?streams=ch1&after=0', { signal: abort.signal });
  const reader = response.body.getReader(); let wire = '';
  try { while (!wire.includes('END_LIVE_PREVIEW')) wire += new TextDecoder().decode((await reader.read()).value); }
  finally { clearTimeout(timer); await reader.cancel(); abort.abort(); }
  assert.match(wire, /"kind":"live-segment"/); assert.match(wire, /"display_state":"draft"/);
  assert.match(wire, /"display_state":"corrected"/); assert.doesNotMatch(wire, /raw_text|live_preview|preview_updated_ms/);
  const updated = await (await fetch(f.base + '/api/viewer/snapshot?streams=ch1')).json();
  assert.equal(updated.live_segments[0].segment_id, row.segment_id);
  assert.equal(updated.live_segments[0].text, '후보정을 마친 문장입니다.'); assert.doesNotMatch(JSON.stringify(updated), /신규 일차/);
});
test('public minutes and exports rebuild from AI-corrected rows and exclude manual or stale raw-based bodies', async t => {
  const f = await fixture(t); f.add('RAW_SECRET_MINUTES'); const row = f.add('RAW_SECRET_AI_SOURCE');
  f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: 'AI 후보정 완료 발언과 예산 검토를 보고합니다.' });
  f.service.minutes.flush(); f.service.review.edit(f.id, { version: 0, markdown: '# RAW_SECRET_MANUAL_BODY' });
  for (const extension of ['', '.json', '.md']) {
    const response = await fetch(f.base + '/api/viewer/minutes/' + f.id + extension); const body = await response.text();
    assert.equal(response.status, 200); assert.match(body, /AI 후보정 완료/); assert.doesNotMatch(body, /RAW_SECRET/);
  }
  const list = await (await fetch(f.base + '/api/viewer/minutes')).json(); assert.equal(list.items[0].segment_count, 1);
  assert.match(f.service.registry.minutes(f.id).markdown, /RAW_SECRET_MANUAL_BODY/);
});
test('existing cloud snapshots and cached minutes cannot expose legacy raw text after the reader is upgraded', async () => {
  const id = 'a'.repeat(64); const raw = 'RAW_SECRET_LEGACY';
  const snapshot = { event_id: 1, streams: [{ stream_id: 'ch1', name: '시험', page_url: '', broadcast_id: id }],
    segments: [{ stream_id: 'ch1', raw_text: raw, corrected_text: 'unproven manual' }], states: [], gaps: [], before: {} };
  assert.equal(publicSnapshot(snapshot).segments.length, 0);
  const document = { id, title: '시험', status: 'draft', updated_ms: 1, segment_count: 1, session_count: 0,
    sources: [], discussion: [{ text: raw }], decision_quotes: [], action_quotes: [], transcript: [{ text: raw }], gaps: [], warnings: [], markdown: raw };
  const rows = new Map([['site.json', { kind: 'snapshot', published_ms: 1, snapshot, minutes_index: [document] }],
    ['minutes/' + id + '.json', { kind: 'minutes', published_ms: 1, document, segments: snapshot.segments }]]);
  const storage = { read: async path => ({ value: rows.get(path) }) };
  for (const route of ['snapshot', 'segments?stream=ch1', 'minutes/' + id, 'minutes/' + id + '.json', 'minutes/' + id + '.md']) {
    const response = await viewerRequest(new Request('https://fixture.vercel.app/api/viewer/' + route), { storage });
    assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /RAW_SECRET|unproven manual|raw_text/);
  }
});
test('legacy AI correction history restores provenance without modifying original text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-ai-history-')); const path = join(dir, 'db.sqlite'); let store = new Store(path);
  try {
    const row = store.segment({ stream_id: 'ch1', session_id: 's1', start_ms: 0, end_ms: 1, raw_text: '원문 보존' });
    store.correct(row.segment_id, { version: 1, origin: 'ai', text: 'AI 후보정' });
    store.db.exec("UPDATE segments SET document=json_remove(document,'$.ai_corrected'); UPDATE events SET payload=json_remove(payload,'$.ai_corrected'); PRAGMA user_version=0;");
    store.close(); store = new Store(path); const recovered = store.segments({ stream: 'ch1' }).items[0];
    assert.equal(recovered.ai_corrected, true); assert.equal(recovered.raw_text, '원문 보존'); assert.equal(recovered.version, 2);
    const events = store.events(0).filter(e => e.kind === 'segment'); assert.equal(events[0].payload.ai_corrected, undefined); assert.equal(events[1].payload.ai_corrected, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
