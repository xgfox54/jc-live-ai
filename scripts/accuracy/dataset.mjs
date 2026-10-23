// Builds an accuracy set from official Jeju council video minutes: aligned minutes text + the same span of official VOD audio.
// Usage: node scripts/accuracy/dataset.mjs <out-dir> <fidx,fidx,...>
import { mkdir, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { referenceText } from './metrics.mjs';

const [out, list] = process.argv.slice(2);
if (!out || !list) throw new Error('usage: dataset.mjs <out-dir> <fidx,...>');
const MIN_S = 480; const MAX_S = 900;
const decode = buffer => new TextDecoder('euc-kr').decode(buffer);
const entities = text => text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

async function page(fidx) {
  const response = await fetch('https://record.council.jeju.kr/source/view/video.html?fidx=' + fidx + '&pos=1&angun=0',
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const html = decode(Buffer.from(await response.arrayBuffer()));
  const title = html.match(/<div class="head">\s*<h1[\s\S]*?<\/h1>\s*<p>([\s\S]*?)<\/p>/)?.[1].replace(/\s+/g, ' ').trim();
  const media = html.match(/src="(https:\/\/vod\.council\.jeju\.kr\/[^"]+\.m3u8)"/)?.[1];
  const records = [...html.matchAll(/<div id='record(\d+)'[^>]*data-second='(\d+)'>([\s\S]*?)<\/div>/g)].map(m => ({
    index: Number(m[1]), second: Number(m[2]),
    text: entities(m[3].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')) }));
  if (!title || !media || records.length < 3) throw new Error('minutes or media missing');
  if (new URL(media).hostname !== 'vod.council.jeju.kr') throw new Error('unexpected media host');
  return { title, media, records };
}

function choose(records) {
  const spans = [];
  for (let a = 1; a < records.length - 1; a++) for (let b = a; b < records.length - 1; b++) {
    const duration = records[b + 1].second - records[a].second;
    if (duration > MAX_S) break;
    if (duration >= MIN_S) { spans.push({ a, b, duration }); break; }
  }
  if (!spans.length) return null;
  const target = records.length * 0.3;
  return spans.sort((x, y) => Math.abs(x.a - target) - Math.abs(y.a - target))[0];
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('bin/ffmpeg.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + error)));
  });
}

await mkdir(out, { recursive: true });
const manifest = [];
for (const fidx of list.split(',').map(Number)) {
  try {
    const { title, media, records } = await page(fidx);
    const span = choose(records);
    if (!span) { console.log(JSON.stringify({ fidx, skipped: 'no ' + MIN_S + '-' + MAX_S + 's span' })); continue; }
    const start = records[span.a].second; const end = records[span.b + 1].second;
    const pcm = join(out, fidx + '.pcm');
    try { await access(pcm); } catch {
      await ffmpeg(['-nostdin', '-loglevel', 'error', '-ss', String(start), '-i', media, '-t', String(end - start),
        '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', pcm + '.part']);
      await import('node:fs/promises').then(fs => fs.rename(pcm + '.part', pcm));
    }
    const minutes = records.slice(span.a, span.b + 1).map(record => record.text).join('\n');
    const item = { fidx, title, media, start_s: start, end_s: end, records: span.b - span.a + 1, pcm: fidx + '.pcm',
      minutes, reference: referenceText(minutes) };
    manifest.push(item);
    console.log(JSON.stringify({ fidx, title, start, end, chars: item.reference.length }));
  } catch (error) { console.log(JSON.stringify({ fidx, error: error.message })); }
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

