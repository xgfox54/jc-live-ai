import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { priorityFetch, priorityControl, protectedArchive, archiveViewer, requestLimit, RESTORED_MINUTES_ID, MERGED_MINUTES_ID } from '../cloudflare/priority-routing.mjs';
import { handleRequest } from '../cloudflare/worker.mjs';
import { proxyLive } from '../cloudflare/live-proxy.mjs';
import { StandbyPolicy } from '../scripts/standby/standby-policy.mjs';

const origin = 'https://jc-live.unit.workers.dev';
const key = 'a'.repeat(64);
const desktop = (snapshot, body = 'desktop transcript') => ({ fetch: async request => request.url.endsWith('/api/viewer/snapshot?text_streams=')
  ? (snapshot instanceof Response ? snapshot : Response.json(snapshot)) : new Response(body) });
const request = path => [path, { headers: new Headers({ Origin: origin }), signal: new AbortController().signal }];

test('desktop recovery takes precedence over an available laptop', async () => {
  const env = { DESKTOP_LIVE: desktop({ streams: [], states: [], engine: 'running' }), JC_LAPTOP_URL: 'http://127.0.0.1:1', JC_LAPTOP_SECRET: key };
  const response = await priorityFetch(...request('/api/viewer/segments'), env, origin);
  assert.equal(await response.text(), 'desktop transcript');
  assert.equal(response.headers.get('X-JC-Active-Processor'), 'desktop');
});

test('desktop outage or a stopped desktop engine serves the authenticated laptop', async t => {
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.headers['x-jc-laptop-key']); res.writeHead(req.headers['x-jc-laptop-key'] === key ? 200 : 403); res.end('laptop transcript'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const laptop = { JC_LAPTOP_URL: 'http://127.0.0.1:' + server.address().port, JC_LAPTOP_SECRET: key };
  for (const DESKTOP_LIVE of [desktop(new Response(null, { status: 503 })), { fetch: async () => { throw new TypeError('connection refused'); } },
    desktop({ streams: [], states: [], engine: 'stopped' })]) {
    const response = await priorityFetch(...request('/api/viewer/segments'), { ...laptop, DESKTOP_LIVE }, origin);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'laptop transcript');
    assert.equal(response.headers.get('X-JC-Active-Processor'), 'laptop');
  }
  assert.deepEqual(seen, [key, key, key]);
});

test('unknown desktop status or a missing laptop gives viewers 503 instead of a guess', async () => {
  const env = { JC_ALLOWED_ORIGINS: JSON.stringify([origin]) };
  assert.equal(await priorityFetch(...request('/api/viewer/status'), { DESKTOP_LIVE: desktop(new Response('not json')) }, origin), null);
  assert.equal(await priorityFetch(...request('/api/viewer/status'), { DESKTOP_LIVE: desktop(new Response(null, { status: 503 })) }, origin), null);
  const response = await proxyLive(new Request(origin + '/api/viewer/status'), { ...env, DESKTOP_LIVE: desktop(new Response(null, { status: 404 })) });
  assert.equal(response.status, 503);
});

test('only laptop event streams reconnect periodically; desktop streams stay open', () => {
  assert.equal(requestLimit('/api/viewer/events', true), null);
  assert.equal(requestLimit('/api/viewer/events', false), 30000);
  assert.equal(requestLimit('/api/viewer/snapshot', true), 15000);
  assert.equal(requestLimit('/api/viewer/segments', false), 15000);
});

test('standby requires sustained confirmed silence and stops on recovery or uncertainty', () => {
  const policy = new StandbyPolicy();
  assert.equal(policy.observe(false, 0), false);
  assert.equal(policy.observe(false, 59999), false);
  assert.equal(policy.observe(false, 60000), true);
  assert.equal(policy.observe(true, 60001), false);
  assert.equal(policy.observe(false, 60002), false);
  assert.equal(policy.observe(false, 120002), true);
  assert.equal(policy.observe(null, 120003), false);
  assert.equal(policy.observe(false, 120004), false);
});

test('failover control and handoff routes require their keys and never reach viewers without them', async () => {
  const env = { JC_LAPTOP_SECRET: key, DESKTOP_LIVE: desktop({ streams: [], states: [] }) };
  assert.equal((await priorityControl(new Request(origin + '/api/failover'), env)).status, 403);
  assert.equal((await priorityControl(new Request(origin + '/api/failover', { method: 'POST', headers: { 'X-JC-Laptop-Key': key } }), env)).status, 403);
  const control = await priorityControl(new Request(origin + '/api/failover', { headers: { 'X-JC-Laptop-Key': key } }), env);
  assert.equal(control.status, 200); assert.equal((await control.json()).desktop_ready, true);
  assert.equal((await handleRequest(new Request(origin + '/api/failover'), env)).status, 403);
  assert.equal((await handleRequest(new Request(origin + '/api/handoff?video=abcdefghijk'), env)).status, 403);
});

test('returning desktop cannot overwrite restored transcript or remove its index', async () => {
  const id = RESTORED_MINUTES_ID;
  let writes = 0;
  const store = protectedArchive({ read: async path => ({ value: path === 'site.json'
    ? { minutes_index: [{ id, segment_count: 886 }] } : { document: { transcript: [{ segment_id: 'restored' }] } } }), write: async () => { writes++; } });
  await assert.rejects(store.write('minutes/' + id + '.json', { document: { transcript: [] } }, 'etag'), /reconciled/);
  const viewer = archiveViewer({ read: async path => ({ etag: '1', value: path === 'site.json'
    ? { minutes_index: [{ id: 'new', scheduled_at: '2026-11-12' }] } : { document: { id, scheduled_at: '2026-11-11', segment_count: 886 } } }) }, doc => doc);
  assert.deepEqual((await viewer.read('site.json')).value.minutes_index.map(x => x.id), ['new', id]);
  assert.equal(writes, 0);
  await store.write('minutes/' + id + '.json', { document: { transcript: [{ segment_id: 'restored' }], digest: { topics: [{}] }, timeline: [{}] } }, 'etag');
  await store.write('minutes/' + 'c'.repeat(64) + '.json', { document: { transcript: [] } }, 'etag');
  assert.equal(writes, 2);
});

test('the merged desktop record replaces the restored entry once it holds the recovered rows', async () => {
  const restored = { document: { id: RESTORED_MINUTES_ID, scheduled_at: '2026-11-11', segment_count: 886 } };
  const viewer = sessions => archiveViewer({ read: async path => ({ etag: '1', value: path === 'site.json'
    ? { minutes_index: [{ id: MERGED_MINUTES_ID, scheduled_at: '2026-11-11 10:00', session_count: sessions }] } : restored }) }, doc => doc);
  assert.deepEqual((await viewer(2).read('site.json')).value.minutes_index.map(x => x.id), [MERGED_MINUTES_ID, RESTORED_MINUTES_ID]);
  assert.deepEqual((await viewer(3).read('site.json')).value.minutes_index.map(x => x.id), [MERGED_MINUTES_ID]);
  assert.equal((await viewer(3).read('minutes/' + RESTORED_MINUTES_ID + '.json')).value, restored);
});
