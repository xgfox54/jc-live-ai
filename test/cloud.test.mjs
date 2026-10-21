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
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-cloud-'));
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64), minutesDirectory: join(dir, 'minutes') };
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const minutes = new MinutesService({ store, registry, config });
  const storage = new MemoryStorage(); let now = Date.now(); let broken = false;
  const settings = { endpoint, secret, interval_ms: 60000, minutes_interval_ms: 300000 };
  const context = { config, store, registry, minutes, scheduler: { states: () => [] }, settings, now: () => now,
    fetcher: async (url, options) => {
      if (broken) throw new Error('private-network-diagnostic');
      return syncRequest(new Request(url, options), { storage, secret, now: () => now });
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
test('local transcripts publish to read-only cloud views with complete pagination, minutes exports and retained broadcast history', async t => {
  const f = fixture(t); const first = f.attach(1); f.segments(1, 0, 130);
  await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'published');
  let response = await f.read('snapshot'); let snapshot = await response.json();
  assert.equal(snapshot.delivery.mode, 'poll'); assert.equal(snapshot.before.ch1, 30);
  assert.equal(snapshot.segments.length, 100);
  const history = await (await f.read('segments?stream=ch1&before=30')).json();
  assert.equal(history.items.length, 30); assert.equal(history.items[0].text, '시험 발언 0');
  assert.doesNotMatch(JSON.stringify(history), /비공개 원문|raw_text/);
  const document = await (await f.read('minutes/' + first.id + '.json')).text();
  assert.equal(JSON.parse(document).transcript.length, 130); assert.doesNotMatch(document, /private-|adminToken|viewerToken/);
  assert.match((await f.read('minutes/' + first.id + '.md')).headers.get('content-disposition'), /attachment/);
  assert.doesNotMatch(JSON.stringify([...f.storage.rows.values()]), /private-|adminToken|viewerToken|media_url/);
  const writes = f.storage.writes; await f.publisher.flush(); assert.equal(f.storage.writes, writes);
  const restarted = new CloudPublisher(f); await restarted.flush(); assert.equal(f.storage.writes, writes); await restarted.close();
  f.tick(); f.segments(1, 130, 50); await f.publisher.flush();
  snapshot = await (await f.read('snapshot')).json(); assert.equal(snapshot.before.ch1, 80);
  assert.equal((await (await f.read('segments?stream=ch1&before=80')).json()).items.length, 80);
  f.tick(); f.segments(1, 180, 101); await f.publisher.flush();
  assert.equal((await (await f.read('minutes/' + first.id)).json()).segment_count, 281);
  f.tick(); const replacement = f.attach(2); f.segments(2, 0, 1); await f.publisher.flush();
  snapshot = await (await f.read('snapshot')).json(); assert.equal(snapshot.streams[0].broadcast_id, replacement.id);
  assert.equal(snapshot.segments.length, 1); assert.equal((await (await f.read('minutes/' + first.id)).json()).segment_count, 281);
});
test('failed cloud delivery keeps local writing available and retries without exposing diagnostics', async t => {
  const f = fixture(t); const record = f.attach(1); f.broken(true); f.segments(1, 0, 2);
  await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'retry');
  assert.doesNotMatch(JSON.stringify(f.publisher.view()), /private-|cccccccc/);
  f.segments(1, 2, 1); f.minutes.flush(); assert.equal(f.registry.minutes(record.id).segment_count, 3);
  f.broken(false); f.tick(); await f.publisher.flush(); assert.equal(f.publisher.view().phase, 'published');
  assert.equal((await (await f.read('minutes/' + record.id)).json()).segment_count, 3);
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
  const document = await (await f.read('minutes/' + record.id)).json();
  assert.equal(document.transcript.length, 3600); assert.equal(document.transcript.at(-1).end_ms, 36000000);
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
