import test from 'node:test';
import assert from 'node:assert/strict';
import { retryWithJitter } from '../public/polling.mjs';
import { viewerRequest } from '../web/lib/http.mjs';

const site = { kind: 'snapshot', published_ms: 1, minutes_index: [], snapshot: { event_id: 0, streams: [], segments: [], live_segments: [],
  states: [], gaps: [], before: {} } };
const storage = value => ({ read: async path => (path === 'site.json' && value ? { value, etag: '1' } : null) });

test('a refused first load retries after growing jittered delays and then succeeds', async () => {
  const delays = []; let calls = 0; const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realTimeout(fn, 0); };
  try {
    const value = await retryWithJitter(async () => { if (++calls < 3) throw new TypeError('fetch failed'); return 'ok'; },
      { baseMs: 1000, random: () => 0.5 });
    assert.equal(value, 'ok'); assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
  } finally { globalThis.setTimeout = realTimeout; }
});

test('client errors and closed pages are not retried', async () => {
  let calls = 0;
  await assert.rejects(retryWithJitter(async () => { calls++; throw Object.assign(new Error('missing'), { retry: false }); }));
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort(); calls = 0;
  await assert.rejects(retryWithJitter(async () => { calls++; throw new Error('x'); }, { signal: controller.signal }));
  assert.equal(calls, 1);
  await assert.rejects(retryWithJitter(async () => { calls++; throw new Error('x'); }, { attempts: 1 }));
});

test('public viewer reads allow one second of shared CDN caching while errors stay uncached', async () => {
  const ok = await viewerRequest(new Request('https://fixture.vercel.app/api/viewer/snapshot?text_streams=ch1'), { storage: storage(site) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('vercel-cdn-cache-control'), 'max-age=1, stale-while-revalidate=2');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(ok.headers.get('vary'), /Origin/);
  const tag = ok.headers.get('etag');
  const same = await viewerRequest(new Request('https://fixture.vercel.app/api/viewer/snapshot?text_streams=ch1', { headers: { 'If-None-Match': tag } }), { storage: storage(site) });
  assert.equal(same.status, 304); assert.equal(same.headers.get('vercel-cdn-cache-control'), null);
  const waiting = await viewerRequest(new Request('https://fixture.vercel.app/api/viewer/snapshot'), { storage: storage(null) });
  assert.equal(waiting.status, 503); assert.equal(waiting.headers.get('vercel-cdn-cache-control'), null);
  const foreign = await viewerRequest(new Request('https://fixture.vercel.app/api/viewer/snapshot', { headers: { Origin: 'https://foreign.invalid' } }), { storage: storage(site) });
  assert.equal(foreign.status, 403); assert.equal(foreign.headers.get('vercel-cdn-cache-control'), null);
});
