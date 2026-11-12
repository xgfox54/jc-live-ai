import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sourcePage, videoId } from './validate.mjs';

export function councilPage(value) {
  const url = new URL(sourcePage(value));
  if (url.hostname !== 'www.council.jeju.kr'
    || !['/broadcast/schedule.do', '/broadcast/broad.do'].includes(url.pathname)
    || url.searchParams.get('act') !== 'view' || !/^\d{1,8}$/.test(url.searchParams.get('seq') ?? '')) {
    throw new Error('Use the official council broadcast detail page');
  }
  return url.origin + url.pathname + '?act=view&seq=' + url.searchParams.get('seq');
}

export function parseCouncilPlayer(html) {
  html = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>/gi, '');
  const sources = [];
  // Only source/iframe attributes are considered; page scripts are never executed.
  for (const tag of html.match(/<(?:source|iframe)\b[^>]*>/gi) ?? []) {
    const attribute = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (!attribute) continue;
    let url;
    try { url = new URL(attribute[2].replaceAll('&amp;', '&')); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
    if (tag.toLowerCase().startsWith('<iframe') && url.hostname === 'www.youtube.com'
      && /^\/embed\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) {
      sources.push({ resolved_kind: 'youtube', video_id: videoId(url.href), media_url: null });
    }
    if (tag.toLowerCase().startsWith('<source') && url.hostname === 'vod.council.jeju.kr'
      && /^\/(?:live\/[A-Za-z0-9_-]+|vod\/_definst_\/\/?\d{4}\/\d{1,4}\/[A-Za-z0-9_-]+)\/playlist\.m3u8$/.test(url.pathname) && !url.search && !url.hash) {
      sources.push({ resolved_kind: 'hls', video_id: null, media_url: url.href });
    }
  }
  if (sources.length !== 1) throw new Error('Expected one supported official council player; use tab capture if unavailable');
  return sources[0];
}

export async function resolveCouncil(value, signal) {
  const url = councilPage(value);
  const signals = [AbortSignal.timeout(15000)]; if (signal) signals.push(signal);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any(signals) });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Official council page unavailable');
  const chunks = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; if (size > 262144) throw new Error('Official player page exceeds size limit');
    chunks.push(part);
  }
  return parseCouncilPlayer(Buffer.concat(chunks).toString('utf8'));
}

// Official council replay (다시보기) playlists only: HTTPS on the council VOD host without query, port or credentials.
const REPLAY_PATH = /^\/vod\/_definst_\/\/?\d{4}\/\d{1,4}\/[A-Za-z0-9_-]+\/playlist\.m3u8$/;
export function councilReplay(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'vod.council.jeju.kr' || url.port || url.username || url.password
    || url.search || url.hash || !REPLAY_PATH.test(url.pathname)) throw new Error('Unsupported council replay playlist');
  return url.href;
}
async function replayGet(url, signal, limit, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal });
  if (!response.ok) throw new Error('Replay request failed: ' + response.status);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; if (size > limit) throw new Error('Replay response exceeds size limit');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
// Every playlist entry must be a bare file name of the expected form, so requests stay in the replay's own directory.
function replayEntries(text, base, pattern) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    if (!pattern.test(line)) throw new Error('Unexpected replay playlist entry');
    return new URL(line, base);
  });
}
// Writes the audio-only rendition of a finished replay (concatenated AAC segments) to file.
export async function downloadReplayAudio(playlist, file, { signal, fetchImpl = fetch } = {}) {
  const master = new URL(councilReplay(playlist)); master.search = 'wowzaaudioonly';
  const lists = replayEntries((await replayGet(master, signal, 65536, fetchImpl)).toString('utf8'), master, /^chunklist_w\d+_ao\.m3u8$/);
  if (lists.length !== 1) throw new Error('Expected one audio-only replay playlist');
  const text = (await replayGet(lists[0], signal, 4_194_304, fetchImpl)).toString('utf8');
  if (!/^#EXT-X-ENDLIST\s*$/m.test(text)) throw new Error('Replay playlist is not complete');
  const segments = replayEntries(text, lists[0], /^media_w\d+_ao_\d+\.aac$/);
  if (!segments.length || segments.length > 6000) throw new Error('Unexpected replay length');
  const seconds = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  const handle = await open(file, 'w', 0o600); let bytes = 0;
  try {
    for (const url of segments) {
      let data;
      for (let attempt = 1; ; attempt++) {
        try { data = await replayGet(url, signal, 16_777_216, fetchImpl); break; }
        catch (error) {
          if (signal?.aborted || attempt === 3 || /size limit/.test(error.message)) throw error;
          await delay(attempt * 1000, undefined, { signal });
        }
      }
      bytes += data.length; if (bytes > 2_147_483_648) throw new Error('Replay audio exceeds size limit');
      await handle.write(data);
    }
  } finally { await handle.close(); }
  return { segments: segments.length, bytes, seconds: Math.round(seconds * 1000) / 1000 };
}
