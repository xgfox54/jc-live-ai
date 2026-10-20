import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';
const id = process.argv[4];
if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw Error('A verified official live video ID is required');
const output = resolve('reports/live-player-' + id); mkdirSync(output, { recursive: true });
const { omowright } = await (await import(pathToFileURL(process.argv[2]))).loadOmowright();
const profile = mkdtempSync(join(tmpdir(), 'sr-live-player-'));
const store = new Store(':memory:');
const scheduler = new Scheduler(store, { ready: true, stop: async () => {} }, {});
const service = createService({ store, scheduler, config: {}, inputs: {} });
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
let browser;
try {
  browser = await omowright.connectPipe({ browserPath: process.argv[3], browserArgs: [
    '--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile], storageRoot: profile });
  const page = await browser.newTab('http://127.0.0.1:' + service.server.address().port + '?video=' + id);
  await page.evaluate(async () => {
    const { OfficialPlayer } = await import('/player.mjs');
    globalThis.messages = [];
    globalThis.probe = new OfficialPlayer(document.querySelector('#player'), value => messages.push(value));
    await probe.select({ video_id: new URL(location.href).searchParams.get('video'), stream_id: 'ch1' });
  });
  for (let n = 0; n < 100; n++) {
    if (await page.evaluate(() => typeof probe.player?.getPlayerState === 'function')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await page.evaluate(() => { probe.player.mute(); probe.player.playVideo(); });
  await new Promise(resolve => setTimeout(resolve, 8000));
  const read = () => page.evaluate(() => ({ state: probe.player.getPlayerState(),
    current: probe.player.getCurrentTime(), duration: probe.player.getDuration(), messages,
    captured_ms: Date.now() }));
  const before = await read();
  await page.evaluate(() => {
    globalThis.seekTarget = Math.max(0, probe.player.getCurrentTime() - 30);
    globalThis.seekWall = Date.now(); probe.player.seekTo(seekTarget, true);
  });
  await new Promise(resolve => setTimeout(resolve, 5000));
  const after = await read();
  const target = await page.evaluate(() => ({ seconds: seekTarget, at_ms: seekWall }));
  const elapsed = (after.captured_ms - target.at_ms) / 1000;
  const error = Math.abs(after.current - (target.seconds + elapsed));
  const result = { source: 'https://www.youtube.com/watch?v=' + id, checked_at: new Date().toISOString(),
    source_type: 'official council scheduled live iframe; read-only playback probe', before, target, after,
    seek_30s_back_observed: before.current >= 30 && before.state === 1 && after.state === 1 && error <= 2,
    seek_progress_error_s: error, live_reference: 'playback position observed after starting official player; exact live edge unverified',
    audio_video_alignment: 'not verified; no shared audio/video PTS', audio_recorded: false };
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2));
  writeFileSync(output + '/player.png', await page.screenshot());
  console.log(JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await scheduler.close(); await service.close(); store.close();
  rmSync(profile, { recursive: true, force: true });
}
