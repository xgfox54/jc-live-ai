import { mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { committees } from '../public/committees.mjs';

export const assets = ['index.html', 'app.mjs', 'style.css', 'player.mjs', 'sync.mjs', 'client-state.mjs', 'subscription.mjs', 'live-transport.mjs', 'live-transport.json',
  'viewer-stage.mjs', 'transcripts.mjs', 'selection.mjs', 'icon-192.png', 'logo-jc-live.png', 'minutes.html', 'minutes.mjs', 'polling.mjs', 'display.mjs',
  'JejuGothic-Regular.ttf', 'Pretendard-SemiBold.woff2', 'JejuGothic-OFL.txt', 'Pretendard-OFL.txt', 'speakers.mjs',
  'committees.mjs', 'committee-members.mjs', 'keyword-alerts.mjs', 'hls.light.min.mjs', 'HLSJS-LICENSE.txt',
  ...new Set(committees.flatMap(c => c.members.map(m => m.photo.slice(1))))];
export async function buildWeb(target = new URL('../web/public/', import.meta.url)) {
  const path = target instanceof URL ? fileURLToPath(target) : resolve(target);
  await mkdir(path, { recursive: true });
  const existing = await readdir(path);
  if (existing.some(name => !assets.includes(name))) throw new Error('Unexpected file in web output; review it before deployment');
  for (const name of assets) await copyFile(new URL('../public/' + name, import.meta.url), resolve(path, name));
  if (path === fileURLToPath(new URL('../web/public/', import.meta.url)))
    await writeFile(new URL('../web/deployment/public-assets.json', import.meta.url), JSON.stringify(assets) + '\n');
  return assets;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify({ publicAssets: (await buildWeb()).length, adminAssets: 0, runtimeFiles: 0 }));
