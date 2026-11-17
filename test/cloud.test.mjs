import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { MinutesService } from '../src/minutes.mjs';
import { CloudPublisher, cloudSettings } from '../src/cloud-publisher.mjs';
import { ALIGNMENT_METHOD } from '../src/video-alignment.mjs';
import { viewerMinuteList } from '../src/viewer-minutes.mjs';
import { minutesSummary } from '../web/lib/model.mjs';
import { archiveOnly } from '../cloudflare/worker.mjs';
import { syncRequest, viewerRequest } from '../web/lib/http.mjs';
import { pollSnapshots } from '../public/polling.mjs';
import { buildWeb, assets } from '../scripts/build-web.mjs';

const secret = 'c'.repeat(64);
const endpoint = 'https://fixture.vercel.app/api/sync';
class MemoryStorage {
  rows = new Map(); writes = 0;
  async read(path) { return structuredClone(this.rows.get(path) ?? null); }
  async write(path, value, etag) {
    assert.equal(etag, this.rows.get(path)?.etag);
    this.rows.set(path, { value: structuredClone(value), etag: String(++this.writes) });
  }
}
function fixture(t, { desktop = false, validate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-cloud-'));
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64), minutesDirectory: join(dir, 'minutes') };
  if (desktop) config.desktopLive = { enabled: true };
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const minutes = new MinutesService({ store, registry, config });
  const storage = new MemoryStorage(); let now = Date.now(); let broken = false;
  const settings = { endpoint, secret, interval_ms: 60000, minutes_interval_ms: 300000 };
  const context = { config, store, registry, minutes, scheduler: { states: () => [] }, settings, now: () => now,
    fetcher: async (url, options) => {
      if (broken) throw new Error('private-network-diagnostic');
      return syncRequest(new Request(url, options), { storage, secret, now: () => now, ...(validate ? { validate } : {}) });
    } };
  const publisher = new CloudPublisher(context);
  t.after(async () => { await publisher.close(); minutes.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const attach = n => {
    const video_id = String(n).padStart(11, '0'); const page_url = 'https://www.youtube.com/watch?v=' + video_id;
    const record = registry.upsert({ video_id, page_url, title: '시험 회의 ' + n, sources: [page_url], kind: 'youtube' });
    const stream = { stream_id: 'ch1', name: record.title, page_url, video_id, broadcast_id: record.id, prompt: 'private-prompt' };
    store.saveStream(stream); registry.attach(stream, { session_id: 'session' + n });
    store.saveSession({ session_id: 'session' + n, stream_id: 'ch1', state: 'running', error: 'private-error' });
    return record;
  };
  const segments = (n, start, count) => {
    for (let i = start; i < start + count; i++) {
      const row = store.segment({ session_id: 'session' + n, stream_id: 'ch1', start_ms: i * 5000, end_ms: (i + 1) * 5000, raw_text: '비공개 원문 ' + i });
      store.correct(row.segment_id, { version: 1, origin: 'ai', text: '시험 발언 ' + i });
    }
  };
  const read = path => viewerRequest(new Request('https://fixture.vercel.app/api/viewer/' + path), { storage });
  return { ...context, dir, storage, publisher, attach, segments, read, tick: () => { now += 60000; }, broken: value => { broken = value; } };
}
test('cloud publication requires a dedicated key, rejects foreign origins, invalid data, oversize bodies and stale versions', async () => {
  const storage = new MemoryStorage(); const now = Date.now();
  const data = { kind: 'snapshot', published_ms: now, snapshot: { event_id: 0, streams: [], segments: [], states: [], gaps: [], before: {} }, minutes_index: [] };
  const send = (body, options = {}) => syncRequest(new Request(endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret, ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) }), { storage, secret, now: () => now });
  assert.equal((await send('invalid', { headers: { Authorization: 'wrong' } })).status, 401);
  assert.equal((await send(data, { headers: { Origin: 'https://foreign.test' } })).status, 403);
  assert.equal(storage.writes, 0);
  assert.equal((await send('x'.repeat(3500001))).status, 413);
  assert.equal((await send({ ...data, published_ms: now - 300001 })).status, 400);
  const invalid = structuredClone(data); invalid.snapshot.streams = [{ stream_id: 'ch1', name: 'Test', page_url: 'bad-url' }];
  assert.equal((await send(invalid)).status, 400);
  assert.equal((await send(data)).status, 200);
  assert.equal((await send(data)).status, 200); assert.equal(storage.writes, 1);
  assert.equal((await send({ ...data, published_ms: now - 1 })).status, 409);
  assert.equal((await send({ ...data, snapshot: { ...data.snapshot, event_id: 1 } })).status, 409);
  assert.equal((await viewerRequest(new Request(endpoint, { method: 'POST' }), { storage })).status, 405);
});

