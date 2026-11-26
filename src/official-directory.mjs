import { spawn } from 'node:child_process';
import { councilPage, parseCouncilPlayer } from './council.mjs';

export const CHANNEL = 'UChRn5ybNcNv55_x9QGW-xXg';
export const DIRECTORY_URLS = ['https://www.council.jeju.kr/broadcast/index.do', 'https://www.council.jeju.kr/broadcast/schedule.do'];
// Comments and scripts can hold markup that looks like list rows, so the list parsers read the page without them.
export const withoutScripts = html => html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>/gi, '');
export function plain(value) {
  return value.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/[ \t]+/g, ' ').trim();
}
export async function councilHtml(url, signal) {
  const target = new URL(url);
  if (target.origin !== 'https://www.council.jeju.kr' || !/^\/broadcast\/(?:index|schedule|broad)\.do$/.test(target.pathname))
    throw new Error('공식 방송 목록·상세 주소만 조회합니다.');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('의회 방송 페이지 조회에 실패했습니다.');
  let size = 0; const parts = [];
  for await (const part of response.body) {
    size += part.length; if (size > 1048576) throw new Error('의회 방송 페이지 크기 제한을 넘었습니다.');
    parts.push(part);
  }
  const html = Buffer.concat(parts).toString('utf8');
  if (/contrary to the Web firewall|security policies have been blocked/i.test(html)) throw new Error('의회 홈페이지에서 조회를 차단했습니다.');
  return html;
}
export function parseCouncilDirectory(html) {
  const clean = withoutScripts(html);
  const items = new Map();
  for (const block of clean.match(/<(?:p|tr)\b[^>]*>[\s\S]*?<\/(?:p|tr)>/gi) ?? []) {
    const link = block.match(/<a\b[^>]*href\s*=\s*["']([^"']*schedule\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let url; try { url = new URL(link[1].replace(/;jsessionid=[^?"]+/i, '').replaceAll('&amp;', '&'), DIRECTORY_URLS[0]); url = councilPage(url.href); }
    catch { continue; }
    const text = plain(block); const title = plain(link[2]).slice(0, 300);
    if (!title || /방송종료/.test(text)) continue;
    const phase = /방송중|생방송중|방송 중/.test(text) ? 'live' : 'waiting';
    // A meeting in recess stays on air as '정회중'; the scheduler recognizes only clear sound while it lasts.
    items.set(url, { page_url: url, title, phase, recess: /정회/.test(text), sources: [url], discovered_from: 'council' });
  }
  if (!/<(?:html|body)\b/i.test(clean) || !/생방송/.test(plain(clean))) throw new Error('의회 방송 목록 형식을 확인해 주세요.');
  return [...items.values()];
}
export function councilMetadata(html) {
  const field = label => plain(html.match(new RegExp('<b>\\s*' + label + '\\s*:?\\s*</b>([\\s\\S]*?)</li>', 'i'))?.[1] ?? '').slice(0, 300);
  return { scheduled_at: field('일시'), meeting_round: field('회차'), meeting_type: field('회의'), committee: field('소관'),
    agenda: plain(html.match(/<b>\s*심의안건\s*<\/b>[\s\S]*?<div\b[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '').slice(0, 30000) };
}
export async function councilCandidate(item, signal) {
  const html = await councilHtml(item.page_url, signal);
  const metadata = councilMetadata(html);
  let source = {}; try { source = parseCouncilPlayer(html); } catch { /* The official player may be published after the schedule. */ }
  return { ...item, ...metadata, ...source, kind: 'council', video_id: source.video_id ?? null };
}
export function parseYouTubeDirectory(data) {
  if (data.channel_id !== CHANNEL && data.id !== CHANNEL) throw new Error('제주특별자치도의회 공식 생방송 채널 응답이 아닙니다.');
  if (!Array.isArray(data.entries) || data.entries.length > 100) throw new Error('YouTube 방송 목록 형식을 확인해 주세요.');
  return data.entries.filter(item => ['is_live', 'is_upcoming'].includes(item.live_status)).map(item => {
    if (item.channel_id && item.channel_id !== CHANNEL) throw new Error('공식 채널 소유의 방송만 수집합니다.');
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.id)) throw new Error('YouTube 영상 식별값이 올바르지 않습니다.');
    const url = 'https://www.youtube.com/watch?v=' + item.id;
    return { video_id: item.id, page_url: url, title: String(item.title ?? '제주특별자치도의회 생방송').slice(0, 300),
      phase: item.live_status === 'is_live' ? 'live' : 'waiting', kind: 'youtube', sources: [url],
      scheduled_at: Number.isFinite(item.release_timestamp) ? new Date(item.release_timestamp * 1000).toISOString() : '', discovered_from: 'youtube' };
  });
}
export function youtubeDirectory(config, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlp, ['--ignore-config', '--no-plugin-dirs', '--flat-playlist', '--playlist-end', '40',
      '--skip-download', '--dump-single-json', '--socket-timeout', '10', '--retries', '0',
      'https://www.youtube.com/channel/' + CHANNEL + '/streams'],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = ''; let errors = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('YouTube 방송 목록 조회 시간이 초과됐습니다.')); }, 45000);
    child.stderr.on('data', part => { if (errors.length < 4096) errors += part.toString(); });
    child.stdout.on('data', part => { output += part.toString(); if (output.length > 2097152) { child.kill(); finish(new Error('YouTube 목록 크기 제한을 넘었습니다.')); } });
    child.on('error', () => finish(new Error('YouTube 조회 도구를 실행하지 못했습니다.')));
    child.on('close', code => {
      // The channel hides finished broadcasts; with no live or upcoming video YouTube removes the streams tab.
      if (code !== 0 && /does not have a streams tab/.test(errors)) { finish(null, []); return; }
      if (code !== 0) { finish(new Error('YouTube 공식 채널 조회에 실패했습니다.')); return; }
      try { finish(null, parseYouTubeDirectory(JSON.parse(output))); } catch (error) { finish(error); }
    });
  });
}
