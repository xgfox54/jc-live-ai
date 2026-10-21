import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';
import { initializeCommitteeChannels } from '../src/committees.mjs';

const output = resolve(process.argv[4] ?? 'reports/published-browser'); mkdirSync(output, { recursive: true });
const { omowright } = await (await import(pathToFileURL(process.argv[2]))).loadOmowright();
const profile = mkdtempSync(join(tmpdir(), 'jc-published-browser-')); const store = new Store(':memory:'); initializeCommitteeChannels(store);
const config = { adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'), chunkSeconds: 5, queueChunks: 4, silenceRms: 0,
  minutesDirectory: join(output, 'minutes') };
const scheduler = new Scheduler(store, { ready: true, stop: async () => {} }, config);
const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
const stream = { stream_id: 'ch4', name: '미래경제산업위원회', kind: 'capture', approved: true, page_url: '', video_id: null };
store.saveStream(stream); store.saveSession({ stream_id: 'ch4', session_id: 'public-qa', state: 'stopped' });
const id = service.minutes.attach(stream, { session_id: 'public-qa' });
const source = '원문비공개표지 돌봄 써비스 예산은 100원입니다.';
const corrected = '후보정공개표지 돌봄 서비스 예산은 100원입니다.';
store.segment({ stream_id: 'ch4', session_id: 'public-qa', timeline_epoch: 0, start_ms: 0, end_ms: 5000, raw_text: source });
service.minutes.flush(); service.correctionAI.saveSettings({ model: 'fixture-only', automatic: false });
service.correctionAI.fetcher = async url => { assert.ok(url.endsWith('/api/show')); return Response.json({}); };
service.correctionAI.requestText = async messages => JSON.stringify({ corrections: JSON.parse(messages.at(-1).content).segments.map(part => ({ id: part.id, text: corrected })) });
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); const base = 'http://127.0.0.1:' + service.server.address().port;
const headers = { Authorization: 'Bearer ' + config.adminToken, 'Content-Type': 'application/json' };
const post = async (route, body) => { const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
let browser; const result = { fixture: 'AI response stub; real candidate generation/apply, HTTP, SQLite, SSE and Chrome', views: [] };
try {
  browser = await omowright.connectPipe({ browserPath: process.argv[3], browserArgs: ['--headless=new', '--no-first-run', '--disable-extensions', '--user-data-dir=' + profile], storageRoot: profile });
  const page = await browser.newTab(base);
  const ready = async predicate => { for (let i = 0; i < 200; i++) { if (await page.evaluate(predicate)) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Browser state timed out'); };
  const click = async selector => { await page.snapshot(); await page.click(selector); };
  await ready(() => document.querySelectorAll('.channel-choice').length === 12); await click('.channel-choice:nth-child(4)');
  await ready(() => document.querySelector('.transcript')?.textContent.includes('AI 후보정이 완료된 문장을 기다립니다.'));
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.text-mode'))), false);
  assert.equal(await page.evaluate(() => document.body.textContent.includes('원문비공개표지')), false);
  await omowright.emulate(page, 'desktop-1440'); await page.evaluate(() => document.querySelector('.watch-panel').scrollIntoView());
  writeFileSync(join(output, 'waiting-desktop.png'), await page.screenshot()); result.waitingWithoutRaw = true;
  await post('/api/admin/ai/start', { broadcast_id: id }); await service.correctionAI.pending;
  const candidate = service.correctionAI.list(id).items[0]; assert.ok(candidate, JSON.stringify(service.correctionAI.jobs())); assert.equal(candidate.status, 'pending');
  const before = await (await fetch(base + '/api/viewer/snapshot')).text(); assert.doesNotMatch(before, /원문비공개표지|후보정공개표지|raw_text/);
  result.unappliedCandidateHidden = true;
  await post('/api/admin/ai/apply', { id: candidate.id });
  await ready(() => document.querySelector('.transcript')?.textContent.includes('후보정공개표지'));
  assert.equal(await page.evaluate(() => document.body.textContent.includes('원문비공개표지')), false); result.correctedArrivedBySSE = true;
  for (const device of ['desktop-1440', 'ipad-air', 'iphone-14']) {
    await omowright.emulate(page, device); await page.evaluate(() => document.querySelector('.transcript-controls').scrollIntoView());
    const view = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      hasMode: Boolean(document.querySelector('.text-mode')), rawVisible: document.body.textContent.includes('원문비공개표지'),
      correctedVisible: document.querySelector('.transcript').textContent.includes('후보정공개표지') }));
    assert.equal(view.overflow, false); assert.equal(view.hasMode, false); assert.equal(view.rawVisible, false); assert.equal(view.correctedVisible, true);
    writeFileSync(join(output, device + '.png'), await page.screenshot()); result.views.push({ device, ...view });
  }
  await page.snapshot(); await page.fill('.watch-panel input[type=search]', '원문비공개표지'); await click('.search-all');
  await ready(() => document.querySelector('.transcript').textContent.includes('검색한 문장이 없습니다.')); result.rawSearchHidden = true;
  service.minutes.flush();
  for (const route of ['/api/viewer/snapshot', '/api/viewer/segments?stream=ch4', '/api/viewer/minutes/' + id + '.json', '/api/viewer/minutes/' + id + '.md']) {
    const body = await (await fetch(base + route)).text(); assert.match(body, /후보정공개표지/); assert.doesNotMatch(body, /원문비공개표지|raw_text|corrected_text/);
  }
  const admin = await (await fetch(base + '/api/snapshot', { headers })).text(); assert.match(admin, /원문비공개표지/); result.adminRawPreserved = true;
  await page.goto(base + '/minutes'); await ready(() => document.querySelector('#minutes-detail')?.textContent.includes('후보정공개표지'));
  assert.equal(await page.evaluate(() => document.body.textContent.includes('원문비공개표지')), false);
  writeFileSync(join(output, 'public-minutes.png'), await page.screenshot()); result.minutesAndDownloadsCorrectedOnly = true; result.pass = true;
} finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close(); await scheduler.close(); await service.close(); store.close();
  if (!profile.startsWith(join(tmpdir(), 'jc-published-browser-'))) throw new Error('Unexpected profile path'); rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
