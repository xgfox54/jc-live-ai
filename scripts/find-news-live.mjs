import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const run = promisify(execFile);
const config = JSON.parse(await readFile('config.local.json', 'utf8'));
const directory = resolve(process.argv[2] ?? 'reports/live-diarization-20261021');
await mkdir(directory, { recursive: true });
const candidates = [['YTN', '@ytnnews24'], ['연합뉴스TV', '@yonhapnewstv23'], ['KBS News', '@KBSNews'],
  ['SBS 뉴스', '@SBSnews8'], ['MBCNEWS', '@MBCNEWS11'], ['JTBC News', '@JTBCNews'],
  ['MBN', '@MBN'], ['채널A News', '@ChannelA-News'], ['TVCHOSUN', '@TVCHOSUNNEWS'], ['SBS Biz', 'c/SBSBiz%EB%89%B4%EC%8A%A42021']];
const common = ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--encoding', 'utf-8',
  '--js-runtimes', 'node:' + process.execPath, '--socket-timeout', '15', '--retries', '1'];
const previous = await readFile(directory + '/news-sources.json', 'utf8').then(JSON.parse).catch(() => ({ sources: [], attempts: [] }));
const attempts = previous.attempts; const sources = previous.sources;
for (const [name, handle] of candidates) {
  if (sources.length === 8) break;
  if (sources.some(source => source.name === name)) continue;
  const page = 'https://www.youtube.com/' + handle + '/streams';
  try {
    const result = await run(resolve(config.ytdlp), [...common, '--flat-playlist', '--playlist-end', '12', '--dump-single-json', page],
      { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const listing = JSON.parse(result.stdout);
    const live = listing.entries?.find(entry => entry.live_status === 'is_live');
    if (!live || !/^[A-Za-z0-9_-]{11}$/.test(live.id)) { attempts.push({ name, page, status: 'no_live_entry' }); continue; }
    const url = 'https://www.youtube.com/watch?v=' + live.id;
    const metadata = await run(resolve(config.ytdlp), [...common, '--no-playlist', '--skip-download', '--dump-single-json', url],
      { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(metadata.stdout);
    if (info.live_status !== 'is_live' || info.channel_id !== listing.channel_id || info.channel_is_verified === false
      || sources.some(source => source.channel_id === info.channel_id)) throw new Error('Live source identity verification failed');
    sources.push({ name, handle, page_url: url, video_id: info.id, channel_id: info.channel_id,
      channel: info.channel, channel_url: info.channel_url, channel_is_verified: info.channel_is_verified ?? null,
      title: info.title, live_status: info.live_status, checked_at: new Date().toISOString(),
      approved: true, approval_note: '사용자가 한국 뉴스 공식 채널 8개의 생방송 수집·전사·화자분리 시험을 요청함' });
    attempts.push({ name, page, status: 'verified_live' });
  } catch (error) { attempts.push({ name, page, status: 'failed', error: error.killed ? 'deadline' : 'metadata lookup failed' }); }
  await writeFile(directory + '/news-sources.json', JSON.stringify({ checked_at: new Date().toISOString(), sources, attempts }, null, 2));
  console.log(JSON.stringify({ name, found: sources.length, status: attempts.at(-1).status }));
}
await writeFile(directory + '/news-sources.json', JSON.stringify({ checked_at: new Date().toISOString(), sources, attempts }, null, 2));
if (sources.length !== 8) process.exitCode = 1;