test('reserved final archive is published before a deferred live archive and its index still updates', async t => {
  const f = fixture(t); const ended = f.attach(1); f.segments(1, 0, 1);
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'stopped' });
  const active = f.attach(2); f.segments(2, 0, 1);
  f.publisher.control.settings.budget = { period_id: 'verified', advanced_limit: 100, advanced_used: 85, reserved_final: 5, enforce: true };
  f.publisher.control.change(state => { state.budget_period = 'verified'; });
  await f.publisher.flushArchive();
  assert.ok(f.storage.rows.has('minutes/' + ended.id + '.json'));
  assert.equal(f.storage.rows.has('minutes/' + active.id + '.json'), false);
  assert.deepEqual(f.storage.rows.get('site.json').value.minutes_index.map(row => row.id), [ended.id]);
});
test('local transcripts publish to read-only cloud views with complete pagination, minutes exports and retained broadcast history', async t => {
  const f = fixture(t); const first = f.attach(1); f.segments(1, 0, 130);
  await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'published');
  let response = await f.read('snapshot'); let snapshot = await response.json();
  assert.equal(snapshot.delivery.mode, 'poll'); assert.equal(snapshot.before.ch1, 31);
  assert.equal(snapshot.segments.length, 100);
  const history = await (await f.read('segments?stream=ch1&before=' + snapshot.before.ch1)).json();
  assert.equal(history.items.length, 30); assert.equal(history.items[0].text, '시험 발언 0');
  assert.doesNotMatch(JSON.stringify(history), /비공개 원문|raw_text/);
  const document = await (await f.read('minutes/' + first.id + '.json')).text();
  assert.equal(JSON.parse(document).transcript.length, 130); assert.doesNotMatch(document, /private-|adminToken|viewerToken/);
  assert.match((await f.read('minutes/' + first.id + '.md')).headers.get('content-disposition'), /attachment/);
  assert.doesNotMatch(JSON.stringify([...f.storage.rows.values()]), /private-|adminToken|viewerToken|media_url/);
  const writes = f.storage.writes; await f.publisher.flush(); assert.equal(f.storage.writes, writes);
  const restarted = new CloudPublisher(f); await restarted.flush(); assert.equal(f.storage.writes, writes); await restarted.close();
  f.tick(); f.segments(1, 130, 50); await f.publisher.flush();
  snapshot = await (await f.read('snapshot')).json(); assert.equal(snapshot.before.ch1, 81);
  assert.equal((await (await f.read('segments?stream=ch1&before=' + snapshot.before.ch1)).json()).items.length, 80);
  f.tick(); f.segments(1, 180, 101); await f.publisher.flush();
  assert.equal((await (await f.read('minutes/' + first.id)).json()).segment_count, 281);
  f.tick(); const replacement = f.attach(2); f.segments(2, 0, 1); await f.publisher.flush();
  snapshot = await (await f.read('snapshot')).json(); assert.equal(snapshot.streams[0].broadcast_id, replacement.id);
  assert.equal(snapshot.segments.length, 1); assert.equal((await (await f.read('minutes/' + first.id)).json()).segment_count, 281);
  assert.equal((await f.read('segments?stream=ch1&broadcast=' + first.id)).status, 409);
});
test('cloud history uses persistent cursors when an older correction is published later', async t => {
  const f = fixture(t); f.attach(1); f.segments(1, 0, 1);
  const delayed = f.store.segment({ session_id: 'session1', stream_id: 'ch1', start_ms: 5000, end_ms: 10000, raw_text: '비공개 원문' });
  f.segments(1, 2, 20); await f.publisher.flush();
  const first = await (await f.read('segments?stream=ch1&limit=10')).json();
  assert.equal(first.before, 13);
  f.store.correct(delayed.segment_id, { version: 1, origin: 'ai', text: '늦게 보정된 발언' });
  for (let i = 0; i < 5; i++) f.tick(); await f.publisher.flush();
  const second = await (await f.read('segments?stream=ch1&limit=200&before=' + first.before)).json();
  assert.equal(new Set([...first.items, ...second.items].map(item => item.segment_id)).size, 22);
  assert.equal(second.items.find(item => item.segment_id === delayed.segment_id).sequence, 2);
  assert.equal(second.before, 0);
});
test('failed cloud delivery keeps local writing available and retries without exposing diagnostics', async t => {
  const f = fixture(t); const record = f.attach(1); f.broken(true); f.segments(1, 0, 2);
  await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'retry');
  assert.doesNotMatch(JSON.stringify(f.publisher.view()), /private-|cccccccc/);
  f.segments(1, 2, 1); f.minutes.flush(); assert.equal(f.registry.minutes(record.id).segment_count, 3);
  f.broken(false); f.tick(); await f.publisher.flush();
  f.tick(); await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'published');
  assert.equal((await (await f.read('minutes/' + record.id)).json()).segment_count, 3);
});

