import { timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { BlobStore } from './blob-store.mjs';
import { CloudError, publicUpdate, channelId, broadcastId } from './model.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });
function deliver(request, value, responseHeaders) {
  const raw = Buffer.from(value);
  const gzip = raw.length > 100000 && /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '');
  return new Response(gzip ? gzipSync(raw) : raw, { headers: { ...headers, ...responseHeaders,
    Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) } });
}
const publicJson = (request, value) => deliver(request, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
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
  if (error instanceof CloudError) return json({ error: error.message }, error.status);
  console.error(JSON.stringify({ event: 'cloud.request_failed', type: error.name }));
  return json({ error: '공개 자료 연결을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.' }, 503);
}
export async function syncRequest(request, { storage = new BlobStore(), secret = process.env.JC_SYNC_SECRET, now = Date.now } = {}) {
  try {
    if (request.method !== 'POST') fail(405, 'POST required');
    sameOrigin(request);
    if (!/^[a-f0-9]{64}$/.test(secret ?? '')) fail(503, 'Publisher is not configured');
    const received = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from('Bearer ' + secret);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail(401, 'Publisher authorization required');
    const value = publicUpdate(await readBody(request));
    if (Math.abs(now() - value.published_ms) > 300000) fail(400, 'Publication time outside allowed window');
    const path = value.kind === 'snapshot' ? 'site.json' : 'minutes/' + value.document.id + '.json';
    const previous = await storage.read(path);
    if (previous && previous.value.published_ms > value.published_ms) fail(409, 'Newer publication already stored');
    if (previous && previous.value.published_ms === value.published_ms) {
      if (JSON.stringify(previous.value) !== JSON.stringify(value)) fail(409, 'Publication time conflicts');
      return json({ accepted: true, unchanged: true });
    }
    await storage.write(path, value, previous?.etag);
    return json({ accepted: true, published_ms: value.published_ms });
  } catch (error) { return failure(error); }
}
export async function viewerRequest(request, { storage = new BlobStore() } = {}) {
  try {
    if (request.method !== 'GET') fail(405, 'Read-only endpoint');
    sameOrigin(request);
    const url = new URL(request.url); const route = url.searchParams.get('route') ?? url.pathname.replace(/^\/api\/viewer\/?/, '');
    if (route === 'snapshot' || route === 'segments' || route === 'schedule' || route === 'minutes' || route === 'minutes/') {
      const stored = await storage.read('site.json');
      if (!stored) fail(503, '첫 방송 자료를 기다립니다. 잠시 후 다시 시도해 주세요.');
      const model = publicUpdate(stored.value);
      if (route === 'schedule') return publicJson(request, model.snapshot.schedule);
      if (route.startsWith('minutes')) return publicJson(request, { items: model.minutes_index });
      const ids = (url.searchParams.get('streams') ?? Array.from({ length: 12 }, (_, i) => 'ch' + (i + 1)).join(',')).split(',').filter(Boolean).map(channelId);
      if (ids.length > 12) fail(400, 'Invalid channels');
      if (route === 'snapshot') return publicJson(request, { ...model.snapshot,
        streams: model.snapshot.streams.filter(item => ids.includes(item.stream_id)),
        segments: model.snapshot.segments.filter(item => ids.includes(item.stream_id)),
        states: model.snapshot.states.filter(item => ids.includes(item.stream_id)),
        gaps: model.snapshot.gaps.filter(item => ids.includes(item.stream_id)),
        delivery: { mode: 'poll', interval_ms: 30000, published_ms: model.published_ms } });
      const stream = channelId(url.searchParams.get('stream')); const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'Invalid cursor');
      const source = model.snapshot.streams.find(item => item.stream_id === stream);
      const history = source?.broadcast_id ? await storage.read('minutes/' + broadcastId(source.broadcast_id) + '.json') : null;
      const items = history ? publicUpdate(history.value).segments : model.snapshot.segments.filter(item => item.stream_id === stream);
      const q = (url.searchParams.get('q') ?? '').toLocaleLowerCase(); if (q.length > 200) fail(400, 'Invalid search');
      const matches = items.map((item, position) => ({ item, position })).filter(({ item, position }) => position < before && (!q || item.text.toLocaleLowerCase().includes(q)));
      const page = matches.slice(-limit);
      return publicJson(request, { items: page.map(({ item }) => ({ ...item, stream_id: stream })), before: matches.length > limit ? page[0].position : 0 });
    }
    const match = route.match(/^minutes\/([a-f0-9]{64})(?:\.(md|json))?$/);
    if (!match) fail(404, 'Route not found');
    const stored = await storage.read('minutes/' + match[1] + '.json');
    if (!stored) fail(404, '회의록을 찾지 못했습니다.');
    const value = publicUpdate(stored.value).document;
    if (!match[2]) return publicJson(request, value);
    return deliver(request, match[2] === 'md' ? value.markdown : JSON.stringify(value, null, 2), {
      'Content-Type': match[2] === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="minutes-' + match[1].slice(0, 12) + '.' + match[2] + '"' });
  } catch (error) { return failure(error); }
}
