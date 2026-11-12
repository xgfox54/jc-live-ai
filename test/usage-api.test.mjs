import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { syncRequest, viewerRequest } from '../web/lib/http.mjs';
import { BlobStore } from '../web/lib/blob-store.mjs';
import { publicationContentHash, stableStringify } from '../web/lib/publication-protocol.mjs';

const secret = 'a'.repeat(64), owner = randomUUID(), now = 1000000;
const base = () => ({ kind: 'snapshot', published_ms: now, snapshot: { event_id: 0, streams: [], segments: [], states: [], gaps: [] }, minutes_index: [] });
const envelope = (revision = 1, data = base()) => ({ ...data, sent_ms: now, publication: { publisher_id: owner, request_id: randomUUID(), revision, content_hash: publicationContentHash(data) } });
class Storage {
  row = null; reads = 0; writes = 0;
  async read() { this.reads++; return structuredClone(this.row); }
  async write(path, value, etag) {
    if (etag !== this.row?.etag) throw Object.assign(new Error('private'), { name: 'BlobPreconditionFailedError' });
    this.row = { value, etag: String(++this.writes) };
  }
}
const send = (storage, data, options = {}) => syncRequest(new Request('https://unit.test/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(data) }), { storage, secret, now: () => now, ...options });
const view = (storage, route = 'snapshot', headers) => viewerRequest(new Request('https://unit.test/api/viewer/' + route, { headers }), { storage });

test('publication hash ignores transport times and key order; protocol rejects mismatches before reading', async () => {
  assert.equal(stableStringify({ b: [2, 1], a: 0 }), '{"a":0,"b":[2,1]}');
  const data = envelope();
  assert.equal(publicationContentHash(data), publicationContentHash({ ...data, published_ms: 1, sent_ms: 2 }));
  const storage = new Storage(); data.snapshot.event_id++;
  assert.equal((await send(storage, data)).status, 400); assert.equal(storage.reads, 0);
});

test('equivalent channel order and duplicates share response identity', async () => {
  const storage = new Storage(); storage.row = { value: base(), etag: 'canonical' };
  const first = await view(storage, 'snapshot?streams=ch2,ch1,ch1&text_streams=ch2,ch1');
  const second = await view(storage, 'snapshot?text_streams=ch1,ch2&streams=ch1,ch2');
  assert.equal(first.status, 200); assert.equal(first.headers.get('etag'), second.headers.get('etag'));
  assert.equal(await first.text(), await second.text());
});
test('lost acknowledgement retry beyond five minutes is idempotent and ownership/revision/downgrade conflict', async () => {
  const storage = new Storage(), data = envelope();
  assert.equal((await send(storage, data)).status, 200);
  const retry = await send(storage, data, { now: () => now + 900000 });
  assert.equal((await retry.json()).unchanged, true); assert.equal(storage.writes, 1);
  const changed = envelope(1, { ...base(), snapshot: { ...base().snapshot, event_id: 1 } });
  changed.publication.request_id = data.publication.request_id;
  assert.equal((await send(storage, changed)).status, 409);
  assert.equal((await send(storage, envelope(1))).status, 409);
  const other = envelope(2); other.publication.publisher_id = randomUUID();
  assert.equal((await send(storage, other)).status, 409);
  assert.equal((await send(storage, base())).status, 409);
  assert.equal((await send(storage, envelope(2), { now: () => now + 900000 })).status, 400);
  const fresh = envelope(2); fresh.sent_ms += 900000;
  assert.equal((await send(storage, fresh, { now: () => now + 900000 })).status, 200);
  assert.equal(storage.writes, 2);
});
test('concurrent initial writers and updates use CAS with one winner', async () => {
  const storage = new Storage();
  let responses = await Promise.all([send(storage, envelope()), send(storage, envelope())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal(storage.writes, 1);
  responses = await Promise.all([send(storage, envelope(2)), send(storage, envelope(3))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal(storage.writes, 2);
});
test('Blob adapter conditional create, update and counters use an injected SDK only', async () => {
  const calls = [], sdk = { get: async () => null, put: async (...args) => { calls.push(args); } };
  const storage = new BlobStore({ sdk });
  await storage.read('site.json'); await storage.write('site.json', base()); await storage.write('site.json', base(), 'v1');
  assert.equal(calls[0][2].allowOverwrite, false); assert.equal(calls[0][2].ifMatch, undefined);
  assert.equal(calls[1][2].ifMatch, 'v1'); assert.equal(calls[1][2].allowOverwrite, true);
  const usage = storage.usage(); assert.equal(usage.read_attempts, 1); assert.equal(usage.write_successes, 2);
  assert.ok(usage.write_bytes > 0); assert.equal(usage.estimated_operations, 3); assert.equal(usage.billing_verified, false);
});
test('invalid query costs zero reads; simultaneous viewers share only in-flight reads and next poll sees writes', async () => {
  const storage = new Storage(); storage.row = { value: base(), etag: 'v1' };
  for (const route of ['snapshot?streams=bad', 'segments?stream=ch1&limit=201', 'segments?stream=ch1&q=' + 'x'.repeat(201), 'bad']) assert.ok((await view(storage, route)).status >= 400);
  assert.equal(storage.reads, 0);
  const replies = await Promise.all(Array.from({ length: 30 }, () => view(storage)));
  assert.equal(storage.reads, 1); assert.ok(replies.every(r => r.status === 200));
  const old = replies[0].headers.get('etag');
  storage.row = { value: { ...base(), published_ms: now + 1 }, etag: 'v2' };
  const fresh = await view(storage); assert.equal(storage.reads, 2); assert.notEqual(fresh.headers.get('etag'), old);
  const separate = new Storage(); separate.row = { value: base(), etag: 'v2' };
  assert.equal((await (await view(separate)).json()).delivery.published_ms, now);
});
test('private requests are not shared at CDN; conditional responses vary by origin', async () => {
  const storage = new Storage(); storage.row = { value: base(), etag: 'v1' };
  const response = await view(storage);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'max-age=1, stale-while-revalidate=2');
  for (const headers of [{ Cookie: 'session=1' }, { Authorization: 'Bearer example' }]) assert.equal((await view(storage, 'snapshot', headers)).headers.get('vercel-cdn-cache-control'), null);
  const cached = await view(storage, 'snapshot', { 'If-None-Match': response.headers.get('etag') });
  assert.equal(cached.status, 304); assert.match(cached.headers.get('vary'), /Origin/);
});
test('SDK failures return safe machine codes and retry-after without diagnostics', async () => {
  for (const [name, code] of [['BlobStoreSuspendedError', 'suspended'], ['BlobAccessError', 'credentials'], ['BlobQuotaExceededError', 'quota'], ['BlobServiceRateLimited', 'temporary'], ['BlobPreconditionFailedError', 'conflict']]) {
    const storage = { read: async () => { throw Object.assign(new Error('private-diagnostic'), { name, retryAfter: 17 }); } };
    const response = await send(storage, envelope()); assert.equal(response.headers.get('retry-after'), '17');
    const value = await response.json(); assert.equal(value.code, code); assert.doesNotMatch(JSON.stringify(value), /private-diagnostic/);
  }
});
test('gzip q=0 remains uncompressed for large snapshots', async () => {
  const data = base(); data.snapshot.segments = Array.from({ length: 30 }, (_, i) => ({ stream_id: 'ch1', session_id: 's1', segment_id: 's' + i, start_ms: 0, end_ms: 1, ai_corrected: true, version: 1, text: 'x'.repeat(4999) }));
  const storage = new Storage(); storage.row = { value: data, etag: 'v1' };
  assert.equal((await view(storage, 'snapshot', { 'Accept-Encoding': 'gzip;q=0, br' })).headers.get('content-encoding'), null);
  assert.equal((await view(storage, 'snapshot', { 'Accept-Encoding': 'gzip;q=1' })).headers.get('content-encoding'), 'gzip');
});

test('authenticated viewer reads do not coalesce; failed shared reads are released', async () => {
  const storage = new Storage(); storage.row = { value: base(), etag: 'v1' };
  await Promise.all(Array.from({ length: 5 }, () => view(storage, 'snapshot', { Cookie: 'session=1' })));
  assert.equal(storage.reads, 5);
  let count = 0;
  const failure = { read: async () => { count++; throw new Error('offline'); } };
  await Promise.all([view(failure), view(failure)]); assert.equal(count, 1);
  await view(failure); assert.equal(count, 2);
});

test('content-driven idle state survives projection and hash changes with activity', async () => {
  const data = base(); data.snapshot.publication = { status: 'published', last_published_ms: null, stale_after_ms: 180000, content_driven: true, active: false };
  const storage = new Storage(); storage.row = { value: data, etag: 'idle' };
  const result = await (await view(storage)).json();
  assert.equal(result.publication.content_driven, true); assert.equal(result.publication.active, false);
  const idleHash = publicationContentHash(data); data.snapshot.publication.active = true;
  assert.notEqual(publicationContentHash(data), idleHash);
});

test('protocol revisions cannot regress logical publication time except unchanged retry', async () => {
  const storage = new Storage(); const first = envelope();
  await send(storage, first);
  const old = envelope(2, { ...base(), published_ms: now - 1 });
  assert.equal((await send(storage, old)).status, 409); assert.equal(storage.writes, 1);
  assert.equal((await send(storage, first, { now: () => now + 900000 })).status, 200);
});
test('late viewer read cannot replace a new in-flight read after write invalidation', async () => {
  const storage = new Storage(); storage.row = { value: base(), etag: 'v1' };
  const original = storage.read.bind(storage); let release;
  let reads = 0;
  storage.read = async () => {
    reads++; const result = await original();
    if (reads === 1) await new Promise(resolve => { release = resolve; });
    return result;
  };
  const stale = view(storage);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const changed = envelope(1, { ...base(), published_ms: now + 1 });
  assert.equal((await send(storage, changed)).status, 200);
  const fresh = await view(storage); assert.equal((await fresh.json()).delivery.published_ms, now + 1);
  release(); await stale;
  const next = await view(storage); assert.equal((await next.json()).delivery.published_ms, now + 1);
  assert.equal(reads, 4);
});
test('Blob retry contract is pinned and bounded without changing deployment settings', async () => {
  const { blobRetryLimit } = await import('../web/lib/blob-store.mjs');
  assert.equal(blobRetryLimit({}), 0);
  for (const value of ['0', '1', '2']) assert.equal(blobRetryLimit({ VERCEL_BLOB_RETRIES: value }), Number(value));
  for (const value of ['', '3', '10', '-1', '1.5', 'invalid']) assert.throws(() => blobRetryLimit({ VERCEL_BLOB_RETRIES: value }));
  const { readFileSync, readdirSync } = await import('node:fs');
  const packageFile = new URL('../web/node_modules/@vercel/blob/package.json', import.meta.url);
  assert.equal(JSON.parse(readFileSync(packageFile, 'utf8')).version, '2.8.2');
  const directory = new URL('../web/node_modules/@vercel/blob/dist/', import.meta.url);
  const chunks = readdirSync(directory).filter(name => name.endsWith('.js')).map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
  assert.match(chunks, /process\.env\.VERCEL_BLOB_RETRIES \|\| "10"/);
  assert.match(chunks, /retries: getRetries\(\)/);
  const store = new BlobStore({ sdk: { put: async (_path, _body, options) => assert.equal(options.multipart, false) } });
  await store.write('site.json', base());
});