test('archive errors leave live drafts available and retry the unacknowledged archive', async t => {
  for (const failure of ['minutes-flush', 'minutes-http']) await t.test(failure, async t => {
    const f = fixture(t); const record = f.attach(1); f.segments(1, 0, 1);
    const draft = f.store.segment({ session_id: 'session1', stream_id: 'ch1', start_ms: 5000, end_ms: 10000,
      raw_text: '실시간 초안입니다.', live_preview: true });
    const flush = f.minutes.flush.bind(f.minutes); let broken = true;
    f.minutes.flush = () => { if (broken && failure === 'minutes-flush') throw new Error('private-archive-path'); return flush(); };
    f.publisher.fetcher = async (url, options) => {
      const body = JSON.parse(options.headers['Content-Encoding'] ? gunzipSync(options.body) : options.body);
      if (broken && failure === 'minutes-http' && body.kind === 'minutes') return new Response(null, { status: 500 });
      return f.fetcher(url, options);
    };
    await f.publisher.flush();
    const snapshot = await (await f.read('snapshot')).json();
    assert.equal(snapshot.live_segments?.[0]?.segment_id, draft.segment_id);
    assert.equal(f.publisher.view().phase, 'retry');
    assert.equal(f.publisher.view().live_phase, 'published');
    assert.equal(f.publisher.view().archive_phase, 'retry');
    assert.equal(f.publisher.known.has(record.id), false);
    assert.doesNotMatch(JSON.stringify(f.publisher.view()), /private-|cccccccc/);
    broken = false; f.tick(); await f.publisher.flush();
  f.tick(); await f.publisher.flush();
    assert.equal(f.publisher.view().phase, 'published');
    assert.equal((await (await f.read('minutes/' + record.id)).json()).segment_count, 1);
    assert.equal(f.publisher.known.get(record.id).summary.id, record.id);
    assert.equal((await (await f.read('segments?stream=ch1')).json()).items[0].sequence, 1);
  });
});

