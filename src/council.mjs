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
      && /^\/live\/[A-Za-z0-9_-]+\/playlist\.m3u8$/.test(url.pathname) && !url.search && !url.hash) {
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
