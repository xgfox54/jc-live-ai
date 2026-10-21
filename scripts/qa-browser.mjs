import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';

const skill = process.argv[2]; const browserPath = process.argv[3];
const output = resolve(process.argv[4] ?? 'reports/browser'); mkdirSync(output, { recursive: true });
const { omowright } = await (await import(pathToFileURL(skill))).loadOmowright();
const profile = mkdtempSync(join(tmpdir(), 'jc-live-qa-'));
const store = new Store(':memory:');
const config = { adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'),
  chunkSeconds: 5, queueChunks: 12, silenceRms: 0 };
const engine = { ready: true, metadata: { qa_only: true }, stop: async () => {},
  transcribe: async () => ({ spans: [], inference_ms: 0 }) };
const scheduler = new Scheduler(store, engine, config);
for (let i = 1; i <= 8; i++) {
  const stream = { stream_id: 'ch' + i, name: '합성 시험 방송 ' + i, kind: 'capture',
    page_url: 'https://www.council.jeju.kr/broadcast/index.do', video_id: null, approved: true, approval_note: 'QA fixture' };
  store.saveStream(stream); const session = scheduler.start(stream);
  for (let n = 0; n < 6; n++) store.segment({ stream_id: stream.stream_id, session_id: session.session_id,
    timeline_epoch: 0, start_ms: n * 5000, end_ms: (n + 1) * 5000,
    raw_text: n === 5 ? '<img src=x onerror="window.xssExecuted=true">' : '지역 주민의 돌봄 서비스와 사업별 집행 현황을 확인합니다. 이 문장은 화면 검증용 합성 자료입니다.' });
}
const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
let browser;
try {
  browser = await omowright.connectPipe({ browserPath,
    browserArgs: ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--user-data-dir=' + profile],
    storageRoot: profile, dialogPolicy: { accept: true } });
  const page = await browser.newTab('http://127.0.0.1:' + service.server.address().port);
  await page.fill('#token', config.adminToken); await page.click('#login button');
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) { if (await page.evaluate(predicate)) return; await new Promise(r => setTimeout(r, 50)); }
    writeFileSync(output + '/failure.png', await page.screenshot());
    console.error(JSON.stringify(await page.evaluate(() => ({ title: document.title, body: document.body.innerText,
      panels: document.querySelectorAll('.channel').length, segments: document.querySelectorAll('.segment').length }))));
    throw new Error('Browser readiness timed out');
  };
  await waitFor(() => document.querySelectorAll('.segment').length === 48);
  const result = { fixtures: 'synthetic events; actual HTTP, authentication and browser DOM', views: [] };
  for (const preset of ['desktop-1440', 'iphone-14']) {
    await omowright.emulate(page, preset);
    await page.evaluate(() => window.scrollTo(0, 0));
    const metrics = await page.evaluate(() => ({
      title: document.title, brand: document.querySelector('.brand img')?.alt,
      width: innerWidth, bodyWidth: document.documentElement.scrollWidth,
      panels: document.querySelectorAll('.channel').length, segments: document.querySelectorAll('.segment').length,
      xssExecuted: window.xssExecuted === true, scriptImages: document.querySelectorAll('.segment img').length,
      tokenEmpty: document.querySelector('#token').value.length === 0
    }));
    if (metrics.brand !== 'JC-LIVE' || !metrics.title.startsWith('JC-LIVE')
      || metrics.bodyWidth > metrics.width || metrics.xssExecuted || metrics.scriptImages || metrics.panels !== 8)
      throw new Error('Browser layout or XSS check failed: ' + JSON.stringify(metrics));
    writeFileSync(output + '/' + preset + '.png', await page.screenshot());
    await page.evaluate(() => document.querySelector('#channels').scrollIntoView());
    writeFileSync(output + '/' + preset + '-channels.png', await page.screenshot());
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    writeFileSync(output + '/' + preset + '-end.png', await page.screenshot());
    result.views.push({ preset, ...metrics });
  }
  await page.click('#synced');
  const hidden = await page.evaluate(() => document.querySelector('.channel .transcript').querySelectorAll('.segment').length);
  if (hidden !== 0) throw new Error('Unverified synchronized mode exposed captions');
  await page.click('#synced');
  await page.fill('#search', 'no-match-marker');
  const searchCount = await page.evaluate(() => document.querySelectorAll('.segment').length);
  if (searchCount !== 0) throw new Error('Search failed');
  await page.fill('#search', '');
  const first = store.snapshot(['ch1']).segments[0];
  store.correct(first.segment_id, { version: 1, text: 'QA correction delivered through SSE' });
  await waitFor(() => document.querySelector('.segment').textContent.includes('v2'));
  result.search = true; result.futureCaptionsHidden = true; result.liveCorrection = true;
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await scheduler.close(); await service.close(); store.close(); rmSync(profile, { recursive: true, force: true });
}
