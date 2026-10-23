import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { speakerGlossary } from './speaker-glossary.mjs';

const ORIGIN = 'https://record.council.jeju.kr';
const decode = buffer => { try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return new TextDecoder('euc-kr').decode(buffer); } };

export function parseVideoMinutes(html) {
  const head = html.match(/<div class="head">\s*<h1[\s\S]*?<\/h1>\s*<p>([\s\S]*?)<\/p>/)?.[1].replace(/\s+/g, ' ').trim() ?? null;
  const date = head?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const labels = [...new Set([...html.matchAll(/[○●]([^<\n]*?)(?: {2,}|<br|\n)/g)].map(match => match[1].replace(/\s+/g, ' ').trim())
    .filter(label => label.length > 2 && label.length < 40))].sort();
  return { title: head, date, labels };
}

// Collects speaker names and titles from the council's published video minutes so live correction knows the
// officials who usually appear before each committee. Pages without minutes yet are checked again later.
export class SpeakerDirectory {
  constructor({ file = 'data/speaker-labels.json', fetcher = fetch, interval = 6 * 3600_000, startAt = 3600, misses = 15, delayMs = 500, retryDays = 120, now = Date.now } = {}) {
    Object.assign(this, { file, fetcher, interval, startAt, misses, delayMs, retryDays, now }); this.meetings = []; this.closed = false;
  }
  async load() {
    try { this.meetings = JSON.parse(await readFile(this.file, 'utf8')).filter(item => Number.isInteger(item.fidx)); } catch { this.meetings = []; }
    return this.meetings.length;
  }
  async page(fidx, signal) {
    const response = await this.fetcher(ORIGIN + '/source/view/video.html?fidx=' + fidx + '&pos=1&angun=0',
      { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    let size = 0; const parts = [];
    for await (const part of response.body) { size += part.length; if (size > 2_000_000) throw new Error('minutes page too large'); parts.push(part); }
    return parseVideoMinutes(decode(Buffer.concat(parts)));
  }
  async refresh() {
    if (this.running || this.closed) return; this.running = new AbortController();
    try {
      const known = new Map(this.meetings.map(item => [item.fidx, item]));
      const cutoff = new Date(this.now() - this.retryDays * 86400_000).toISOString().slice(0, 10);
      const retry = this.meetings.filter(item => !item.labels.length && (!item.date || item.date >= cutoff)).map(item => item.fidx);
      let fidx = Math.max(this.startAt - 1, ...known.keys()) + 1; let missed = 0; const visit = [...retry];
      while (missed < this.misses && !this.closed) {
        visit.push(fidx++);
        while (visit.length) {
          const id = visit.shift(); const value = await this.page(id, this.running.signal).catch(() => null);
          if (value?.title) known.set(id, { fidx: id, ...value });
          if (id >= fidx - 1) missed = value?.title ? 0 : missed + 1;
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }
      }
      this.meetings = [...known.values()].sort((a, b) => a.fidx - b.fidx);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify(this.meetings)); await rename(this.file + '.tmp', this.file);
    } finally { this.running = null; }
  }
  start() {
    if (this.timer || this.closed) return;
    this.load().then(() => this.refresh()).catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.interval); this.timer.unref();
  }
  glossaryFor(committeeName, today = new Date(this.now()).toISOString().slice(0, 10)) {
    if (!committeeName) return [];
    return speakerGlossary(this.meetings.filter(item => item.date && item.date < today && item.labels.length), committeeName);
  }
  async close() { this.closed = true; clearInterval(this.timer); this.running?.abort(); }
}

