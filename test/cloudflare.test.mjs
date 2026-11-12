import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { D1Store } from '../cloudflare/d1-store.mjs';
import { handleRequest } from '../cloudflare/worker.mjs';
import { publicationContentHash } from '../web/lib/publication-protocol.mjs';
import { buildCloudflare } from '../cloudflare/build.mjs';
import { cloudSettings } from '../src/cloud-publisher.mjs';
import { CloudPublishers } from '../src/cloud-publishers.mjs';
import { Store } from '../src/store.mjs';
import { proxyLive } from '../cloudflare/live-proxy.mjs';
import { TranscriptState } from '../public/client-state.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';

const secret = 'a'.repeat(64), owner = randomUUID(), minuteId = 'b'.repeat(64);
function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../cloudflare/migrations/0001_documents.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  const db = { prepare(text) { return { bind(...args) {
    const values = args.map(value => Array.isArray(value) ? Buffer.from(value) : value);
    return { async first() { return sql.prepare(text).get(...values) ?? null; },
      async run() { return { meta: { changes: sql.prepare(text).run(...values).changes } }; } };
  } }; } };
  return { db, sql, env: { DB: db, JC_SYNC_SECRET: secret, JC_PUBLISHER_ID: owner, ASSETS: { fetch: () => new Response('static') } } };
}
function index() { return { kind: 'snapshot', snapshot: { event_id: 0, streams: [], segments: [], states: [], gaps: [] }, minutes_index: [] }; }
function minutes() { return { kind: 'minutes', document: { id: minuteId, title: '종료 회의', status: 'draft', updated_ms: 1,
  segment_count: 0, session_count: 1, publication_policy: 'ai-corrected-v1', sources: [], warnings: [], gaps: [],
  transcript: [], discussion: [], paragraphs: [], markdown: '후보정 완료 회의록' }, segments: [] }; }
function envelope(data = index(), revision = 1) {
  return { ...data, published_ms: Date.now(), sent_ms: Date.now(), publication: {
    publisher_id: owner, revision, request_id: randomUUID(), content_hash: publicationContentHash({ ...data, published_ms: Date.now() }) } };
}
function send(env, data, headers = {}, compress = false) {
  return handleRequest(new Request('https://jc-live.unit.workers.dev/api/sync', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret,
      ...(compress ? { 'Content-Encoding': 'gzip' } : {}), ...headers },
    body: compress ? gzipSync(JSON.stringify(data)) : JSON.stringify(data) }), env);
}

test('D1 uses parameterized atomic create/update and rejects concurrent losers', async t => {
  const { db } = fixture(t), store = new D1Store(db), value = envelope();
  const created = await Promise.allSettled([store.write('site.json', value), store.write('site.json', value)]);
  assert.equal(created.filter(r => r.status === 'fulfilled').length, 1);
  const first = await store.read('site.json'); assert.deepEqual(first.value, value);
  const changed = await Promise.allSettled([store.write('site.json', value, first.etag), store.write('site.json', value, first.etag)]);
  assert.equal(changed.filter(r => r.status === 'fulfilled').length, 1);
  assert.notEqual((await store.read('site.json')).etag, first.etag);
  await assert.rejects(store.read("x'; DROP TABLE documents;--"), /path/);
});

test('Worker stores only ended public archives and empty index, with idempotent owner-bound publication', async t => {
  const { env, sql } = fixture(t), data = envelope();
  assert.equal((await send(env, data, {}, true)).status, 200);
  assert.equal((await (await send(env, data)).json()).unchanged, true);
  assert.equal((await send(env, envelope(minutes()))).status, 200);
  const result = await handleRequest(new Request('https://jc-live.unit.workers.dev/api/viewer/minutes/' + minuteId), env);
  assert.equal(result.status, 200); assert.equal((await result.json()).markdown, '후보정 완료 회의록');
  assert.equal(result.headers.get('x-frame-options'), 'DENY');
  assert.equal(result.headers.get('vercel-cdn-cache-control'), null);
  const active = minutes(); active.document.status = 'in_progress';
  assert.equal((await send(env, envelope(active, 2))).status, 400);
  const live = index(); live.snapshot.states = [{ stream_id: 'ch1', session_id: 'session1', state: 'running' }];
  assert.equal((await send(env, envelope(live, 2))).status, 400);
  const downgrade = { ...index(), published_ms: Date.now() };
  assert.equal((await send(env, downgrade)).status, 400);
  const foreign = envelope(); foreign.publication.publisher_id = randomUUID();
  assert.equal((await send(env, foreign)).status, 409);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM documents').get().n, 2);
});

