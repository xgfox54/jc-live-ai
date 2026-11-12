import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { Store } from '../src/store.mjs';
import { createDesktopLive } from '../src/desktop-live.mjs';
import { assets } from './build-web.mjs';

const output = resolve(process.argv[2] ?? 'reports/desktop-live/browser'); mkdirSync(output, { recursive: true });
const { loadOmowright } = await import('file:///C:/Users/USER/.codex/plugins/cache/sisyphuslabs/omo/5.1.40/skills/browser/scripts/omowright.mjs');
const { omowright } = await loadOmowright();
const store = new Store(':memory:');
store.saveStream({ stream_id: 'ch1', name: '합성 시험', page_url: '' });
store.saveSession({ session_id: 'synthetic', stream_id: 'ch1', state: 'running' });
const gateway = createDesktopLive({ store, scheduler: { states: () => [] }, config: {
  desktopLive: { enabled: true, port: 0, publicOrigin: 'https://live.example.org', allowedOrigins: ['https://fixture.example.org'] } } });
await gateway.start(); const desktop = 'http://127.0.0.1:' + gateway.server.address().port;
const requests = []; const blocked = []; let unavailable = false; const replies = [];
const captureRequest = (req, res) => {
  requests.push(req.url); res.on('finish', () => replies.push({ url: req.url, status: res.statusCode }));
};
gateway.server.on('request', captureRequest);
const web = createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'none'; connect-src 'self' " + desktop + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-cache');
  if (req.url === '/live-transport.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode: 'desktop', origin: desktop })); return; }
  if (req.url.startsWith('/api/')) { blocked.push(req.url); res.writeHead(500); res.end(); return; }
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!assets.includes(name)) { res.writeHead(404); res.end(); return; }
  const type = { html: 'text/html', mjs: 'text/javascript', json: 'application/json', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', ttf: 'font/ttf', woff2: 'font/woff2' };
  res.setHeader('Content-Type', type[name.split('.').at(-1)] ?? 'text/plain'); res.end(readFileSync(new URL('../public/' + name, import.meta.url)));
});
web.listen(0, '127.0.0.1'); await once(web, 'listening'); const base = 'http://127.0.0.1:' + web.address().port;
gateway.settings.allowedOrigins.push(base); // Only the synthetic test permits a loopback browser origin.
const profile = mkdtempSync(join(output, 'profile-')); const scenarios = [];
let browser; let page; let routes;
const until = async (check, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const snapshot = async name => {
  writeFileSync(join(output, name + '.txt'), omowright.compactSnapshot(await page.snapshot()));
  writeFileSync(join(output, name + '.png'), await page.screenshot({ fullPage: true }));
};
const contains = text => page.evaluate(value => document.querySelector('.transcript')?.textContent.includes(value), text);
try {
  browser = await omowright.connectPipe({ browserPath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', storageRoot: profile,
    browserArgs: ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--user-data-dir=' + profile], dialogPolicy: { accept: false } });
  page = await browser.newTab(base + '/'); routes = omowright.createRoutes(page);
  await routes.route(() => true, route => {
    if (route.request.url.startsWith(desktop + '/')) return unavailable ? route.abort() : route.continue();
    if (route.request.url.startsWith(base + '/')) return route.continue();
    blocked.push(route.request.url); return route.abort();
  });
  await page.goto(base + '/');
  await until(() => page.evaluate(() => document.querySelector('#channels button:nth-child(2)')?.disabled === false), 'channel selectable');
  await page.snapshot(); await page.locator('#channels button:nth-child(2)').click();
  await until(() => page.evaluate(() => Boolean(document.querySelector('[data-stream="ch1"]'))), 'stage');
  const draft = store.segment({ stream_id: 'ch1', session_id: 'synthetic', start_ms: 10000, end_ms: 20000, live_preview: true, raw_text: '합성 실시간 초안입니다.' });
  await until(() => contains(draft.raw_text), 'draft display'); await snapshot('01-draft');
  store.correct(draft.segment_id, { version: 1, origin: 'ai', text: '합성 후보정 완료 문장입니다.' });
  await until(() => contains('합성 후보정 완료 문장입니다.'), 'correction display');
  assert.equal(await contains(draft.raw_text), false);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.transcript .segment').length), 1);
  await snapshot('02-corrected'); scenarios.push('cross_origin_draft_replaced_in_place');
  unavailable = true; gateway.server.closeAllConnections();
  await until(() => page.evaluate(() => /연결/.test(document.querySelector('#connection').textContent)), 'disconnected state');
  assert.equal(await contains('합성 후보정 완료 문장입니다.'), true); await snapshot('03-offline-retained');
  const missed = store.segment({ stream_id: 'ch1', session_id: 'synthetic', start_ms: 20000, end_ms: 30000, live_preview: true, raw_text: '합성 재연결 대기 문장입니다.' });
  store.correct(missed.segment_id, { version: 1, origin: 'ai', text: '합성 재연결 복구 문장입니다.' });
  unavailable = false; await until(() => contains('합성 재연결 복구 문장입니다.'), 'reconnect recovery', 25000);
  await snapshot('04-reconnected'); scenarios.push('offline_preserves_text_and_reconnect_recovers_missed_correction');
  await until(() => replies.some(row => row.status === 304), 'conditional request', 10000);
  assert.equal(blocked.length, 0); assert.ok(requests.some(path => path.startsWith('/api/viewer/events')));
  scenarios.push('no_cloud_api_requests_and_CORS_ETag_preflight');
  console.log(JSON.stringify({ passed: true, scenarios, output }));
} catch (error) { process.exitCode = 1; console.error(error.stack); if (page) await snapshot('failure').catch(() => {}); }
finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: process.exitCode !== 1, scenarios, requests, replies, blocked,
    method: 'Owned Chrome, two loopback origins, actual viewer API and SSE, synthetic data; no cloud or model calls' }, null, 2));
  if (routes) await routes.dispose(); if (browser) await browser.close();
  await gateway.close(); web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); store.close();
  assert.ok(resolve(profile).startsWith(output + sep)); rmSync(profile, { recursive: true, force: true });
}
