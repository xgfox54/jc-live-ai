import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { BroadcastDiscovery } from '../src/broadcast-discovery.mjs';
import { BroadcastMonitor } from '../src/broadcast-monitor.mjs';
import { MinutesService } from '../src/minutes.mjs';
import { CHANNEL, parseCouncilDirectory, councilMetadata, parseYouTubeDirectory } from '../src/official-directory.mjs';
import { parseCouncilPlayer } from '../src/council.mjs';
import { createService } from '../src/server.mjs';
import { committees } from '../public/committees.mjs';

const candidate = (n, phase = 'live') => { const video_id = String(n).padStart(11, '0'); const page_url = 'https://www.youtube.com/watch?v=' + video_id;
  return { video_id, page_url, title: 'Fixture meeting ' + n, committee: committees[(n - 1) % 8].name, kind: 'youtube', phase, sources: [page_url], discovered_from: 'youtube' }; };
const fakeEngine = () => ({ ready: true, metadata: { test_only: true }, stop: async () => {},
  transcribe: async () => ({ spans: [{ text: '사업 계획을 검토했습니다. 해당 안건은 가결되었음을 선포합니다. 자료 제출을 요청합니다.' }], inference_ms: 0 }) });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-discovery-'));
  const config = { chunkSeconds: 5, queueChunks: 4, silenceRms: 0, minutesDirectory: join(dir, 'minutes') };
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store); const scheduler = new Scheduler(store, fakeEngine(), config);
  const minutes = new MinutesService({ store, registry, config }); const active = new Map(); const sources = [];
  const inputs = { isActive: id => active.has(id), startYouTube(source) {
    sources.push(source); return new Promise(resolve => active.set(source.stream_id, () => { active.delete(source.stream_id); scheduler.stop(source.stream_id); resolve(); }));
  }, async stop(id) { active.get(id)?.(); await immediate(); } };
  let phase = 'live'; let items = []; let now = 100000;
  const monitor = new BroadcastMonitor({ store, registry, scheduler, minutes, inputs, config, now: () => now,
    probe: async source => ({ source, phase, key: 'youtube:' + source.video_id }) });
  const discovery = new BroadcastDiscovery({ store, registry, monitor, config, scanSources: async () => items });
  t.after(async () => { await discovery.close(); await monitor.close(); for (const id of active.keys()) await inputs.stop(id);
    await scheduler.close(); minutes.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, registry, scheduler, minutes, inputs, monitor, discovery, sources,
    items: value => { items = value; }, phase: value => { phase = value; now += 300000; } };
}
test('official directory accepts live and scheduled detail links while excluding archives, ended broadcasts and foreign hosts', () => {
  const html = '<html><body><h1>오늘의 생방송</h1>'
    + '<p><a href="/broadcast/schedule.do?act=view&amp;seq=1">제1차 위원회</a><i>방송중</i></p>'
    + '<p><a href="/broadcast/schedule.do?act=view&seq=1">중복</a><i>방송중</i></p>'
    + '<p><a href="/broadcast/schedule.do?act=view&seq=2">제2차 위원회</a>방송예정</p>'
    + '<p><a href="/broadcast/schedule.do?act=view&seq=3">종료</a>방송종료</p>'
    + '<p><a href="/broadcast/broad.do?act=view&seq=4">다시보기</a></p>'
    + '<p><a href="https://evil.test/broadcast/schedule.do?act=view&seq=5">외부</a></p>'
    + '<!-- <p><a href="/broadcast/schedule.do?act=view&seq=6">주석</a></p> --></body></html>';
  const items = parseCouncilDirectory(html); assert.equal(items.length, 2); assert.deepEqual(items.map(item => item.phase), ['live', 'waiting']);
  assert.deepEqual(parseCouncilDirectory(html.replaceAll('<i>방송중</i></p>', '<i>정회중</i></p>')).map(item => item.recess), [true, false]);
  assert.throws(() => parseCouncilDirectory('<html>blocked</html>'));
});
test('official metadata preserves published agenda and ignores inactive players', () => {
  const html = '<li><b>일시 : </b>2026-10-20 10:00</li><li><b>소관 : </b>행정자치위원회</li>'
    + '<li><b>심의안건</b><br><div>1. 사업 계획<br>2. 예산안<script>ignore()</script></div></li>'
    + '<!-- <iframe src="https://www.youtube.com/embed/00000000002"></iframe> -->'
    + '<iframe src="https://www.youtube.com/embed/00000000001"></iframe>';
  assert.equal(councilMetadata(html).committee, '행정자치위원회');
  assert.equal(councilMetadata(html).scheduled_at, '2026-10-20 10:00');
  assert.equal(councilMetadata(html).agenda, '1. 사업 계획\n2. 예산안');
  assert.equal(parseCouncilPlayer(html).video_id, '00000000001');
});
test('YouTube discovery is restricted to the official channel and live or upcoming entries', () => {
  const data = { id: CHANNEL, entries: [{ id: '00000000001', live_status: 'is_live' },
    { id: '00000000002', live_status: 'is_upcoming' }, { id: '00000000003', live_status: 'was_live' },
    { id: '00000000004', live_status: 'not_live' }] };
  assert.equal(parseYouTubeDirectory(data).length, 2);
  assert.throws(() => parseYouTubeDirectory({ ...data, id: 'foreign' }));
  assert.throws(() => parseYouTubeDirectory({ ...data, entries: [{ ...data.entries[0], channel_id: 'foreign' }] }));
});
test('one broadcast on both sources shares its identity and preserves council metadata', t => {
  const f = fixture(t); const yt = candidate(1); const first = f.registry.upsert(yt);
  const page_url = 'https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=1';
  const combined = f.registry.upsert({ ...yt, page_url, sources: [page_url], discovered_from: 'council', kind: 'council',
    resolved_kind: 'youtube', title: '공식 회의명', agenda: '공식 안건' });
  f.registry.upsert(yt);
  assert.equal(first.id, combined.id); assert.equal(f.registry.list().length, 1);
  assert.equal(f.registry.get(first.id).page_url, page_url); assert.equal(f.registry.get(first.id).title, '공식 회의명');
});
test('discovery queues excess broadcasts and never replaces an active or manual slot', async t => {
  const f = fixture(t); f.items(Array.from({ length: 9 }, (_, i) => candidate(i + 1)));
  await f.discovery.scan(); assert.equal(f.store.streams().length, 8); assert.equal(f.registry.list().filter(item => item.queued).length, 1);
  await f.monitor.tick(); assert.equal(f.sources.length, 8);
  f.items([candidate(10)]); await f.discovery.scan(); assert.equal(f.sources.length, 8);
  assert.equal(f.registry.list().filter(item => item.queued).length, 2);
});
test('live discovery can replace an inactive automatic scheduled slot while keeping that schedule queued', async t => {
  const f = fixture(t); f.items(Array.from({ length: 8 }, (_, i) => candidate(i + 1, 'waiting'))); await f.discovery.scan();
  const old = f.store.streams()[0].broadcast_id;
  f.items([candidate(9)]); await f.discovery.scan();
  assert.ok(f.store.streams().some(item => item.video_id === candidate(9).video_id));
  assert.equal(f.registry.get(old).queued, true);
});
test('a finished meeting keeps its channel when a new broadcast takes the slot', async t => {
  const f = fixture(t); f.items([candidate(1)]); await f.discovery.scan();
  const slot = f.store.streams()[0]; const old = slot.broadcast_id;
  f.registry.save({ ...f.registry.get(old), phase: 'ended', completed: false });
  f.items([candidate(9)]); await f.discovery.scan();
  assert.notEqual(f.store.streams().find(item => item.stream_id === slot.stream_id).broadcast_id, old);
  assert.equal(f.registry.get(old).stream_id, slot.stream_id); assert.notEqual(f.registry.get(old).queued, true);
});
test('a manual address with detection turned off yields its committee channel to a new official broadcast', async t => {
  const f = fixture(t); const manual = 'x'.repeat(11);
  f.store.saveStream({ stream_id: 'ch1', name: committees[0].name, committee_id: committees[0].id, kind: 'youtube', video_id: manual,
    page_url: 'https://www.youtube.com/watch?v=' + manual, approved: true, approval_note: 'test', prompt: '', auto_start: true });
  f.items([candidate(1)]); await f.discovery.scan();
  const waiting = f.registry.list().find(item => item.video_id === candidate(1).video_id);
  assert.equal(waiting.queued, true); assert.equal(f.store.streams()[0].video_id, manual);
  f.store.saveStream({ ...f.store.streams()[0], auto_start: false }); await f.discovery.scan();
  const slot = f.store.streams().find(item => item.stream_id === 'ch1');
  assert.equal(slot.broadcast_id, waiting.id); assert.equal(slot.capture_from_start, true); assert.equal(slot.auto_discovered, true);
  assert.equal(f.registry.get(waiting.id).queued, false); assert.equal(f.registry.get(waiting.id).stream_id, 'ch1');
});
test('disabling discovery rejects late scans and the setting persists in SQLite', async t => {
  const f = fixture(t); let finish; f.discovery.scanSources = () => new Promise(resolve => { finish = resolve; });
  const pending = f.discovery.scan(); f.discovery.setEnabled(false); finish([candidate(1)]); await pending;
  assert.equal(f.store.streams().length, 0); assert.equal(new BroadcastRegistry(f.store).settings().enabled, false);
});
test('discovered broadcast records once, drains to minutes, applies corrections and retains history after slot reuse', async t => {
  const f = fixture(t); f.items([candidate(1), candidate(1)]); await f.discovery.scan(); await f.discovery.scan();
  await f.monitor.tick(); assert.equal(f.sources.length, 1); assert.equal(f.sources[0].capture_from_start, true); assert.equal(f.sources[0].auto_record, true);
  const stream = f.store.streams()[0]; const state = f.scheduler.channel(stream.stream_id);
  for (let seq = 0; seq < 6; seq++) f.scheduler.feed(stream.stream_id, { session_id: state.session_id, epoch: 0, seq, pcm: Buffer.alloc(32000, 1) });
  await f.inputs.stop(stream.stream_id); while (f.scheduler.busy) await immediate(); await immediate(); f.minutes.flush();
  const first = f.registry.minutes(stream.broadcast_id);
  assert.equal(first.status, 'draft'); assert.equal(first.segment_count, 2); assert.ok(first.paragraphs.length >= 1); assert.equal(first.decision_quotes, undefined);
  assert.equal(f.registry.get(stream.broadcast_id).completed, true);
  assert.match(readFileSync(join(f.dir, 'minutes', stream.broadcast_id + '.md'), 'utf8'), /## 1장 회의록[^]*## 핵심 내용 요약[^]*## 전체 회의 받아쓰기 기록/);
  const segment = f.registry.segments(stream.broadcast_id)[0]; f.store.correct(segment.segment_id, { version: 1, text: '검토자가 수정한 발언입니다.' });
  f.minutes.flush(); assert.equal(f.registry.minutes(stream.broadcast_id).transcript[0].text, '검토자가 수정한 발언입니다.');
  f.items([candidate(9)]); await f.discovery.scan(); await f.monitor.tick();
  assert.equal(f.store.streams()[0].stream_id, stream.stream_id); assert.notEqual(f.store.streams()[0].broadcast_id, stream.broadcast_id);
  assert.equal(f.registry.minutes(stream.broadcast_id).segment_count, 2); assert.equal(f.registry.minuteList()[0].transcript, undefined);
});
test('ending a from-start broadcast does not cut off buffered audio and manual pause survives rediscovery', async t => {
  const f = fixture(t); f.items([candidate(1)]); await f.discovery.scan(); await f.monitor.tick();
  f.phase('ended'); await f.monitor.tick(); assert.equal(f.scheduler.channel('ch1').state, 'running');
  const stream = f.store.streams()[0]; f.monitor.setEnabled(stream, false); await f.inputs.stop('ch1'); await f.discovery.scan();
  assert.equal(f.store.streams()[0].auto_start, false); assert.equal(f.registry.get(stream.broadcast_id).suspended, true);
});
test('minutes include all transcript rows, session boundaries, restart gaps and persist after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-minutes-')); const database = join(dir, 'db.sqlite');
  const config = { minutesDirectory: join(dir, 'minutes') }; let store = new Store(database); let registry = new BroadcastRegistry(store);
  const record = registry.upsert(candidate(1)); registry.attach({ ...candidate(1), stream_id: 'ch1', broadcast_id: record.id }, { session_id: 's1' });
  store.saveSession({ session_id: 's1', stream_id: 'ch1', state: 'running' });
  for (let i = 0; i < 130; i++) store.segment({ session_id: 's1', stream_id: 'ch1', timeline_epoch: i < 100 ? 0 : 1,
    start_ms: i * 5000, end_ms: (i + 1) * 5000, raw_text: '시험 발언 ' + i });
  store.close(); store = new Store(database); store.recover(); registry = new BroadcastRegistry(store);
  const minutes = new MinutesService({ store, registry, config }); minutes.flush();
  const saved = registry.minutes(record.id); assert.equal(saved.segment_count, 130); assert.equal(saved.gaps[0].reason, 'process_restart');
  assert.ok(saved.warnings.some(text => /재시작/.test(text))); assert.equal(saved.transcript.at(-1).epoch, 1);
  minutes.close(); store.close(); store = new Store(database); registry = new BroadcastRegistry(store);
  assert.equal(registry.minutes(record.id).segment_count, 130); store.close(); rmSync(dir, { recursive: true, force: true });
});
test('discovery controls require admin while published minutes exports remain read-only and omit private state', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-minutes-http-')); const store = new Store(':memory:');
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64), chunkSeconds: 5, queueChunks: 4, silenceRms: 0, minutesDirectory: join(dir, 'minutes') };
  const scheduler = new Scheduler(store, fakeEngine(), config); const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); const base = 'http://127.0.0.1:' + service.server.address().port;
  t.after(async () => { await scheduler.close(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await fetch(base + '/api/admin/discovery')).status, 401);
  const headers = { Authorization: 'Bearer ' + config.adminToken };
  assert.equal((await fetch(base + '/api/admin/discovery', { method: 'POST', headers, body: '{"enabled":"true"}' })).status, 400);
  assert.equal((await fetch(base + '/api/admin/discovery', { method: 'POST', headers, body: '{"enabled":false}' })).status, 200);
  const record = service.registry.upsert(candidate(1));
  const stream = { ...candidate(1), stream_id: 'ch1', broadcast_id: record.id, prompt: 'private-prompt', approval_note: 'private-note' };
  const state = scheduler.start(stream); service.minutes.attach(stream, state);
  store.segment({ stream_id: 'ch1', session_id: state.session_id, start_ms: 0, end_ms: 5000, raw_text: '<script>alert(1)</script> 시험 발언' });
  store.event('gap', { stream_id: 'ch1', session_id: state.session_id, reason: 'source_resolution_failed', error: 'private-path' }); service.minutes.flush();
  const response = await fetch(base + '/api/viewer/minutes/' + record.id + '.json'); const document = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/); assert.doesNotMatch(document, /private-|adminToken|viewerToken/);
  assert.equal((await fetch(base + '/api/viewer/minutes/' + record.id + '.md')).status, 200);
  assert.equal((await fetch(base + '/api/viewer/minutes/' + record.id, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/viewer/minutes', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(base + '/minutes')).status, 200);
  store.saveStream(stream); scheduler.stop('ch1');
  const replacementRecord = service.registry.upsert(candidate(2));
  const replacement = { ...candidate(2), stream_id: 'ch1', name: 'Replacement broadcast', broadcast_id: replacementRecord.id };
  store.saveStream(replacement); const replacementState = scheduler.start(replacement);
  service.minutes.attach(replacement, replacementState);
  const currentRow = store.segment({ stream_id: 'ch1', session_id: replacementState.session_id, start_ms: 0, end_ms: 5000, raw_text: 'current private raw' });
  store.correct(currentRow.segment_id, { version: 1, origin: 'ai', text: 'current broadcast only' });
  const snapshot = await (await fetch(base + '/api/viewer/snapshot')).json();
  assert.equal(snapshot.segments.length, 1); assert.equal(snapshot.segments[0].text, 'current broadcast only');
  assert.equal(snapshot.gaps.length, 0);
  const history = await (await fetch(base + '/api/viewer/segments?stream=ch1')).json();
  assert.equal(history.items.length, 1); assert.equal(history.items[0].text, 'current broadcast only');
});
test('late council player identity merges earlier page and channel records with their sessions', async t => {
  const f = fixture(t);
  const page_url = 'https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=9';
  const page = f.registry.upsert({ page_url, title: 'Official pending page', sources: [page_url], kind: 'council', phase: 'waiting' });
  f.registry.attach({ stream_id: 'ch1', broadcast_id: page.id }, { session_id: 'page-session' });
  const youtube = f.registry.upsert(candidate(9));
  f.registry.attach({ stream_id: 'ch2', broadcast_id: youtube.id }, { session_id: 'youtube-session' });
  f.store.saveStream({ stream_id: 'ch1', kind: 'council', page_url, broadcast_id: page.id, auto_discovered: true });
  f.store.saveStream({ stream_id: 'ch2', ...candidate(9), broadcast_id: youtube.id, auto_discovered: true });
  const merged = f.registry.upsert({ ...candidate(9), kind: 'council', page_url, sources: [page_url], resolved_kind: 'youtube', title: 'Resolved official meeting' });
  f.discovery.assign();
  assert.equal(f.registry.list().length, 1); assert.equal(f.registry.forSession('page-session'), merged.id);
  assert.equal(f.registry.forSession('youtube-session'), merged.id); assert.equal(f.store.streams().length, 1);
});
test('eight reserved manual slots remain intact and new official broadcasts wait', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 8; i++) f.store.saveStream({ stream_id: 'ch' + i, kind: 'capture', name: 'Manual ' + i, approved: true });
  f.items([candidate(1)]); await f.discovery.scan();
  assert.ok(f.store.streams().every(item => item.kind === 'capture')); assert.equal(f.registry.list()[0].queued, true);
});
test('failed beginning collection records its gap and retries using the live edge', async t => {
  const f = fixture(t); f.items([candidate(1)]); await f.discovery.scan(); await f.monitor.tick();
  const state = f.scheduler.channel('ch1'); state.input_failed = true; state.error = 'Beginning input failed';
  await f.inputs.stop('ch1'); await immediate();
  assert.equal(f.store.streams()[0].beginning_fallback, true);
  assert.ok(f.registry.gaps(f.store.streams()[0].broadcast_id).some(gap => gap.reason === 'beginning_collection_failed'));
  f.phase('live'); await f.monitor.tick(); assert.equal(f.sources.length, 2); assert.equal(f.sources[1].beginning_fallback, true);
  f.minutes.flush(); assert.ok(f.registry.minutes(f.store.streams()[0].broadcast_id).warnings.some(text => /현재 시점/.test(text)));
});