test('a pending archive does not hold later live snapshots or start duplicate archive requests', async t => {
  const f = fixture(t); const record = f.attach(1); f.segments(1, 0, 1);
  let release; let archiveCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.publisher.fetcher = async (url, options) => {
    const body = JSON.parse(options.headers['Content-Encoding'] ? gunzipSync(options.body) : options.body);
    if (body.kind === 'minutes') { archiveCalls++; await gate; }
    return f.fetcher(url, options);
  };
  const first = f.publisher.flush(); f.publisher.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await f.read('snapshot')).status, 200);
    assert.equal(f.publisher.view().archive_phase, 'publishing');
    assert.equal(f.publisher.known.has(record.id), false);
    f.tick();
    const draft = f.store.segment({ session_id: 'session1', stream_id: 'ch1', start_ms: 5000, end_ms: 10000,
      raw_text: '대기 중에도 전송할 초안입니다.', live_preview: true });
    await new Promise(resolve => setTimeout(resolve, 1300));
    if (f.publisher.pending) await f.publisher.pending;
    assert.equal((await (await f.read('snapshot')).json()).live_segments[0].segment_id, draft.segment_id);
    assert.equal(archiveCalls, 1);
  } finally { release(); await first; }
  f.tick(); await f.publisher.flush();
  assert.equal(f.publisher.view().phase, 'published');
  assert.equal((await (await f.read('minutes/' + record.id)).json()).segment_count, 1);
  assert.equal((await (await f.read('minutes')).json()).items[0].id, record.id);
});

