import { timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { publicationContentHash } from './publication-protocol.mjs';
import { readViewer, viewerModel, invalidateViewer, memoSnapshot } from './viewer-cache.mjs';
import { CloudError, publicUpdate, channelId, broadcastId } from './model.mjs';
import { selectSnapshotText, snapshotEtag, matchesEtag } from './snapshot-selection.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
// Public viewer data only: Vercel's CDN shares a response for one second and collapses simultaneous misses
// into one function call. Browsers still revalidate every poll; errors and 304 replies are never shared.
const edgeCache = { 'Vercel-CDN-Cache-Control': 'max-age=1, stale-while-revalidate=2' };
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
function acceptsGzip(value = '') {
  return value.split(',').some(part => { const [name, ...params] = part.trim().split(';');
    const q = params.find(item => item.trim().startsWith('q='));
    return name.toLowerCase() === 'gzip' && (!q || Number(q.trim().slice(2)) > 0); });
}
function deliver(request, value, responseHeaders) {
  const raw = Buffer.from(value);
  const gzip = raw.length > 100000 && acceptsGzip(request.headers.get('accept-encoding') ?? '');
  return new Response(gzip ? gzipSync(raw) : raw, { headers: { ...headers, ...(!request.headers.has('authorization') && !request.headers.has('cookie') ? edgeCache : {}), ...responseHeaders,
    Vary: 'Accept-Encoding, Origin', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) } });
}
const publicJson = (request, value) => deliver(request, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
const storedGzip = (request, body) => new Response(body, { headers: { ...headers, ...(!request.headers.has('authorization') && !request.headers.has('cookie') ? edgeCache : {}),
  'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding, Origin', 'Content-Encoding': 'gzip' } });
const fail = (status, message) => { throw new CloudError(status, message); };
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) fail(403, 'Origin rejected');
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'JSON required');
  let bytes = 0; const parts = [];
  for await (const part of request.body ?? []) {
    bytes += part.length; if (bytes > 3500000) fail(413, 'Publication exceeds 3.5 MB');
    parts.push(part);
  }
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding !== 'gzip' && encoding !== 'identity') fail(415, 'Unsupported encoding');
  try {
    const raw = Buffer.concat(parts);
    return JSON.parse((encoding === 'gzip' ? gunzipSync(raw, { maxOutputLength: 64_000_000 }) : raw).toString('utf8'));
  } catch { fail(400, 'Invalid or oversized JSON'); }
}
function failure(error) {
  if (error instanceof CloudError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status,
    error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  const diagnostic = String(error?.name ?? '') + ' ' + String(error?.message ?? '') + ' ' + String(error?.code ?? '');
  const code = /quota|limit.exceeded|storage_limit/i.test(diagnostic) ? 'quota'
    : /suspend/i.test(diagnostic) ? 'suspended'
    : /token|credential|authentication|oidc|BlobAccessError|forbidden/i.test(diagnostic) ? 'credentials'
    : /precondition|already.exists|conflict/i.test(diagnostic) ? 'conflict' : 'temporary';
  const retryAfter = Number(error?.retryAfter);
  console.error(JSON.stringify({ event: 'cloud.request_failed', code }));
  return json({ error: '공개 자료 연결을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.', code }, code === 'conflict' ? 409 : 503,
    Number.isFinite(retryAfter) && retryAfter > 0 ? { 'Retry-After': String(Math.ceil(retryAfter)) } : {});
}
export async function syncRequest(request, { storage, secret, publisherId, now = Date.now, validate = () => {}, runtimeCheck = () => {} } = {}) {
  try {
    runtimeCheck();
    if (request.method !== 'POST') fail(405, 'POST required');
    sameOrigin(request);
    if (!/^[a-f0-9]{64}$/.test(secret ?? '')) throw new CloudError(503, 'Publisher is not configured', 'credentials');
    const received = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from('Bearer ' + secret);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new CloudError(401, 'Publisher authorization required', 'credentials');
    const value = publicUpdate(await readBody(request));
    validate(value);
    const publication = value.publication;
    if (publisherId && publication?.publisher_id !== publisherId.toLowerCase()) throw new CloudError(409, 'Publisher ownership conflicts', 'conflict');
    if (publication && publication.content_hash !== publicationContentHash(value)) fail(400, 'Publication hash mismatch');
    const path = value.kind === 'snapshot' ? 'site.json' : 'minutes/' + value.document.id + '.json';
    // Mutation reads always bypass viewer coalescing and memoization.
    const previous = await storage.read(path);
    const prior = previous?.value.publication;
    const conflict = message => { throw new CloudError(409, message, 'conflict'); };
    if (prior && !publication) conflict('Publication protocol downgrade rejected');
    if (prior && publication) {
      if (prior.publisher_id !== publication.publisher_id) conflict('Publisher ownership conflicts');
      if (prior.request_id === publication.request_id) {
        if (prior.content_hash !== publication.content_hash || prior.revision !== publication.revision
          || previous.value.published_ms !== value.published_ms) conflict('Publication request conflicts');
        return json({ accepted: true, unchanged: true });
      }
      if (publication.revision <= prior.revision) conflict('Newer publication already stored');
    }
    if (publication && previous && previous.value.published_ms > value.published_ms) conflict('Publication time regressed');
    if (Math.abs(now() - (publication ? value.sent_ms : value.published_ms)) > 300000) fail(400, 'Publication time outside allowed window');
    if (!publication) {
      if (previous && previous.value.published_ms > value.published_ms) conflict('Newer publication already stored');
      if (previous && previous.value.published_ms === value.published_ms) {
        if (JSON.stringify(previous.value) !== JSON.stringify(value)) conflict('Publication time conflicts');
        return json({ accepted: true, unchanged: true });
      }
    }
    try { await storage.write(path, value, previous?.etag); }
    finally { invalidateViewer(storage, path); }
    return json({ accepted: true, published_ms: value.published_ms });
  } catch (error) { return failure(error); }
}
export async function viewerRequest(request, { storage, runtimeCheck = () => {} } = {}) {
  try {
    runtimeCheck();
    if (request.method !== 'GET') fail(405, 'Read-only endpoint');
    sameOrigin(request);
    if (request.headers.has('authorization') || request.headers.has('cookie')) {
      const source = storage;
      storage = { read: path => source.read(path) };
    }
    const url = new URL(request.url); const route = url.searchParams.get('route') ?? url.pathname.replace(/^\/api\/viewer\/?/, '');
    if (route === 'snapshot' || route === 'segments' || route === 'schedule' || route === 'minutes' || route === 'minutes/') {
      const ids = (url.searchParams.get('streams') ?? Array.from({ length: 13 }, (_, i) => 'ch' + i).join(',')).split(',').filter(Boolean).map(channelId);
      const texts = (url.searchParams.get('text_streams') ?? ids.join(',')).split(',').filter(Boolean).map(channelId);
      if (ids.length > 13 || texts.length > 13) fail(400, 'Invalid channels');
      ids.splice(0, ids.length, ...new Set(ids)); ids.sort();
      texts.splice(0, texts.length, ...new Set(texts)); texts.sort();
      let stream, before, limit, q;
      if (route === 'segments') {
        stream = channelId(url.searchParams.get('stream'));
        before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        limit = Number(url.searchParams.get('limit') ?? 100);
        q = (url.searchParams.get('q') ?? '').toLocaleLowerCase();
        if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200 || q.length > 200) fail(400, 'Invalid cursor');
        if (url.searchParams.has('broadcast')) broadcastId(url.searchParams.get('broadcast'));
      }
      const stored = await readViewer(storage, 'site.json');
      if (!stored) fail(503, '첫 방송 자료를 기다립니다. 잠시 후 다시 시도해 주세요.');
      const model = viewerModel(storage, 'site.json', stored);
      if (route === 'schedule') return publicJson(request, model.snapshot.schedule);
      if (route.startsWith('minutes')) return publicJson(request, { items: model.minutes_index });
      if (route === 'snapshot') {
        const { text, etag } = memoSnapshot(model, JSON.stringify([ids, texts]), () => {
        const value = selectSnapshotText({ ...model.snapshot,
        streams: model.snapshot.streams.filter(item => ids.includes(item.stream_id)),
        segments: model.snapshot.segments.filter(item => ids.includes(item.stream_id)),
        live_segments: model.snapshot.live_segments.filter(item => ids.includes(item.stream_id)),
        states: model.snapshot.states.filter(item => ids.includes(item.stream_id)),
        health: (model.snapshot.health ?? []).filter(item => ids.includes(item.stream_id)),
        gaps: model.snapshot.gaps.filter(item => ids.includes(item.stream_id)),
        delivery: { mode: 'poll', interval_ms: 5000, published_ms: model.published_ms } }, texts.filter(id => ids.includes(id)));
        const text = JSON.stringify(value); return { text, etag: snapshotEtag(text) };
        });
        if (matchesEtag(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers: { ...headers, ETag: etag, Vary: 'Accept-Encoding, Origin' } });
        return deliver(request, text, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag });
      }
      const source = model.snapshot.streams.find(item => item.stream_id === stream);
      if (url.searchParams.has('broadcast') && url.searchParams.get('broadcast') !== source?.broadcast_id) fail(409, 'Broadcast changed');
      const history = source?.broadcast_id ? await readViewer(storage, 'minutes/' + broadcastId(source.broadcast_id) + '.json') : null;
      const items = history ? viewerModel(storage, 'minutes/' + source.broadcast_id + '.json', history).segments : model.snapshot.segments.filter(item => item.stream_id === stream);
      const stable = items.every(item => Number.isSafeInteger(item.sequence) && item.sequence > 0);
      const matches = items.map((item, position) => ({ item, position: stable ? item.sequence : position })).filter(({ item, position }) => position < before && (!q || item.text.toLocaleLowerCase().includes(q)));
      const page = matches.slice(-limit);
      return publicJson(request, { broadcast_id: source?.broadcast_id ?? null, items: page.map(({ item }) => ({ ...item, stream_id: stream })), before: matches.length > limit ? page[0].position : 0 });
    }
    const match = route.match(/^minutes\/([a-f0-9]{64})(?:\.(md|json))?$/);
    if (!match) fail(404, 'Route not found');
    const path = 'minutes/' + match[1] + '.json'; const gzip = acceptsGzip(request.headers.get('accept-encoding') ?? '');
    // A store that keeps the compressed public document (Cloudflare D1) answers without decoding the archive.
    if (!match[2] && gzip && storage.readView) { const body = await storage.readView(path); if (body) return storedGzip(request, body); }
    const stored = await readViewer(storage, path);
    if (!stored) fail(404, '회의록을 찾지 못했습니다.');
    const value = viewerModel(storage, path, stored).document;
    if (!match[2] && gzip && storage.saveView && stored.etag) {
      // An archive stored before its view existed gets the view at its first read.
      const body = gzipSync(Buffer.from(JSON.stringify(value)));
      await storage.saveView(path, stored.etag, body).catch(() => {}); return storedGzip(request, body);
    }
    if (!match[2]) return publicJson(request, value);
    return deliver(request, match[2] === 'md' ? value.markdown : JSON.stringify(value, null, 2), {
      'Content-Type': match[2] === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="minutes-' + match[1].slice(0, 12) + '.' + match[2] + '"' });
  } catch (error) { return failure(error); }
}
