import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { videoId } from './validate.mjs';
import { resolveCouncil } from './council.mjs';

export function youtubePhase(value) {
  switch (value) {
    case 'is_live': return 'live';
    case 'is_upcoming': return 'waiting';
    case 'was_live': case 'post_live': return 'ended';
    case 'not_live': return 'offline';
    // yt-dlp prints NA for removed or private videos.
    case null: case undefined: return 'offline';
    default: throw new Error('방송 상태를 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.');
  }
}
function probeYouTube(config, stream, signal) {
  const id = videoId(stream.page_url);
  if (!id || !stream.approved || !config.ytdlp) return Promise.reject(new Error('승인된 YouTube 방송 주소가 필요합니다.'));
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlp, ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-progress',
      '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0',
      '--js-runtimes', 'node:' + process.execPath, '--skip-download', '--no-wait-for-video',
      '--ignore-no-formats-error', '--no-check-formats', '--print', '{"id":%(id)j,"live_status":%(live_status)j}',
      'https://www.youtube.com/watch?v=' + id],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = ''; let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('방송 확인 시간이 초과됐습니다. 다음 확인 때 다시 시도합니다.')); }, 45000);
    child.stderr.resume();
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      if (output.length > 32768) { child.kill(); finish(new Error('방송 상태 응답이 너무 큽니다. 주소를 확인해 주세요.')); }
    });
    child.on('error', () => finish(new Error('방송 확인 도구를 실행하지 못했습니다. 서버 상태를 확인해 주세요.')));
    child.on('close', code => {
      if (code !== 0) { finish(new Error('방송 상태 조회에 실패했습니다. 다음 확인 때 다시 시도합니다.')); return; }
      try {
        const value = JSON.parse(output.trim().replace(/:NA(?=[,}])/g, ':null'));
        if (value.id !== id) throw new Error('등록한 영상과 응답 영상이 다릅니다. 주소를 확인해 주세요.');
        finish(null, { phase: youtubePhase(value.live_status), key: 'youtube:' + id });
      } catch (error) { finish(error); }
    });
  });
}
// The council's streaming server names the media playlist and its segments after the session of each request
// (chunklist_w1809214432.m3u8, media_w1809214432_1149.ts): a new name comes with every read of the master playlist.
// Samples are compared without that part. With it no two samples had the same key, every probe answered 'waiting' and
// no council HLS broadcast was collected (2026-11-26: six committee meetings in the afternoon, docs/AUTOMATION.md).
const withoutSession = value => value.replace(/_w[0-9]+(?=[_.])/g, '');
export function hlsSnapshot(body) {
  if (!body.trimStart().startsWith('#EXTM3U')) throw new Error('방송 재생 목록 형식을 확인해 주세요.');
  if (body.includes('#EXT-X-ENDLIST')) return { phase: 'ended' };
  if (!body.includes('#EXTINF:')) return { phase: 'waiting' };
  const timeline = body.split(/\r?\n/).filter(line => line && (!line.startsWith('#') || line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))).join('\n');
  return { phase: 'sample', fingerprint: createHash('sha256').update(withoutSession(timeline)).digest('hex') };
}
function playlistUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'vod.council.jeju.kr' || url.port || url.username || url.password
    || !/^\/live\/[A-Za-z0-9_/-]+\.m3u8$/.test(url.pathname) || url.search || url.hash)
    throw new Error('공식 생방송 재생 목록 주소가 필요합니다.');
  return url.href;
}
async function readPlaylist(value, signal) {
  const response = await fetch(playlistUrl(value), {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error('방송 재생 목록 조회에 실패했습니다. 다음 확인 때 다시 시도합니다.');
  const chunks = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; if (size > 262144) throw new Error('방송 재생 목록 크기가 제한을 넘었습니다.');
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function createLiveProbe(config) {
  const samples = new Map();
  return async (stream, signal) => {
    if (stream.kind === 'youtube') return { ...await probeYouTube(config, stream, signal), source: stream };
    const resolved = await resolveCouncil(stream.page_url, signal);
    const source = { ...stream, ...resolved };
    if (resolved.resolved_kind === 'youtube') {
      const result = await probeYouTube(config, { ...source, page_url: 'https://www.youtube.com/watch?v=' + resolved.video_id }, signal);
      return { ...result, source };
    }
    let url = playlistUrl(resolved.media_url); let body = await readPlaylist(url, signal);
    if (body?.includes('#EXT-X-STREAM-INF:')) {
      const variant = body.match(/#EXT-X-STREAM-INF:[^\r\n]*[\r\n]+([^\r\n#]+)/)?.[1]?.trim();
      if (!variant) throw new Error('방송 재생 목록의 영상 주소를 확인해 주세요.');
      url = playlistUrl(new URL(variant, url).href); body = await readPlaylist(url, signal);
    }
    const key = 'hls:' + withoutSession(url);
    if (body === null) { samples.delete(key); return { phase: 'offline', key, source }; }
    const sample = hlsSnapshot(body);
    if (sample.phase !== 'sample') { samples.delete(key); return { phase: sample.phase, key, source }; }
    const previous = samples.get(key); samples.set(key, sample.fingerprint);
    return { phase: previous && previous !== sample.fingerprint ? 'live' : 'waiting', key, source };
  };
}
