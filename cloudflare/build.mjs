import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from '../scripts/build-web.mjs';
import { applyLiveTransport } from '../web/deployment/live-transport.mjs';

export async function buildCloudflare({ directory = fileURLToPath(new URL('./public/', import.meta.url)),
  desktopOrigin = process.env.JC_LIVE_DESKTOP_ORIGIN } = {}) {
  if (!desktopOrigin) throw new Error('An explicit desktop HTTPS origin is required');
  const config = JSON.parse(await readFile(new URL('../web/vercel.json', import.meta.url), 'utf8'));
  const { source, transport } = applyLiveTransport(config, desktopOrigin);
  await mkdir(directory, { recursive: true });
  // Generated metadata is rewritten after the strict source allowlist copy.
  const { readdir, unlink } = await import('node:fs/promises');
  for (const name of ['_headers', '404.html']) if ((await readdir(directory)).includes(name)) await unlink(resolve(directory, name));
  const assets = await buildWeb(directory);
  const globalHeaders = Object.fromEntries(source.headers[0].headers.map(h => [h.key, h.value]));
  delete globalHeaders['Cache-Control'];
  const rules = ['/*', ...Object.entries(globalHeaders).map(([key, value]) => `  ${key}: ${value}`)];
  for (const path of ['/', '/minutes', ...assets.map(name => '/' + name)]) {
    const longCache = /\.(?:ttf|woff2|png)$/.test(path);
    rules.push(path, '  ! Cache-Control', '  Cache-Control: ' + (longCache ? 'public, max-age=86400' : 'no-cache, must-revalidate'));
  }
  await writeFile(resolve(directory, '_headers'), rules.join('\n') + '\n');
  await writeFile(resolve(directory, 'live-transport.json'), JSON.stringify({ ...transport, recovery_interval_ms: 120000 }) + '\n');
  await writeFile(resolve(directory, '404.html'), '<!doctype html><html lang="ko"><meta charset="utf-8"><title>페이지를 찾지 못했습니다</title><p>페이지를 찾지 못했습니다. <a href="/">방송 화면으로 이동</a></p></html>');
  return { publicAssets: assets.length, adminAssets: 0, desktopOrigin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildCloudflare()));
