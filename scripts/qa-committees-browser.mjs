import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { committees } from '../public/committees.mjs';
import { initializeCommitteeChannels } from '../src/committees.mjs';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';

const output = resolve(process.argv[4] ?? 'reports/committee-browser'); mkdirSync(output, { recursive: true });
const { omowright } = await (await import(pathToFileURL(process.argv[2]))).loadOmowright();
const profile = mkdtempSync(join(tmpdir(), 'jc-committee-browser-'));
const store = new Store(':memory:'); initializeCommitteeChannels(store);
const config = { adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'), chunkSeconds: 5, queueChunks: 4, silenceRms: 0 };
const scheduler = new Scheduler(store, { ready: true, metadata: { fixture: true }, transcribe: async () => ({ spans: [], inference_ms: 0 }), stop: async () => {} }, config);
const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
const base = 'http://127.0.0.1:' + service.server.address().port;
const result = { fixture: 'Pending broadcasts; actual official roster and photos; real Chrome and HTTP', views: [] }; let browser;
try {
  browser = await omowright.connectPipe({ browserPath: process.argv[3], browserArgs: ['--headless=new', '--no-first-run', '--disable-extensions', '--user-data-dir=' + profile], storageRoot: profile });
  const page = await browser.newTab(base);
  const ready = async condition => { for (let i = 0; i < 200; i++) { if (await page.evaluate(condition)) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Browser condition timed out'); };
  const click = async selector => { await page.snapshot(); await page.click(selector); };
  await ready(() => document.querySelectorAll('.channel-choice:not(:disabled)').length === 12);
  const sid = await page.resolveSessionId();
  for (const [index, committee] of committees.entries()) {
    await click('.channel-choice:nth-child(' + (index + 1) + ')');
    await ready(() => document.querySelectorAll('.watch-panel').length === 1);
    const identity = await page.evaluate(() => ({ name: document.querySelector('.watch-panel h2').textContent,
      ids: [...document.querySelectorAll('.member-row')].map(row => row.dataset.member),
      names: [...document.querySelectorAll('.member-row a')].map(a => a.textContent) }));
    assert.equal(identity.name, committee.name); assert.deepEqual(identity.ids, committee.members.map(m => m.id)); assert.deepEqual(identity.names, committee.members.map(m => m.name));
    for (const device of ['desktop-1440', 'ipad-air', 'iphone-14']) {
      await omowright.emulate(page, device);
      for (const scheme of ['light', 'dark']) {
        await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sid);
        await page.evaluate(() => { document.querySelectorAll('.member-row img').forEach(img => img.loading = 'eager'); document.querySelector('.watch-panel').scrollIntoView(); });
        await ready(() => [...document.querySelectorAll('.member-row img')].every(img => img.complete && img.naturalWidth > 0));
        const view = await page.evaluate(() => {
          const aside = document.querySelector('.committee-members').getBoundingClientRect(), video = document.querySelector('.video-frame').getBoundingClientRect();
          return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
            left: aside.right <= video.left + 1, photos: [...document.querySelectorAll('.member-row img')].every(img => img.naturalWidth > 0),
            rows: document.querySelectorAll('.member-row').length, source: document.querySelector('.member-source').href };
        });
        assert.equal(view.overflow, false); assert.equal(view.photos, true); if (device === 'desktop-1440') assert.equal(view.left, true);
        const prefix = committee.stream_id + '-' + device + '-' + scheme;
        writeFileSync(join(output, prefix + '.png'), await page.screenshot());
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        writeFileSync(join(output, prefix + '-end.png'), await page.screenshot());
        result.views.push({ channel: committee.stream_id, device, scheme, ...view });
      }
    }
    await click('.watch-panel .close');
  }
  await omowright.emulate(page, 'desktop-1440'); await click('.channel-choice:nth-child(2)'); await click('.channel-choice:nth-child(9)');
  const dual = await page.evaluate(() => [...document.querySelectorAll('.watch-panel')].map(panel => ({ name: panel.querySelector('h2').textContent,
    left: panel.querySelector('.committee-members').getBoundingClientRect().right <= panel.querySelector('.video-frame').getBoundingClientRect().left + 1 })));
  assert.equal(dual.length, 2); assert.ok(dual.every(p => p.left)); result.dual = dual;
  await page.evaluate(() => document.querySelector('.watch-panel').scrollIntoView()); writeFileSync(join(output, 'dual-desktop.png'), await page.screenshot());
  await click('.channel-choice:nth-child(1)'); assert.equal(await page.evaluate(() => document.querySelectorAll('.watch-panel').length), 2); result.selectionLimit = true;
  await page.snapshot(); await page.locator('.committee-members summary').first().press('Enter');
  await ready(() => !document.querySelector('.committee-members details').open); result.keyboardCollapse = true;
  await page.goto(base + '/admin'); await ready(() => Boolean(document.querySelector('#token'))); await page.snapshot(); await page.fill('#token', config.adminToken); await click('#login button');
  await ready(() => !document.querySelector('#workspace').hidden);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#register-channel option').length), 12);
  await page.snapshot(); await page.locator('#register-channel').selectOption('ch12');
  assert.equal(await page.evaluate(() => document.querySelector('#register').elements.name.value), committees[11].name); result.adminFixedNames = true;
  writeFileSync(join(output, 'admin-desktop.png'), await page.screenshot());
  result.pass = true;
} finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close(); await scheduler.close(); await service.close(); store.close();
  if (!profile.startsWith(join(tmpdir(), 'jc-committee-browser-'))) throw new Error('Unexpected browser profile path');
  rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify({ pass: result.pass, views: result.views.length, dual: result.dual, keyboard: result.keyboardCollapse, admin: result.adminFixedNames }));
