import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { viewerRequest } from '../web/lib/http.mjs';
import { publicUpdate } from '../web/lib/model.mjs';
import { assets } from './build-web.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, '.omo/evidence/usage-browser-20261025'));
mkdirSync(output, { recursive: true });
const { loadOmowright } = await import('file:///C:/Users/USER/.codex/plugins/cache/sisyphuslabs/omo/5.1.40/skills/browser/scripts/omowright.mjs');
const { omowright } = await loadOmowright();
const id = 'b'.repeat(64); const now = Date.now();
const channels = Array.from({ length: 13 }, (_, i) => 'ch' + i);
const segment = stream_id => ({ stream_id, session_id: 'qa-session', segment_id: 'qa-' + stream_id,
  timeline_epoch: 0, sequence: 1, start_ms: 0, end_ms: 5000, audio_received_ms: now,
  version: 1, ai_corrected: true, text: '합성 ' + stream_id + ' 확인 발언입니다.' });
const draft = { ...segment('ch1'), ai_corrected: false, display_state: 'draft', text: '합성 1차 받아쓰기입니다.' };
const summary = { id, title: '합성 검증 회의록', status: 'draft', updated_ms: now, segment_count: 2,
  session_count: 1, publication_policy: 'ai-corrected-v1' };
const excerpts = ['합성 예산 검토 발언입니다.', '합성 급식 검토 발언입니다.'].map((text, index) => ({
  session_number: 1, epoch: 0, start_ms: index * 5000, end_ms: (index + 1) * 5000,
  text, ai_corrected: true, segment_id: 'archive-' + index }));
const archive = publicUpdate({ kind: 'minutes', published_ms: now, segments: [], document: { ...summary,
  sources: [], warnings: [], discussion: [], paragraphs: excerpts, transcript: excerpts, gaps: [],
  markdown: '# 합성 검증 회의록\n\n합성 예산 검토 발언입니다.\n합성 급식 검토 발언입니다.\n' } });
let site = publicUpdate({ kind: 'snapshot', published_ms: now - 3_600_000, minutes_index: [summary], snapshot: {
  event_id: 1, streams: channels.map(stream_id => ({ stream_id, name: stream_id, page_url: '' })),
  segments: channels.filter(value => value !== 'ch1').map(segment), live_policy: 'whisper-draft-v1',
  live_segments: [draft], live_pending: [{ stream_id: 'ch1', broadcast_id: null, complete: true, segment_ids: [draft.segment_id] }],
  states: [], gaps: [], before: {}, publication: { status: 'published', content_driven: true, active: false,
    last_published_ms: now - 3_600_000, stale_after_ms: 180_000 } } });
