import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { videoId } from './validate.mjs';

export async function validateMediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !url.hostname.endsWith('.googlevideo.com')) throw new Error('Unapproved media host');
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => {
    const [a,b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  })) throw new Error('Media host must resolve to public IPv4');
  return url.href;
}

export function resolveYouTube(config, stream, signal) {
  const id = videoId(stream.page_url);
  if (!id || !stream.approved || !config.ytdlp) return Promise.reject(new Error('Approved YouTube input required'));
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlp, ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-progress',
      '--socket-timeout', '15', '--retries', '1', '--js-runtimes', 'node:' + process.execPath,
      '--skip-download', '-f', 'bestaudio', '--get-url', 'https://www.youtube.com/watch?v=' + id],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = ''; let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('YouTube source resolution timed out')); }, 60000);
    child.stderr.resume();
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      if (output.length > 32768) { child.kill(); finish(new Error('Source response too large')); }
    });
    child.on('error', () => finish(new Error(signal?.aborted ? 'Source resolution cancelled' : 'YouTube resolver unavailable')));
    child.on('close', code => {
      if (code !== 0) { finish(new Error('Public YouTube audio unavailable; verify playback and source permissions')); return; }
      const lines = output.trim().split(/\r?\n/);
      if (lines.length !== 1) { finish(new Error('Expected one audio source')); return; }
      validateMediaUrl(lines[0]).then(value => finish(null, value), error => finish(error));
    });
  });
}
