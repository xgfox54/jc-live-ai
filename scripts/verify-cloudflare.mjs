import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { publicMinutes } from '../web/lib/model.mjs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { viewerMinutes } from '../src/viewer-minutes.mjs';

const origin = 'https://jc-live.xgfox54.workers.dev', vercel = 'https://jc-live-ykh1.vercel.app';
const report = { checked_at: new Date().toISOString(), origin, checks: [], archives: [], sse: [] };
function check(name, passed, detail = {}) { report.checks.push({ name, passed, ...detail }); if (!passed) process.exitCode = 1; }
const get = (path, options) => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
const hash = text => createHash('sha256').update(text).digest('hex');
const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
const db = new DatabaseSync(config.database, { readOnly: true });
const key = hash(origin + '/api/sync');
const local = db.prepare('SELECT id,document FROM cloud_publications WHERE endpoint=?').all(key)
  .filter(row => row.id !== 'site').map(row => ({ id: row.id, ...JSON.parse(row.document) }));
db.close();
const reader = new Store(config.database, { readOnly: true });
const registry = new BroadcastRegistry(reader);
try {
  for (const path of ['/', '/minutes', '/logo-jc-live.png', '/Pretendard-SemiBold.woff2']) {
    const response = await get(path); check('public asset ' + path, response.status === 200 && response.headers.get('x-frame-options') === 'DENY');
    await response.arrayBuffer();
  }
  const transport = await (await get('/live-transport.json')).json();
  check('desktop transport', transport.mode === 'desktop' && transport.origin === origin && transport.recovery_interval_ms === 120000);
  const list = await (await get('/api/viewer/minutes')).json();
  check('archive index', list.items.length === local.length && list.items.every(item => item.status === 'draft'), { count: list.items.length });
  for (const row of local) {
    const response = await get('/api/viewer/minutes/' + row.id); const document = await response.json();
    const actual = hash(JSON.stringify(document)), expected = hash(JSON.stringify(publicMinutes(viewerMinutes(registry, row.id))));
    const passed = response.status === 200 && actual === expected;
    report.archives.push({ id: row.id, passed, sha256: actual, segments: document.segment_count });
    check('archive ' + row.id.slice(0, 12), passed);
  }
  for (const path of ['/admin.html', '/data/access.secret', '/api/admin/settings', '/api/viewer/../../data/live.sqlite'])
    check('blocked route ' + path, (await get(path)).status === 404);
  check('unauthorized publication', (await get('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
  check('foreign origin', (await get('/api/viewer/snapshot', { headers: { Origin: 'https://foreign.test' } })).status === 403);
  const snapshotResponse = await get('/api/viewer/snapshot?text_streams=', { headers: { Origin: vercel } });
  const snapshot = await snapshotResponse.json(); const etag = snapshotResponse.headers.get('etag');
  check('desktop snapshot across Vercel origin', snapshotResponse.status === 200 && snapshot.streams.length === 13
    && snapshotResponse.headers.get('access-control-allow-origin') === vercel, { channels: snapshot.streams.length });
  const cached = await get('/api/viewer/snapshot?text_streams=', { headers: { Origin: vercel, 'If-None-Match': etag } });
  check('conditional snapshot', cached.status === 304);
  const preflight = await get('/api/viewer/snapshot', { method: 'OPTIONS', headers: { Origin: vercel,
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'If-None-Match' } });
  check('conditional CORS preflight', preflight.status === 204);
  for (const from of [origin, vercel]) {
    const controller = new AbortController(); const started = performance.now(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await get('/api/viewer/events?after=' + snapshot.event_id + '&streams=ch0', { headers: { Origin: from }, signal: controller.signal });
      const reader = response.body.getReader(); let text = '';
      while (!text.includes('"kind":"delivery-health"')) {
        const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value);
        if (text.length > 100000) throw new Error('SSE verification exceeded expected size');
      }
      await reader.cancel();
      const passed = response.status === 200 && text.includes('"kind":"delivery-health"');
      report.sse.push({ origin: from, passed, health_received_ms: Math.round(performance.now() - started) });
      check('desktop SSE ' + from, passed);
    } catch { check('desktop SSE ' + from, false); } finally { clearTimeout(timer); controller.abort(); }
  }
} catch (error) {
  check('verification completed', false, { error: error.name });
} finally {
  reader.close();
  report.passed = report.checks.every(item => item.passed);
  mkdirSync('reports/cloudflare', { recursive: true });
  writeFileSync('reports/cloudflare/production-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, archives: report.archives.length, sse: report.sse }));
}
