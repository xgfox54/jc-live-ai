import { councilHtml, plain, withoutScripts } from './official-directory.mjs';
import { matchCommittee } from './committees.mjs';

export const SCHEDULE_URL = 'https://www.council.jeju.kr/broadcast/schedule.do';
// A meeting in recess (정회중) is on air.
const STATUS = [[/방송종료/, 'ended'], [/방송중|생방송|정회/, 'live'], [/방송예정/, 'scheduled']];
export const seoulDate = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

export function parseBroadcastSchedule(html) {
  const clean = withoutScripts(html);
  if (!/생방송 일정/.test(plain(clean))) throw new Error('의회 생방송 일정 형식을 확인해 주세요.');
  const items = [];
  for (const table of clean.match(/<table\b[^>]*class=["']s-list["'][^>]*>[\s\S]*?<\/table>/gi) ?? []) {
    const date = plain(table.match(/<thead>[\s\S]*?<th\b[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // Rows and cells may carry attributes: on 2026-11-26 the page began to send <th scope="row">, the rows no longer
    // matched and the schedule of the site was empty from 16:19.
    for (const row of table.match(/<tr\b[^>]*>\s*<th\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const label = plain(row.match(/<i\b[^>]*>([\s\S]*?)<\/i>/i)?.[1] ?? '');
      // The title of a meeting on air is a link to its player, so the cell is read up to the agenda button.
      const cell = row.match(/<td\b[^>]*>([\s\S]*?)<a\b[^>]*class=["']btn["']/i)?.[1] ?? row.match(/<td\b[^>]*>([\s\S]*?)<a\b/i)?.[1] ?? '';
      const heading = plain(cell).replace(/\s+/g, ' ').match(/^\[(\d{2}):(\d{2})\]\s*(.+)$/);
      if (!heading || Number(heading[1]) > 23 || Number(heading[2]) > 59) continue;
      const time = heading[1] + ':' + heading[2]; const title = heading[3].trim().slice(0, 300);
      const status = STATUS.find(([pattern]) => pattern.test(label))?.[1] ?? 'scheduled';
      items.push({ date, time, starts_at: date + 'T' + time + ':00+09:00', title, status,
        stream_id: matchCommittee({ title })?.stream_id ?? null });
    }
  }
  // A page whose day tables hold rows but yield no meeting has changed its layout (2026-11-26 16:19); it is logged only.
  if (!items.length && /<tr\b[^>]*>\s*<th\b[^>]*scope=["']row/i.test(clean))
    process.stderr.write(JSON.stringify({ level: 'warn', event: 'schedule.unread', time: new Date().toISOString(),
      error: '의회 생방송 일정 표에서 회의를 읽지 못했습니다. 화면 구조를 확인해 주세요.' }) + '\n');
  return items.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title, 'ko'));
}

export class CouncilSchedule {
  constructor({ fetchHtml = councilHtml, now = Date.now, interval = 1_800_000 } = {}) {
    Object.assign(this, { fetchHtml, now, interval }); this.items = []; this.status = { phase: 'waiting', error: null };
  }
  start() { if (!this.timer && !this.closed) { this.timer = setInterval(() => this.refresh(), this.interval); this.timer.unref(); this.refresh(); } }
  refresh() {
    if (this.pending || this.closed) return this.pending ?? Promise.resolve();
    this.controller = new AbortController();
    this.pending = (async () => {
      try {
        const [year, month] = seoulDate(this.now()).split('-').map(Number);
        const next = month === 12 ? [year + 1, 1] : [year, month + 1];
        const pages = await Promise.all([[year, month], next].map(([y, m]) =>
          this.fetchHtml(SCHEDULE_URL + '?year=' + y + '&month=' + m, this.controller.signal).then(parseBroadcastSchedule)));
        const items = [...new Map(pages.flat().map(item => [item.starts_at + item.title, item])).values()]
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title, 'ko'));
        if (JSON.stringify(items) !== JSON.stringify(this.items)) { this.items = items; this.updated_ms = this.now(); }
        this.status = { phase: 'ready', error: null, checked_ms: this.now() };
      } catch (error) {
        if (this.closed) return;
        this.status = { ...this.status, phase: 'retry', error: '의회 생방송 일정을 확인하지 못했습니다. 30분 뒤 다시 확인합니다.', checked_ms: this.now() };
        process.stderr.write(JSON.stringify({ level: 'warn', event: 'schedule.failed', error: error.message }) + '\n');
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
  view() {
    const today = seoulDate(this.now());
    return { source_url: SCHEDULE_URL, updated_ms: this.updated_ms ?? null,
      items: this.items.filter(item => item.date >= today && item.status !== 'ended').slice(0, 60) };
  }
  adminView() { return { ...this.view(), ...this.status }; }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.pending; }
}
