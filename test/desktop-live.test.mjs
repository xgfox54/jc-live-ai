import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createDesktopLive, desktopLiveSettings } from '../src/desktop-live.mjs';
import { createLiveTransport, desktopOrigin } from '../public/live-transport.mjs';
import { applyLiveTransport } from '../web/deployment/live-transport.mjs';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const origin = 'https://fixture.vercel.app';
async function fixture(t, scheduler = { states: () => [] }) {
  const store = new Store(':memory:');
  const config = { desktopLive: { enabled: true, port: 0, publicOrigin: 'https://live.example.org', allowedOrigins: [origin] } };
  const gateway = createDesktopLive({ store, scheduler, config });
  await gateway.start(); const base = 'http://127.0.0.1:' + gateway.server.address().port;
  t.after(async () => { await gateway.close(); assert.equal(store.listenerCount('event'), 0); store.close(); });
  const get = (path, init = {}) => fetch(base + path, { ...init, headers: { Origin: origin, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(10000) });
  return { store, gateway, base, get };
}
async function readEvent(reader, predicate) {
  const decoder = new TextDecoder(); let wire = '';
  while (true) {
    const part = await reader.read(); if (part.done) throw new Error('Event stream ended');
    wire += decoder.decode(part.value, { stream: true });
    for (let end; (end = wire.indexOf('\n\n')) >= 0;) {
      const block = wire.slice(0, end); wire = wire.slice(end + 2);
      const data = block.split('\n').find(line => line.startsWith('data: '));
      if (data) { const event = JSON.parse(data.slice(6)); if (predicate(event)) return event; }
    }
  }
}

test('desktop listener exposes only approved read routes and exact CORS origins', async t => {
  const f = await fixture(t);
  for (const path of ['/admin.html', '/api/admin/streams', '/api/snapshot', '/api/sync', '/data/access.secret', '/api/viewer/minutes'])
    assert.equal((await f.get(path)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await f.get('/api/viewer/snapshot', { method })).status, 405);
  for (const bad of ['null', 'https://evil.test', origin + '.evil.test'])
    assert.equal((await f.get('/api/viewer/snapshot', { headers: { Origin: bad } })).status, 403);
  assert.equal((await fetch(f.base + '/api/viewer/snapshot')).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(f.base + '/api/viewer/snapshot', { headers: { Host: 'evil.test', Origin: origin } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.get('/api/viewer/snapshot', { headers: { Authorization: 'Bearer private' } })).status, 405);
  assert.equal((await f.get('/api/viewer/segments?stream=private')).status, 400);
  const preflight = await f.get('/api/viewer/snapshot', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'if-none-match' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.get('/api/viewer/events', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
});

test('desktop reports the transcription engine as running only while its worker accepts audio', async t => {
  // The read-only viewer process passes a scheduler without an engine.
  const readOnly = await fixture(t);
  assert.deepEqual(await (await readOnly.get('/api/viewer/status')).json(), { engine: 'stopped' });
  assert.equal((await (await readOnly.get('/api/viewer/snapshot')).json()).engine, 'stopped');
  const scheduler = { states: () => [], accepting: true, engine: { ready: true } };
  const live = await fixture(t, scheduler);
  const engine = async () => (await (await live.get('/api/viewer/status')).json()).engine;
  assert.equal(await engine(), 'running');
  assert.equal((await (await live.get('/api/viewer/snapshot')).json()).engine, 'running');
  scheduler.engine.ready = false; assert.equal(await engine(), 'stopped');
  scheduler.engine.ready = true; scheduler.accepting = false; assert.equal(await engine(), 'stopped');
});

test('desktop reconnect replays correction after a draft and paginates all older corrected text', async t => {
  const f = await fixture(t);
  f.store.saveStream({ stream_id: 'ch1', name: '합성 시험', prompt: 'PRIVATE_PROMPT' });
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'running', error: 'PRIVATE_ERROR' });
  for (let n = 0; n < 125; n++) {
    const row = f.store.segment({ stream_id: 'ch1', session_id: 'session1', start_ms: n * 5000, end_ms: (n + 1) * 5000, raw_text: 'PRIVATE_RAW' });
    f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '공개 확인 발언 ' + n });
  }
  const draft = f.store.segment({ stream_id: 'ch1', session_id: 'session1', start_ms: 625000, end_ms: 630000,
    raw_text: '합성 실시간 초안입니다.', live_preview: true });
  const snapshot = await (await f.get('/api/viewer/snapshot?streams=ch1')).json();
  assert.equal(snapshot.live_segments[0].display_state, 'draft'); assert.equal(snapshot.segments.length, 100);
  const history = await (await f.get('/api/viewer/segments?stream=ch1&before=' + snapshot.before.ch1)).json();
  assert.equal(history.items.length, 25); assert.equal(history.before, 0);
  f.store.correct(draft.segment_id, { version: 1, origin: 'ai', text: '합성 후보정 완료 문장입니다.' });
  const response = await f.get('/api/viewer/events?streams=ch1&after=' + snapshot.event_id);
  const reader = response.body.getReader();
  const event = await readEvent(reader, value => value.kind === 'live-segment'); await reader.cancel();
  assert.equal(event.payload.segment_id, draft.segment_id); assert.equal(event.payload.display_state, 'corrected');
  assert.equal(event.payload.text, '합성 후보정 완료 문장입니다.');
  assert.doesNotMatch(JSON.stringify([snapshot, history, event]), /PRIVATE_|raw_text|adminToken/);
});

