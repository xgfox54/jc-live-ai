import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';

const output = resolve(process.argv[4] ?? 'reports/parity-browser'); mkdirSync(output, { recursive: true });
const { omowright } = await (await import(pathToFileURL(process.argv[2]))).loadOmowright();
const profile = mkdtempSync(join(tmpdir(), 'jc-parity-browser-'));
const store = new Store(':memory:'); const config = { adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'),
  chunkSeconds: 5, queueChunks: 12, silenceRms: 0, minutesDirectory: join(output, 'minutes'), recordings: join(output, 'recordings') };
const engine = { ready: true, metadata: { fixture: true }, transcribe: async () => ({ spans: [], inference_ms: 0 }), stop: async () => {} };
const scheduler = new Scheduler(store, engine, config);
const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
const record = service.registry.upsert({ title: '전체 기록 검토 시험', kind: 'capture', page_url: 'local:qa', sources: [] });
const stream = { stream_id: 'ch1', name: record.title, broadcast_id: record.id, kind: 'capture', approved: true, page_url: '', video_id: null };
store.saveStream(stream); const state = scheduler.start(stream); service.registry.attach(stream, state);
const first = store.segment({ stream_id: 'ch1', session_id: state.session_id, timeline_epoch: 0, start_ms: 0, end_ms: 1000, raw_text: '오래된기록검색표지 예산 100원을 검토합니다.' });
store.correct(first.segment_id, { version: 1, origin: 'ai', text: '검토문검색표지 예산 100원을 검토합니다.' });
for (let i = 1; i <= 250; i++) { const row = store.segment({ stream_id: 'ch1', session_id: state.session_id, timeline_epoch: 0,
  start_ms: i * 1000, end_ms: (i + 1) * 1000, raw_text: i === 250 ? '<img src=x onerror="window.injected=true">' : '사업 계획의 검토와 주민 서비스 개선에 관한 발언 ' + i });
  store.correct(row.segment_id, { version: 1, origin: 'ai', text: row.raw_text }); }
scheduler.stop('ch1'); service.minutes.flush();
service.correctionAI.saveSettings({ model: 'fixture-only', provider: 'proxy', automatic: false });
service.correctionAI.models = async () => ({ models: ['fixture-only'], error: null });
service.correctionAI.requestText = async messages => { const parts = JSON.parse(messages.at(-1).content).segments;
  return JSON.stringify({ summary: [{ text: parts[0].text, source_id: parts[0].id, quote: parts[0].text }], decisions: [], proposals: [], actions: [], numbers: [], open_questions: [] }); };