let revision = 1; const requests = []; const results = []; const blocked = [];
const storage = { read: async path => { await new Promise(resolve => setImmediate(resolve));
  return path === 'site.json' ? { value: site, etag: String(revision) }
    : path === 'minutes/' + id + '.json' ? { value: archive, etag: 'archive-v1' } : null; } };
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
let base;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'none'; connect-src 'self'");
    if (url.pathname.startsWith('/api/viewer/')) {
      const entry = { path: url.pathname + url.search, started_ms: Date.now(), method: req.method };
      requests.push(entry);
      const reply = await viewerRequest(new Request(url, { method: req.method, headers: req.headers }), { storage });
      const body = Buffer.from(await reply.arrayBuffer()); entry.status = reply.status; entry.bytes = body.length;
      if (reply.status === 200 && url.pathname.endsWith('/snapshot')) {
        const value = JSON.parse(body.toString()); entry.text_channels = [...new Set([...value.segments, ...value.live_segments].map(item => item.stream_id))];
      }
      res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(body); return;
    }
    if (url.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>합성 QA 보조 탭</title><p>탭 전환 확인용 화면입니다.</p>'); return; }
    const file = url.pathname === '/' ? 'index.html' : url.pathname === '/minutes' ? 'minutes.html' : url.pathname.slice(1);
    if (!assets.includes(file)) { res.writeHead(404); res.end(); return; }
    const suffix = file.slice(file.lastIndexOf('.')); res.writeHead(200, { 'Content-Type': types[suffix] ?? 'text/plain' });
    res.end(readFileSync(join(root, 'public', file)));
  } catch (error) { res.writeHead(500); res.end('Synthetic QA server failure'); console.error(error.message); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port;
const profile = mkdtempSync(join(output, 'browser-profile-'));
const downloadRelative = 'downloads/' + now; const downloads = join(output, downloadRelative); mkdirSync(downloads, { recursive: true });
let browser; let page; const routes = [];
async function until(probe, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out: ' + label);
}
async function snapshot(label) {
  const tree = omowright.compactSnapshot(await page.snapshot());
  writeFileSync(join(output, label + '.snapshot.txt'), typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2));
  return tree;
}
async function capture(label) { await snapshot(label); writeFileSync(join(output, label + '.png'), await page.screenshot({ fullPage: true })); }
async function click(selector) { await snapshot('before-action'); await page.locator(selector).click(); }
async function guard(target) {
  const intercept = omowright.createRoutes(target); routes.push(intercept);
  await intercept.route(() => true, route => {
    if (route.request.url.startsWith(base + '/')) return route.continue();
    blocked.push(route.request.url); return route.abort();
  });
}
const snapshotCount = () => requests.filter(value => value.path.startsWith('/api/viewer/snapshot')).length;
try {
  browser = await omowright.connectPipe({ browserPath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    browserArgs: ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-default-browser-check', '--user-data-dir=' + profile], storageRoot: profile, dialogPolicy: { accept: false } });
  page = await browser.newTab(base + '/blank'); await guard(page); await omowright.emulate(page, 'desktop-1440');
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await page.goto(base + '/');
  await until(() => page.evaluate(() => document.querySelectorAll('#channels button:not(:disabled)').length === 13), '13 selectable channels');
  await capture('01-initial-channels');
  const connection = await page.evaluate(() => document.querySelector('#connection').textContent);
  assert.match(connection, /^저장된 자료/); assert.doesNotMatch(connection, /지연/);
  assert.equal(requests.find(entry => entry.path.startsWith('/api/viewer/snapshot')).text_channels.length, 0);
  for (let index = 0; index < 13; index++) {
    await click('#channels button:nth-child(' + (index + 1) + ')');
    await until(() => page.evaluate(id => document.querySelector('.watch-panel')?.dataset.stream === id, channels[index]), 'channel ' + channels[index]);
    await click('#channels button:nth-child(' + (index + 1) + ')');
  }
  results.push({ scenario: 'all_13_channels_selectable', passed: true, count: 13, artifact: '01-initial-channels.png' });
  await click('#channels button:nth-child(2)'); await click('#channels button:nth-child(3)');
  await until(() => page.evaluate(() => document.querySelector('[data-stream="ch1"] .segment span')?.textContent === '합성 1차 받아쓰기입니다.'
    && document.querySelector('[data-stream="ch2"] .segment span')?.textContent === '합성 ch2 확인 발언입니다.'), 'two selected transcripts');
  await click('#channels button:nth-child(4)');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.watch-panel').length), 2);
  assert.match(await page.evaluate(() => document.querySelector('#notice').textContent), /2개까지/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 0);
  const selectedReply = requests.findLast(entry => entry.path.includes('text_streams=ch1%2Cch2') && entry.status === 200);
  assert.deepEqual(selectedReply.text_channels.sort(), ['ch1', 'ch2']);
  await capture('02-two-channels-draft');
  results.push({ scenario: 'two_channel_limit_and_text_selection', passed: true, text_channels: selectedReply.text_channels, artifact: '02-two-channels-draft.png' });
  site = structuredClone(site); const corrected = { ...segment('ch1'), version: 2, text: '합성 AI 후보정 문장입니다.', display_state: 'corrected' };
  site.snapshot.segments.push(corrected); site.snapshot.live_segments = [corrected]; site.snapshot.live_pending[0].segment_ids = [];
  site.snapshot.event_id++; revision++;
  await until(() => page.evaluate(() => document.querySelector('[data-stream="ch1"] .segment span')?.textContent === '합성 AI 후보정 문장입니다.'), 'draft replaced by correction');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-stream="ch1"] .segment').length), 1);
  assert.equal(await page.evaluate(() => document.querySelector('[data-stream="ch1"]').textContent.includes('합성 1차 받아쓰기입니다.')), false);
  await capture('03-corrected'); results.push({ scenario: 'draft_replaced_with_corrected_text', passed: true, rows: 1, artifact: '03-corrected.png' });
  const other = await browser.newTab(base + '/blank'); await guard(other);
  await page.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, await page.resolveSessionId());
  await other.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, await other.resolveSessionId());
  await other.cdp.send('Page.bringToFront', {}, await other.resolveSessionId());
  await until(() => page.evaluate(() => document.visibilityState === 'hidden'), 'real tab hidden');
  const hiddenStart = snapshotCount(); const hiddenAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 6500));
  assert.equal(snapshotCount(), hiddenStart);
  const visibleAt = Date.now(); await page.cdp.send('Page.bringToFront', {}, await page.resolveSessionId());
  await until(() => snapshotCount() > hiddenStart, 'immediate visible refresh', 2000);
  const resumed = requests.filter(value => value.path.startsWith('/api/viewer/snapshot')).at(-1);
  assert.ok(resumed.started_ms - visibleAt < 2000);
  await capture('04-visible-idle'); results.push({ scenario: 'real_hidden_tab_stops_polling_and_return_refreshes', passed: true,
    hidden_duration_ms: visibleAt - hiddenAt, hidden_snapshot_requests: 0, return_request_delay_ms: resumed.started_ms - visibleAt, artifact: '04-visible-idle.png' });
  results.push({ scenario: 'unchanged_idle_connection_message', passed: true, connection, artifact: '04-visible-idle.png' });
  await click('header a[href="/minutes"]');
  await until(() => page.evaluate(() => document.querySelector('#minutes-head h2')?.textContent === '합성 검증 회의록'), 'separate minutes page');
  await snapshot('minutes-before-search'); await page.locator('#transcript-search').fill('예산');
  await until(() => page.evaluate(() => [...document.querySelectorAll('#transcript-list .quote-block')].filter(node => !node.hidden).length === 1), 'minutes search');
  await capture('05-minutes-search');
  await click('a[download][href$=".md"]');
  await until(() => readdirSync(downloads).some(name => name.endsWith('.md')), 'Markdown download');
  const markdown = readdirSync(downloads).find(name => name.endsWith('.md'));
  assert.equal(readFileSync(join(downloads, markdown), 'utf8'), archive.document.markdown);
  await click('a[download][href$=".json"]');
  await until(() => readdirSync(downloads).some(name => name.endsWith('.json')), 'JSON download');
  const jsonFile = readdirSync(downloads).find(name => name.endsWith('.json'));
  assert.equal(JSON.parse(readFileSync(join(downloads, jsonFile), 'utf8')).title, summary.title);
  results.push({ scenario: 'separate_minutes_search_and_browser_downloads', passed: true, visible_search_results: 1,
    artifacts: ['05-minutes-search.png', downloadRelative + '/' + markdown, downloadRelative + '/' + jsonFile] });
  assert.equal(blocked.length, 0);
  console.log(JSON.stringify({ passed: true, scenarios: results.length, output }, null, 2));
} catch (error) {
  results.push({ scenario: 'execution_failure', passed: false, message: error.message });
  if (page) await capture('failure').catch(() => {});
  process.exitCode = 1; console.error(error.stack);
} finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: results.length > 0 && results.every(item => item.passed),
    invocation: 'node scripts/qa-usage-browser.mjs', method: 'Owned headless Chrome; actual public UI and viewerRequest; synthetic memory storage; no audio or AI inference',
    results, blocked_external_requests: blocked, requests,
    source_hashes: Object.fromEntries(['public/app.mjs','public/polling.mjs','web/lib/http.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(root,file))).digest('hex')])) }, null, 2));
  for (const route of routes) await route.dispose().catch(() => {});
  if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const target = resolve(profile); assert.ok(target.startsWith(resolve(output) + sep)); rmSync(target, { recursive: true, force: true });
}