test('desktop sends bounded reset for old cursor and honors shared snapshot ETags', async t => {
  const f = await fixture(t);
  const first = await f.get('/api/viewer/snapshot'); await first.arrayBuffer();
  const same = await f.get('/api/viewer/snapshot', { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(same.status, 304); assert.equal(same.headers.get('access-control-expose-headers'), 'ETag, Retry-After');
  for (let n = 0; n < 2002; n++) f.store.event('status', { stream_id: 'ch1', state: 'running' });
  const reply = await f.get('/api/viewer/events?streams=ch1&after=0'); const wire = await reply.text();
  assert.match(wire, /"kind":"reset"/); assert.ok(wire.length < 1000);
});

test('browser routes every live request to desktop without credentials or cloud fallback', async () => {
  const requests = []; let fail = false;
  const transport = createLiveTransport({ pageOrigin: origin, fetcher: async (url, options) => {
    requests.push({ url, options });
    if (url === '/live-transport.json') return Response.json({ mode: 'desktop', origin: 'https://live.example.org' });
    if (fail) throw new Error('offline'); return Response.json({});
  } });
  await transport.fetch('/api/snapshot?text_streams=ch1'); await transport.fetch('/api/events?after=4'); await transport.fetch('/api/status');
  assert.deepEqual(requests.map(row => row.url), ['/live-transport.json', 'https://live.example.org/api/viewer/snapshot?text_streams=ch1',
    'https://live.example.org/api/viewer/events?after=4', 'https://live.example.org/api/viewer/status']);
  assert.ok(requests.every(row => row.options.credentials === 'omit'));
  fail = true; await assert.rejects(transport.fetch('/api/segments?stream=ch1'), /offline/);
  assert.equal(requests.at(-1).url, 'https://live.example.org/api/viewer/segments?stream=ch1');
  await assert.rejects(transport.fetch('/api/admin/streams'));
  await assert.rejects(transport.fetch('https://evil.test/api/snapshot'));
});

test('deployment allows exactly one HTTPS live origin without weakening other CSP directives', () => {
  const source = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url)));
  const built = applyLiveTransport(source, 'https://live.example.org');
  const csp = value => value.headers.flatMap(row => row.headers).find(h => h.key === 'Content-Security-Policy').value;
  assert.equal(csp(built.source).replace(' https://live.example.org', ''), csp(source));
  assert.deepEqual(built.transport, { mode: 'desktop', origin: 'https://live.example.org', recovery_interval_ms: 120000 });
  assert.deepEqual(applyLiveTransport(source).transport, { mode: 'same-origin' });
  for (const bad of ['http://example.org', 'https://127.0.0.1', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org;evil']) {
    assert.throws(() => applyLiveTransport(source, bad)); assert.throws(() => desktopOrigin(bad));
  }
  assert.equal(desktopLiveSettings(null), null);
  assert.throws(() => desktopLiveSettings({ enabled: true, port: 4321, publicOrigin: 'https://live.example.org', allowedOrigins: ['*'] }));
});
test('the whole record of a meeting comes in one page and viewers of the meeting share one answer for 10 seconds', async t => {
  // Given a meeting longer than the former 200-sentence page
  const f = await fixture(t);
  f.store.saveStream({ stream_id: 'ch1', name: '합성 시험' });
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'running' });
  const add = n => { const row = f.store.segment({ stream_id: 'ch1', session_id: 'session1', start_ms: n * 5000, end_ms: (n + 1) * 5000, raw_text: 'PRIVATE_RAW' });
    f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '공개 확인 발언 ' + n }); };
  for (let n = 0; n < 450; n++) add(n);
  // When a viewer asks for the newest page of 2,000 sentences
  const page = await (await f.get('/api/viewer/segments?stream=ch1&limit=2000&before=' + Number.MAX_SAFE_INTEGER)).json();
  // Then every sentence arrives in order in one answer
  assert.equal(page.items.length, 450); assert.equal(page.before, 0);
  assert.equal(page.items[0].text, '공개 확인 발언 0'); assert.equal(page.items.at(-1).text, '공개 확인 발언 449');
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_|raw_text/);
  assert.equal((await f.get('/api/viewer/segments?stream=ch1&limit=2001')).status, 400);
  // A sentence added since then reaches viewers through the event stream; the same request within 10 seconds gets the first answer.
  add(450);
  const again = await (await f.get('/api/viewer/segments?stream=ch1&limit=2000&before=' + Number.MAX_SAFE_INTEGER)).json();
  assert.equal(again.items.length, 450);
});

