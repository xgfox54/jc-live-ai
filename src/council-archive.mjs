import { councilHtml, councilMetadata, plain, withoutScripts } from './official-directory.mjs';
import { normalize } from './committees.mjs';
import { seoulDate } from './council-schedule.mjs';
import { parseCouncilPlayer, councilReplay } from './council.mjs';
import { committeeForChannel } from '../public/committees.mjs';

// Fills meeting information for recordings registered without the official detail page (for example from the YouTube live list)
// using the council "다시보기" archive, which lists every finished broadcast with its date, round, type and committee.
export const ARCHIVE_URL = 'https://www.council.jeju.kr/broadcast/broad.do';
export function parseCouncilArchive(html) {
  const clean = withoutScripts(html);
  const rows = [];
  for (const row of clean.match(/<tr>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => plain(match[1]));
    const link = row.match(/href\s*=\s*["']([^"']*broad\.do[^"']*act=view[^"']*)["']/i);
    if (cells.length < 8 || !link || !/^\d{4}-\d{2}-\d{2}$/.test(cells[2])) continue;
    let url; try { url = new URL(link[1].replace(/;jsessionid=[^?"]+/i, '').replaceAll('&amp;', '&'), ARCHIVE_URL); } catch { continue; }
    if (url.origin !== 'https://www.council.jeju.kr' || !/^\d{1,8}$/.test(url.searchParams.get('seq') ?? '')) continue;
    rows.push({ date: cells[2], round: cells[3], meeting_type: cells[4], order: cells[5], title: cells[6],
      page_url: url.origin + url.pathname + '?act=view&seq=' + url.searchParams.get('seq') });
  }
  return rows;
}
// The official replay playlist on a broadcast detail page; live playlists and other players are ignored.
function replayOf(html) {
  try { const player = parseCouncilPlayer(html); return player.media_url ? councilReplay(player.media_url) : null; } catch { return null; }
}
export class ArchiveEnricher {
  constructor({ registry, fetchHtml = councilHtml, now = Date.now }) { Object.assign(this, { registry, fetchHtml, now }); }
  candidates() {
    return this.registry.list().filter(record => record.test_run !== true && !record.meeting_round
      && this.now() - (record.archive_checked_ms ?? 0) > 6 * 3_600_000 && this.registry.sessions(record.id).length);
  }
  // Finished meetings without the official replay are checked at most hourly for 30 days after collection ends.
  replayCandidates() {
    return this.registry.list().filter(record => {
      if (record.test_run === true || record.replay_url || this.now() - (record.replay_checked_ms ?? 0) < 3_600_000) return false;
      const sessions = this.registry.sessions(record.id);
      if (!sessions.length || sessions.some(session => !['stopped', 'interrupted'].includes(session.state))) return false;
      return this.now() - Math.max(...sessions.map(session => session.ended_ms ?? session.last_receive_ms ?? session.started_ms ?? 0)) < 30 * 86_400_000;
    });
  }
  // The archive row of the same date and committee whose scheduled time is closest to the first collection (within 3 hours).
  async match(record, rows, page, signal) {
    const channel = committeeForChannel(record.stream_id);
    const committee = record.committee || (channel?.general ? '' : channel?.name) || '';
    // A hearing adds its subject in parentheses ("문화관광체육위원회 (제주관광공사 사장 예정자 인사청문회)"); the archive lists the committee.
    const names = new Set([committee, committee.replace(/\s*\([^)]*\)\s*$/, '')].filter(Boolean).map(normalize));
    const started = this.registry.sessions(record.id).map(session => session.started_ms).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const date = started ? seoulDate(started) : null;
    let best = null;
    for (const row of rows.filter(row => row.date === date && names.has(normalize(row.title)))) {
      if (signal?.aborted) break;
      try {
        const html = await page(row.page_url); const metadata = councilMetadata(html);
        const at = Date.parse(metadata.scheduled_at.replace(' ', 'T') + ':00+09:00');
        const distance = Number.isFinite(at) ? Math.abs(at - started) : Infinity;
        if (distance <= 3 * 3_600_000 && (!best || distance < best.distance)) best = { row, html, metadata, distance };
      } catch { /* skip unreadable detail pages */ }
    }
    return best;
  }
  async run(signal) {
    const records = this.candidates(); const replays = this.replayCandidates();
    if (!records.length && !replays.length) return [];
    const pages = new Map(); const filled = new Set(); let rows = null;
    const page = url => { if (!pages.has(url)) pages.set(url, this.fetchHtml(url, signal)); return pages.get(url); };
    const archive = async () => rows ??= parseCouncilArchive(await page(ARCHIVE_URL));
    if (records.length) await archive();
    for (const record of records) {
      if (signal?.aborted) break;
      const best = await this.match(record, rows, page, signal);
      const current = this.registry.get(record.id); if (!current) continue;
      if (best) {
        this.registry.save({ ...current, ...best.metadata, metadata_source: 'council_archive', archive_checked_ms: this.now(),
          sources: [...new Set([...current.sources, best.row.page_url])] });
        filled.add(record.id);
      } else this.registry.save({ ...current, archive_checked_ms: this.now() });
    }
    for (const record of replays) {
      if (signal?.aborted) break;
      let current = this.registry.get(record.id); if (!current || current.replay_url) continue;
      let found = null;
      for (const url of current.sources.filter(url => /^https:\/\/www\.council\.jeju\.kr\/broadcast\/broad\.do\?act=view&seq=\d+$/.test(url))) {
        try { const media = replayOf(await page(url)); if (media) { found = { page: url, media }; break; } } catch { /* unreadable page */ }
      }
      if (!found) {
        try {
          const best = await this.match(current, await archive(), page, signal); const media = best && replayOf(best.html);
          if (media) found = { page: best.row.page_url, media };
        } catch { /* the archive list is retried at the next hourly check */ }
      }
      current = this.registry.get(record.id); if (!current || signal?.aborted) continue;
      this.registry.save({ ...current, replay_checked_ms: this.now(), ...(found ? { replay_url: found.media, replay_page: found.page,
        sources: [...new Set([...current.sources, found.page])] } : {}) });
      if (found) filled.add(record.id);
    }
    return [...filled];
  }
}