test('snapshot retries preserve acknowledged archives and close aborts both publication requests', async t => {
  const f = fixture(t); const record = f.attach(1); f.segments(1, 0, 1);
  let broken = true; let archives = 0;
  f.publisher.fetcher = async (url, options) => {
    const body = JSON.parse(options.headers['Content-Encoding'] ? gunzipSync(options.body) : options.body);
    if (body.kind === 'minutes') archives++;
    if (broken && body.kind === 'snapshot') return new Response(null, { status: 500 });
    return f.fetcher(url, options);
  };
  await f.publisher.flush();
  assert.equal(f.publisher.view().phase, 'retry');
  assert.equal(f.publisher.view().live_phase, 'retry');
  assert.equal(f.publisher.view().archive_phase, 'published');
  assert.equal(f.publisher.known.has('site'), false);
  assert.equal(f.publisher.known.has(record.id), true);
  broken = false; f.tick(); await f.publisher.flush();
  f.tick(); await f.publisher.flush();
  assert.equal(f.publisher.view().phase, 'published'); assert.equal(archives, 1);

  const signals = [];
  f.tick(); f.segments(1, 1, 101);
  f.publisher.fetcher = (url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const pending = f.publisher.flush();
  assert.equal(signals.length, 2); assert.notEqual(signals[0], signals[1]);
  await f.publisher.close(); await pending;
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.equal(f.publisher.pending, null); assert.equal(f.publisher.archivePending, null);
});

test('unchanged snapshots retain the content publication timestamp at the normal interval', async t => {
  const f = fixture(t); await f.publisher.flush();
  const writes = f.storage.writes; const published = f.publisher.view().published_ms;
  await f.publisher.flush(); assert.equal(f.storage.writes, writes);
  f.tick(); await f.publisher.flush();
  assert.equal(f.storage.writes, writes);
  assert.equal((await (await f.read('snapshot')).json()).delivery.published_ms, published);
  assert.equal(f.publisher.view().published_ms, published);
});
test('new Whisper drafts reach cloud snapshots promptly and are replaced without publishing raw archive history', async t => {
  const f = fixture(t); f.attach(1); f.publisher.start(); await f.publisher.flush(); f.tick();
  f.store.saveSession({ stream_id: 'ch1', session_id: 'session1', state: 'running', started_ms: Date.now(),
    last_receive_ms: Date.now(), audio_received_until: 10000, audio_processed_until: 0 });
  await new Promise(resolve => setTimeout(resolve, 1300)); if (f.publisher.pending) await f.publisher.pending;
  assert.equal((await (await f.read('snapshot')).json()).health[0].stages.transcription, 'processing'); f.tick();
  const row = f.store.segment({ stream_id: 'ch1', session_id: 'session1', start_ms: 0, end_ms: 5000,
    raw_text: '일차 음성 인식 초안입니다.', live_preview: true, preview_updated_ms: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 1300)); if (f.publisher.pending) await f.publisher.pending;
  let snapshot = await (await f.read('snapshot')).json();
  assert.equal(snapshot.live_segments[0].text, row.raw_text); assert.equal(snapshot.live_segments[0].display_state, 'draft');
  assert.equal((await (await f.read('segments?stream=ch1')).json()).items.length, 0);
  f.tick(); f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: 'AI 후보정이 끝난 발언입니다.' });
  await new Promise(resolve => setTimeout(resolve, 1300)); if (f.publisher.pending) await f.publisher.pending;
  snapshot = await (await f.read('snapshot')).json();
  assert.equal(snapshot.live_segments[0].segment_id, row.segment_id); assert.equal(snapshot.live_segments[0].display_state, 'corrected');
  assert.doesNotMatch(JSON.stringify(snapshot), /일차 음성 인식 초안|raw_text/);
  assert.equal((await (await f.read('snapshot?streams=ch2')).json()).live_segments.length, 0);
});
test('cloud configuration remains optional and rejects unsafe destinations, shared keys and invalid intervals', t => {
  const f = fixture(t); assert.equal(cloudSettings(f.config), null);
  const cloudSyncFile = join(f.dir, 'cloud.secret');
  for (const value of [{ endpoint: 'http://private.test/api/sync', secret }, { endpoint, secret: f.config.adminToken },
    { endpoint, secret, interval_ms: '60000' }, { endpoint, secret, minutes_interval_ms: -1 }]) {
    writeFileSync(cloudSyncFile, JSON.stringify(value));
    assert.throws(() => cloudSettings({ ...f.config, cloudSyncFile }));
  }
  const blocked = new CloudPublisher({ ...f, settings: undefined, config: { ...f.config, cloudSyncFile } });
  assert.equal(blocked.view().phase, 'blocked');
});
test('cloud polling retries errors sequentially and aborts without another refresh', async () => {
  const controller = new AbortController(); const connections = []; let count = 0; let active = 0;
  await pollSnapshots({ signal: controller.signal, interval: 1, connection: value => connections.push(value), refresh: async () => {
    assert.equal(active++, 0); await new Promise(resolve => setTimeout(resolve, 2)); active--;
    count++; if (count === 1) throw new Error('offline'); if (count === 3) controller.abort();
  } });
  assert.equal(count, 3); assert.deepEqual(connections, [false, true]);
});
test('web deployment output contains only the public asset allowlist', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-web-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await buildWeb(dir); assert.deepEqual(readdirSync(dir).sort(), [...assets].sort());
  assert.ok(!assets.some(name => /admin|capture|automation|secret|sqlite/.test(name)));
  writeFileSync(join(dir, 'admin.html'), 'unexpected'); await assert.rejects(buildWeb(dir));
});
test('ten-hour transcripts exceeding the old body limit publish and export completely through gzip', async t => {
  const f = fixture(t); const record = f.attach(1);
  for (let i = 0; i < 3600; i++) { const row = f.store.segment({ session_id: 'session1', stream_id: 'ch1',
    start_ms: i * 10000, end_ms: (i + 1) * 10000,
    raw_text: '비공개 원문 ' + i });
    f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '발언 ' + i + ' ' + '통합돌봄 사업 예산과 집행 결과를 보고합니다. '.repeat(18) }); }
  f.minutes.flush();
  const raw = JSON.stringify({ kind: 'minutes', published_ms: f.now(), document: f.registry.minutes(record.id), segments: f.registry.segments(record.id) });
  assert.ok(Buffer.byteLength(raw) > 3500000);
  await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'published');
  // The page copy holds every sentence in its paragraphs; the sentence list and the Markdown text stay in the downloads.
  const document = await (await f.read('minutes/' + record.id)).json();
  assert.equal(document.segment_count, 3600); assert.equal(document.paragraphs[0].start_ms, 0);
  assert.equal(document.paragraphs.at(-1).end_ms, 36000000); assert.match(document.paragraphs.at(-1).text, /발언 3599 /);
  assert.deepEqual(document.transcript, []); assert.equal(document.markdown, undefined);
  const response = await viewerRequest(new Request('https://fixture.vercel.app/api/viewer/minutes/' + record.id + '.json',
    { headers: { 'Accept-Encoding': 'gzip' } }), { storage: f.storage });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const exported = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
  assert.equal(exported.transcript.length, 3600); assert.match(exported.markdown, /발언 3599/);
  const server = createServer(async (req, res) => {
    const response = await viewerRequest(new Request('https://fixture.vercel.app' + req.url, { headers: req.headers }), { storage: f.storage });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const overHttp = await fetch('http://127.0.0.1:' + server.address().port + '/api/viewer/minutes/' + record.id + '.json');
    assert.equal(overHttp.headers.get('content-encoding'), 'gzip');
    assert.equal((await overHttp.json()).transcript.length, 3600);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  let before = Number.MAX_SAFE_INTEGER; let count = 0;
  do { const page = await (await f.read('segments?stream=ch1&limit=200&before=' + before)).json(); count += page.items.length; before = page.before; } while (before);
  assert.equal(count, 3600);
});
test('compressed publication rejects malformed or unsupported compression after authentication', async () => {
  const send = (body, encoding = 'gzip', authorization = 'Bearer ' + secret) => syncRequest(new Request(endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding, Authorization: authorization }, body }),
    { storage: new MemoryStorage(), secret });
  assert.equal((await send(Buffer.from('bad-gzip'))).status, 400);
  assert.equal((await send(gzipSync('{}'), 'br')).status, 415);
  assert.equal((await send(gzipSync('{}'), 'gzip', 'wrong')).status, 401);
});