const audioFolder = join(config.recordings, 'ch1', state.session_id); mkdirSync(audioFolder, { recursive: true });
writeFileSync(join(audioFolder, 'audio.pcm'), Buffer.alloc(32000 * 251));
writeFileSync(join(audioFolder, 'source.json'), JSON.stringify({ stream_id: 'ch1', session_id: state.session_id, format: 's16le', sample_rate: 16000, channels: 1 }));
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
let browser;
const result = { fixtures: 'synthetic transcripts and AI responses; real HTTP, persistence and Chrome UI', nativeEvidence: 'separate qa-feature-parity result', views: [] };
try {
  browser = await omowright.connectPipe({ browserPath: process.argv[3], browserArgs: ['--headless=new', '--no-first-run', '--disable-extensions', '--user-data-dir=' + profile], storageRoot: profile, dialogPolicy: { accept: true } });
  const page = await browser.newTab('http://127.0.0.1:' + service.server.address().port + '/admin');
  const ready = async (predicate, target = page) => { for (let i = 0; i < 160; i++) { if (await target.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Browser condition timed out'); };
  const click = async selector => { await page.snapshot(); await page.click(selector); };
  const fill = async (selector, value) => { await page.snapshot(); await page.fill(selector, value); };
  await ready(() => Boolean(document.querySelector('#login button'))); await fill('#token', config.adminToken); await click('#login button');
  await ready(() => !document.querySelector('#workspace').hidden); await click('[data-section=records]');
  await ready(() => document.querySelectorAll('#record-results .segment').length > 0);
  await fill('#record-query', '오래된기록검색표지'); await click('#record-search button');
  await ready(() => document.querySelector('#record-results').textContent.includes('검토문검색표지'));
  await page.snapshot(); await page.locator('#record-mode').selectOption('both');
  await ready(() => document.querySelector('#record-results').textContent.includes('원문: 오래된기록검색표지'));
  await click('#record-results .segment button'); await ready(() => document.querySelector('#workspace-audio').readyState >= 1);
  result.audioReplay = true; result.fullHistorySearch = true; result.originalAndReviewed = true;
  await click('#minutes-generate'); await ready(() => document.querySelector('#minutes-job').textContent.includes('완료'));
  await ready(() => document.querySelector('#structured-notes button'));
  await click('#structured-notes button'); await ready(() => document.querySelectorAll('#record-results .segment').length === 1);
  result.groundedSourceNavigation = true;
  const minutesPage = await browser.newTab('http://127.0.0.1:' + service.server.address().port + '/minutes');
  await ready(() => Boolean(document.querySelector('#minutes-detail button')), minutesPage);
  await minutesPage.snapshot(); await minutesPage.click('#minutes-detail button');
  assert.equal(await minutesPage.evaluate(() => document.querySelector('#minutes-detail details').open), true); result.publicMinutesSourceNavigation = true;
  writeFileSync(join(output, 'public-minutes.png'), await minutesPage.screenshot());
  await click('#minutes-edit'); await fill('#minutes-editor', '# 담당자 작성 회의록\n\n사업 검토 기록입니다.'); await click('#minutes-save');
  await ready(() => document.querySelector('#notice').textContent.includes('저장'));
  assert.equal(service.registry.minutes(record.id).markdown, '# 담당자 작성 회의록\n\n사업 검토 기록입니다.'); result.manualMinutesSaved = true;
  for (const preset of ['desktop-1440', 'ipad-air', 'iphone-14']) {
    await omowright.emulate(page, preset); await page.evaluate(() => window.scrollTo(0, 0));
    const metrics = await page.evaluate(() => ({ width: innerWidth, bodyWidth: document.documentElement.scrollWidth,
      xssExecuted: window.injected === true, injectedElements: document.querySelectorAll('.segment img').length }));
    assert.ok(metrics.bodyWidth <= metrics.width, JSON.stringify(metrics)); assert.equal(metrics.xssExecuted, false); assert.equal(metrics.injectedElements, 0);
    writeFileSync(join(output, preset + '.png'), await page.screenshot());
    await page.evaluate(() => document.querySelector('#structured-notes').scrollIntoView()); writeFileSync(join(output, preset + '-notes.png'), await page.screenshot());
    await page.evaluate(() => document.querySelector('#profile-name').scrollIntoView()); writeFileSync(join(output, preset + '-settings.png'), await page.screenshot());
    result.views.push({ preset, ...metrics });
  }
  await page.snapshot(); await page.locator('.display-size select').selectOption('125');
  assert.equal(await page.evaluate(() => document.documentElement.style.fontSize), '125%'); result.displayScale = true;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const viewer = await browser.newTab('http://127.0.0.1:' + service.server.address().port); await ready(() => document.querySelector('.channel-choice')?.disabled === false, viewer);
  await viewer.snapshot(); await viewer.click('.channel-choice');
  await viewer.snapshot(); await viewer.fill('.watch-panel input[type=search]', '검토문검색표지');
  await viewer.snapshot(); await viewer.click('.search-all');
  for (let i = 0; i < 100; i++) { if ((await viewer.evaluate(() => document.querySelector('.transcript').textContent)).includes('검토문검색표지')) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok((await viewer.evaluate(() => document.querySelector('.transcript').textContent)).includes('검토문검색표지')); result.viewerFullHistory = true;
  assert.equal(await viewer.evaluate(() => Boolean(document.querySelector('.text-mode'))), false);
  assert.equal(await viewer.evaluate(() => document.querySelector('.transcript').textContent.includes('오래된기록검색표지')), false);
  await click('#logout'); await ready(() => document.querySelector('#workspace').hidden); assert.equal(await page.evaluate(() => document.querySelector('#record-results').textContent), ''); result.logoutClearsRecords = true;
  result.passed = true; writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) { writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: error.message })); throw error; }
finally { if (browser) await browser.close(); await service.close(); await scheduler.close(); store.close(); rmSync(profile, { recursive: true, force: true }); }