test('Worker rejects foreign origins, cookies, methods, traversal and secret disclosure', async t => {
  const { env } = fixture(t);
  assert.equal((await send(env, envelope(), { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await send(env, envelope(), { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await send(env, envelope(), { Cookie: 'session=1' })).status, 400);
  for (const route of ['events', 'snapshot', 'segments', 'minutes/%2e%2e', 'minutes/' + minuteId + '?url=http://127.0.0.1']) {
    assert.ok((await handleRequest(new Request('https://jc-live.unit.workers.dev/api/viewer/' + route), env)).status >= 400);
  }
  const notConfigured = await send({ ...env, JC_PUBLISHER_ID: '' }, envelope());
  assert.equal(notConfigured.status, 503); assert.doesNotMatch(await notConfigured.text(), new RegExp(secret));
  assert.equal((await handleRequest(new Request('https://jc-live.unit.workers.dev/api/sync'), env)).status, 405);
});

test('Cloudflare build excludes admin/local data and retains HTTPS CSP', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-cf-assets-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(buildCloudflare({ directory, desktopOrigin: '' }), /explicit/);
  const origin = 'https://live.unit.test'; const result = await buildCloudflare({ directory, desktopOrigin: origin });
  assert.equal(result.adminAssets, 0);
  assert.equal(JSON.parse(readFileSync(join(directory, 'live-transport.json'))).origin, origin);
  const headers = readFileSync(join(directory, '_headers'), 'utf8');
  assert.match(headers, /frame-ancestors 'none'/); assert.match(headers, /connect-src 'self' https:\/\/vod\.council\.jeju\.kr https:\/\/live\.unit\.test;/);
  assert.match(headers, /media-src 'self' blob: https:\/\/vod\.council\.jeju\.kr;/);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/);
  assert.equal(readFileSync(join(directory, 'minutes.html'), 'utf8').includes('minutes'), true);
  await buildCloudflare({ directory, desktopOrigin: origin });
});

test('VPC proxy streams desktop SSE and preserves only approved read-only headers and routes', async () => {
  const origin = 'https://jc-live.unit.workers.dev'; const calls = [];
  // The status probe that chooses between the desktop and the standby laptop is answered first.
  const probe = request => request.url === 'http://127.0.0.1:4321/api/viewer/snapshot?text_streams=';
  const env = { JC_ALLOWED_ORIGINS: JSON.stringify([origin]), DESKTOP_LIVE: { fetch: async request => {
    if (probe(request)) return Response.json({ streams: [], states: [], engine: 'running' });
    calls.push(request);
    return new Response('data: {"kind":"heartbeat"}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'bad=1' } });
  } } };
  const response = await proxyLive(new Request(origin + '/api/viewer/events?after=0'), env);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /heartbeat/);
  assert.equal(calls[0].url, 'http://127.0.0.1:4321/api/viewer/events?after=0');
  assert.equal(calls[0].headers.get('origin'), origin);
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(response.headers.get('x-jc-active-processor'), 'desktop');
  assert.equal((await proxyLive(new Request(origin + '/api/viewer/events'), { ...env,
    DESKTOP_LIVE: { fetch: async request => probe(request) ? Response.json({ streams: [], states: [] })
      : new Response(null, { status: 302, headers: { Location: 'https://foreign.test' } }) } })).status, 502);
  assert.equal(await proxyLive(new Request(origin + '/api/admin/settings'), env), null);
  assert.equal((await proxyLive(new Request(origin + '/api/viewer/snapshot', { headers: { Origin: 'https://foreign.test' } }), env)).status, 403);
  assert.equal((await proxyLive(new Request(origin + '/api/viewer/snapshot', { headers: { Authorization: 'Bearer private' } }), env)).status, 405);
  const offline = await proxyLive(new Request(origin + '/api/viewer/events'), { ...env, DESKTOP_LIVE: undefined });
  assert.equal(offline.status, 503); assert.equal(calls.length, 1);
  assert.equal((await proxyLive(new Request(origin + '/api/viewer/status'), env)).status, 200);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:4321/api/viewer/status');
});

test('dual publishers isolate endpoints and keep failed Vercel outbox while Cloudflare index succeeds', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-dual-'));
  const vercel = join(dir, 'v.secret'), cloudflare = join(dir, 'c.secret');
  writeFileSync(vercel, JSON.stringify({ endpoint: 'https://fixture.vercel.app/api/sync', secret }));
  writeFileSync(cloudflare, JSON.stringify({ provider: 'cloudflare', archive_only: true, endpoint: 'https://jc-live.unit.workers.dev/api/sync', secret: 'c'.repeat(64) }));
  const config = { cloudSyncFile: vercel, cloudSyncFiles: [cloudflare], desktopLive: { enabled: true } };
  assert.equal(cloudSettings({ cloudSyncFile: cloudflare }).archive_only, true);
  const store = new Store(join(dir, 'test.sqlite'));
  const calls = [];
  const group = new CloudPublishers({ config, store, registry: new BroadcastRegistry(store), minutes: { flush() {} },
    fetcher: async (url, options) => { calls.push({ host: new URL(url).host, auth: options.headers.Authorization });
      return Response.json(url.includes('vercel.app') ? { code: 'suspended' } : { accepted: true }, { status: url.includes('vercel.app') ? 402 : 200 }); } });
  t.after(async () => { await group.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await group.flush();
  assert.equal(calls.length, 2); assert.equal(group.publishers[0].control.load().blocked, 'suspended');
  assert.ok(group.publishers[0].control.outbox('site')); assert.ok(!group.publishers[1].control.outbox('site'));
  assert.notEqual(calls[0].auth, calls[1].auth);
  assert.doesNotMatch(JSON.stringify(group.view()), new RegExp(secret));
  writeFileSync(cloudflare, JSON.stringify({ provider: 'cloudflare', endpoint: 'https://jc-live.unit.workers.dev/api/sync', secret }));
  assert.throws(() => cloudSettings({ cloudSyncFile: cloudflare }));
});

test('read-only desktop store rejects writes and sees external writer events without loading an engine', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-reader-')), path = join(dir, 'test.sqlite');
  const writer = new Store(path), reader = new Store(path, { readOnly: true });
  t.after(() => { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => reader.saveStream({ stream_id: 'ch1' }), /readonly/);
  writer.saveStream({ stream_id: 'ch1', name: '공개 방송' });
  assert.equal(reader.streams()[0].name, '공개 방송');
  const event = writer.event('status', { stream_id: 'ch1' });
  assert.equal(reader.cursor(), event.event_id);
});

test('pushed health refreshes labels without moving the transcript event cursor', () => {
  const state = new TranscriptState(); state.cursor = 10;
  assert.equal(state.apply({ event_id: 4, kind: 'delivery-health', payload: { health: [{ stream_id: 'ch1', status: 'processing' }] } }), true);
  assert.equal(state.cursor, 10); assert.equal(state.health.get('ch1').status, 'processing');
  assert.equal(state.apply({ event_id: 11, kind: 'segment', payload: { segment_id: 'one', stream_id: 'ch1', version: 1 } }), true);
  assert.equal(state.cursor, 11);
});