test('desktop mode publishes no live text and retains completed archives across final corrections', async t => {
  const f = fixture(t, { desktop: true }); const record = f.attach(1); f.segments(1, 0, 2);
  await f.publisher.flush(); const initialWrites = f.storage.writes;
  assert.equal(initialWrites, 1); assert.equal(f.storage.rows.get('site.json').value.snapshot.segments.length, 0);
  f.segments(1, 2, 2); f.tick(); await f.publisher.flush({ force: true });
  assert.equal(f.storage.writes, initialWrites); assert.equal(f.storage.rows.has('minutes/' + record.id + '.json'), false);
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'stopped', input_end_reason: 'eof', queue_length: 0 });
  f.publisher.getCorrectionAI = () => ({ liveCorrectionBusy: () => true });
  await f.publisher.flush(); assert.equal(f.storage.writes, initialWrites);
  f.publisher.getCorrectionAI = () => ({}); f.tick(); await f.publisher.flush();
  const archived = f.storage.rows.get('minutes/' + record.id + '.json').value;
  assert.equal(archived.document.segment_count, 4);
  assert.equal(f.storage.rows.get('site.json').value.minutes_index.length, 1);
  const saved = f.storage.writes; await f.publisher.flush(); assert.equal(f.storage.writes, saved);
  const row = f.registry.segments(record.id)[0]; f.store.correct(row.segment_id, { version: row.version, origin: 'ai', text: '최종 확인된 발언입니다.' });
  for (let n = 0; n < 6; n++) f.tick(); await f.publisher.flush();
  assert.equal(f.storage.rows.get('minutes/' + record.id + '.json').value.segments[0].text, '최종 확인된 발언입니다.');
  assert.doesNotMatch(JSON.stringify([...f.storage.rows.values()]), /비공개 원문|raw_text|private-/);
});

test('desktop mode preserves an unconfirmed old live outbox and blocks automatic migration', async t => {
  const f = fixture(t); f.attach(1); f.segments(1, 0, 1); f.broken(true); await f.publisher.flush();
  const pending = structuredClone(f.publisher.control.outbox('site'));
  await f.publisher.close(); f.config.desktopLive = { enabled: true }; f.broken(false); f.tick();
  const next = new CloudPublisher(f); t.after(() => next.close());
  await next.flush({ force: true });
  assert.equal(next.view().mode_transition_blocked, true); assert.equal(f.storage.writes, 0);
  assert.deepEqual(next.control.outbox('site'), pending);
});