test('large viewer answers go out compressed in an encoding the caller accepts, with the same JSON', async t => {
  // Given a meeting record larger than 1 KB
  const f = await fixture(t);
  f.store.saveStream({ stream_id: 'ch1', name: '합성 시험' });
  f.store.saveSession({ session_id: 'session1', stream_id: 'ch1', state: 'running' });
  for (let n = 0; n < 60; n++) {
    const row = f.store.segment({ stream_id: 'ch1', session_id: 'session1', start_ms: n * 5000, end_ms: (n + 1) * 5000, raw_text: 'PRIVATE_RAW' });
    f.store.correct(row.segment_id, { version: 1, origin: 'ai', text: '압축 확인 발언 ' + n });
  }
  const raw = (path, encoding) => new Promise((resolve, reject) => {
    const req = request(f.base + path, { headers: { Origin: origin, ...(encoding === undefined ? {} : { 'Accept-Encoding': encoding }) } }, res => {
      const parts = []; res.on('data', part => parts.push(part)); res.on('error', reject);
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject); req.end();
  });
  const path = '/api/viewer/segments?stream=ch1&limit=2000&before=' + Number.MAX_SAFE_INTEGER;
  // When viewers ask with different Accept-Encoding headers
  const [plain, br, gz, none] = await Promise.all([raw(path), raw(path, 'gzip, deflate, br, zstd'), raw(path, 'br;q=0, gzip'), raw(path, 'identity')]);
  // Then each gets the same JSON, compressed only when the header allows it
  assert.equal(plain.headers['content-encoding'], undefined); assert.equal(none.headers['content-encoding'], undefined);
  assert.equal(br.headers['content-encoding'], 'br'); assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(brotliDecompressSync(br.body), plain.body); assert.deepEqual(gunzipSync(gz.body), plain.body); assert.deepEqual(none.body, plain.body);
  assert.equal(JSON.parse(plain.body).items.length, 60); assert.ok(br.body.length * 3 < plain.body.length);
  for (const answer of [plain, br, gz, none]) assert.equal(answer.headers.vary, 'Origin, Accept-Encoding');
  // The snapshot with text is compressed the same way; a small answer goes out as it is
  assert.equal((await raw('/api/viewer/snapshot?text_streams=ch1', 'br')).headers['content-encoding'], 'br');
  assert.equal((await raw('/api/viewer/status', 'br')).headers['content-encoding'], undefined);
});
