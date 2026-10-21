import { councilHtml, councilMetadata, plain } from './official-directory.mjs';
import { committeeForChannel } from '../public/committees.mjs';

// Fills meeting information for recordings registered without the official detail page (for example from the YouTube live list)
// using the council "다시보기" archive, which lists every finished broadcast with its date, round, type and committee.
export const ARCHIVE_URL = 'https://www.council.jeju.kr/broadcast/broad.do';
const normalize = value => String(value ?? '').replace(/[\s·.ㆍ]/g, '');
const seoulDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
export function parseCouncilArchive(html) {
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>/gi, '');
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
export class ArchiveEnricher {
  constructor({ registry, fetchHtml = councilHtml, now = Date.now }) { Object.assign(this, { registry, fetchHtml, now }); }
  candidates() {
    return this.registry.list().filter(record => record.test_run !== true && !record.meeting_round
      && this.now() - (record.archive_checked_ms ?? 0) > 6 * 3_600_000 && this.registry.sessions(record.id).length);
  }
  async run(signal) {
    const records = this.candidates(); if (!records.length) return [];
    const rows = parseCouncilArchive(await this.fetchHtml(ARCHIVE_URL, signal)); const filled = [];
    for (const record of records) {
      if (signal?.aborted) break;
      const committee = record.committee || committeeForChannel(record.stream_id)?.name || '';
      const started = this.registry.sessions(record.id).map(session => session.started_ms).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const date = started ? seoulDate(started) : null;
      const matches = rows.filter(row => row.date === date && normalize(row.title) === normalize(committee));
      let best = null;
      for (const row of matches) {
        try {
          const metadata = councilMetadata(await this.fetchHtml(row.page_url, signal));
          const at = Date.parse(metadata.scheduled_at.replace(' ', 'T') + ':00+09:00');
          const distance = Number.isFinite(at) ? Math.abs(at - started) : Infinity;
          if (distance <= 3 * 3_600_000 && (!best || distance < best.distance)) best = { row, metadata, distance };
        } catch { /* skip unreadable detail pages */ }
      }
      const current = this.registry.get(record.id); if (!current) continue;
      if (best) {
        this.registry.save({ ...current, ...best.metadata, metadata_source: 'council_archive', archive_checked_ms: this.now(),
          sources: [...new Set([...current.sources, best.row.page_url])] });
        filled.push(record.id);
      } else this.registry.save({ ...current, archive_checked_ms: this.now() });
    }
    return filled;
  }
}