test('an archive sent just after its meeting ended is listed as ended, so the archive-only index is accepted', async t => {
  const f = fixture(t, { desktop: true, validate: archiveOnly }); const record = f.attach(1); f.segments(1, 0, 2);
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'stopped', input_end_reason: 'eof', queue_length: 0 });
  f.minutes.flush();
  // 2026-11-13: the archive pass listed the meeting while it was still collecting and reached it after the end.
  const stored = JSON.parse(f.store.db.prepare('SELECT document FROM minutes WHERE broadcast_id=?').get(record.id).document);
  f.registry.saveMinutes({ ...stored, status: 'in_progress' });
  const stale = 'e'.repeat(64);
  f.publisher.remember(stale, { summary: { id: stale, title: '수집 중 회의', scheduled_at: '', status: 'in_progress', updated_ms: 1,
    segment_count: 0, session_count: 1, publication_policy: 'ai-corrected-v1' }, hash: 'stale', published_ms: 1 });
  for (let n = 0; n < 2; n++) { f.tick(); await f.publisher.flush(); }
  assert.equal(f.publisher.control.load().blocked, null);
  assert.equal(f.storage.rows.get('minutes/' + record.id + '.json').value.document.status, 'draft');
  assert.deepEqual(f.storage.rows.get('site.json').value.minutes_index.map(item => [item.id, item.status]), [[record.id, 'draft']]);
});

test('a restart keeps publishing when only an archive index request is pending', async t => {
  const f = fixture(t, { desktop: true }); f.broken(true); await f.publisher.flush();
  assert.ok(f.publisher.control.outbox('site'));
  await f.publisher.close(); f.broken(false); f.tick();
  const next = new CloudPublisher(f); t.after(() => next.close());
  assert.equal(next.view().mode_transition_blocked, false);
  await next.flush();
  assert.equal(next.control.outbox('site'), undefined); assert.ok(f.storage.rows.has('site.json'));
});
test('saving an ended meeting without changes keeps its minutes time and does not send it again', async t => {
  // 2026-11-14: the broadcast monitor saved the same record every 30 seconds. Each save rebuilt the minutes with a new
  // time, and the new time sent the whole archive again every 5 minutes while no meeting was running.
  const f = fixture(t, { desktop: true }); const record = f.attach(1); f.segments(1, 0, 2);
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'stopped', input_end_reason: 'eof', queue_length: 0 });
  for (let n = 0; n < 2; n++) { f.tick(); await f.publisher.flush(); }
  assert.ok(f.storage.rows.get('site.json').value.minutes_index.some(item => item.id === record.id));
  const writes = f.storage.writes; const updated = f.registry.minutes(record.id).updated_ms;
  await new Promise(resolve => setTimeout(resolve, 5));
  for (let n = 0; n < 7; n++) { f.registry.save(f.registry.get(record.id)); f.tick(); await f.publisher.flush(); }
  assert.equal(f.registry.minutes(record.id).updated_ms, updated);
  assert.equal(f.storage.writes, writes);
  f.segments(1, 2, 1); for (let n = 0; n < 6; n++) f.tick(); await f.publisher.flush();
  assert.equal(f.storage.rows.get('minutes/' + record.id + '.json').value.document.segment_count, 3);
});
test('the minutes list and the minutes report the same update time after a speaker review', t => {
  const f = fixture(t); const record = f.attach(1); f.segments(1, 0, 1); f.minutes.flush();
  f.store.db.exec('CREATE TABLE IF NOT EXISTS review_state(id TEXT PRIMARY KEY,document TEXT NOT NULL)');
  const later = f.registry.minutes(record.id).updated_ms + 60_000;
  f.store.db.prepare('INSERT INTO review_state VALUES(?,?)').run('final-speakers:' + record.id, JSON.stringify({ phase: 'partial', updated_ms: later }));
  assert.equal(f.registry.minutes(record.id).updated_ms, later);
  assert.equal(f.registry.minuteList().find(item => item.id === record.id).updated_ms, later);
});
test('a meeting whose archive fails the public data check does not hold back the meetings after it', async t => {
  // 2026-11-14: the public check refused a replay link filed under 455END, and the error ended the whole archive pass,
  // so no meeting listed after that one was sent.
  const f = fixture(t, { desktop: true }); f.attach(1); f.segments(1, 0, 2); f.attach(2); f.segments(2, 0, 2);
  for (const n of [1, 2]) f.store.saveSession({ session_id: 'session' + n, stream_id: 'ch1', state: 'stopped', input_end_reason: 'eof', queue_length: 0 });
  f.minutes.flush();
  const [refused, other] = f.registry.minuteList().map(item => item.id);
  const session = f.registry.sessions(refused)[0].session_id;
  f.store.db.exec('CREATE TABLE IF NOT EXISTS review_state(id TEXT PRIMARY KEY,document TEXT NOT NULL);');
  f.store.db.prepare('INSERT INTO review_state VALUES(?,?)').run('video-alignment:' + refused, JSON.stringify({ phase: 'complete',
    method: ALIGNMENT_METHOD, source: 'council_vod', media_url: 'https://evil.test/vod/_definst_//2026/455/a/playlist.m3u8',
    page_url: null, video_id: null, sessions: { [session]: { offset_ms: 60000 } } }));
  for (let n = 0; n < 2; n++) { f.tick(); await f.publisher.flush(); }
  assert.ok(f.storage.rows.has('minutes/' + other + '.json'));
  assert.equal(f.storage.rows.has('minutes/' + refused + '.json'), false);
  assert.equal(f.publisher.view().archive_phase, 'retry');
});
test('the minutes list gives the broadcast time a meeting covers, from the first to the last published sentence of each recording', async t => {
  const f = fixture(t); const record = f.attach(1); f.segments(1, 0, 3);
  // A second recording of the meeting caught up ten minutes of broadcast; a third has no published sentence.
  for (const id of ['caught-up', 'silent']) { f.registry.attach({ stream_id: 'ch1', name: record.title, broadcast_id: record.id }, { session_id: id });
    f.store.saveSession({ session_id: id, stream_id: 'ch1', state: 'stopped' }); }
  for (const [start, end] of [[0, 5000], [595000, 600000]]) {
    const row = f.store.segment({ session_id: 'caught-up', stream_id: 'ch1', start_ms: start, end_ms: end, raw_text: '비공개 원문' });
    f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '따라잡은 발언' });
  }
  f.store.segment({ session_id: 'silent', stream_id: 'ch1', start_ms: 0, end_ms: 3600000, raw_text: '후보정 전 원문' });
  f.minutes.flush();
  const item = viewerMinuteList(f.registry).find(entry => entry.id === record.id);
  assert.equal(item.segment_count, 5); assert.equal(item.duration_ms, 15000 + 600000); assert.equal(minutesSummary(item).duration_ms, 615000);
  // A summary without the field keeps none, so an older publisher and this reader hash the same index.
  const { duration_ms, ...older } = item; assert.equal('duration_ms' in minutesSummary(older), false);
});
test('a meeting published before meeting lengths existed gets its length in the index without its archive being sent again', async t => {
  const f = fixture(t, { desktop: true }); const record = f.attach(1); f.segments(1, 0, 3);
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'stopped', input_end_reason: 'eof', queue_length: 0 });
  for (let n = 0; n < 2; n++) { f.tick(); await f.publisher.flush(); }
  // The summary kept with the archive as it was stored before 2026-11-16.
  const known = f.publisher.known.get(record.id); const { duration_ms, ...older } = known.summary; assert.equal(duration_ms, 15000);
  f.publisher.remember(record.id, { ...known, summary: older });
  const archive = f.storage.rows.get('minutes/' + record.id + '.json').etag;
  for (let n = 0; n < 2; n++) { f.tick(); await f.publisher.flush(); }
  assert.equal(f.storage.rows.get('minutes/' + record.id + '.json').etag, archive);
  assert.equal(f.storage.rows.get('site.json').value.minutes_index.find(item => item.id === record.id).duration_ms, 15000);
});
