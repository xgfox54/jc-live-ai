import { councilHtml, parseCouncilDirectory, councilCandidate, youtubeDirectory, DIRECTORY_URLS, CHANNEL } from './official-directory.mjs';
import { viewerStream } from './viewer.mjs';

export class BroadcastDiscovery {
  constructor(context) {
    Object.assign(this, context); this.closed = false; this.status = { phase: 'waiting', sources: {} };
    this.scanSources = context.scanSources ?? (() => this.fetchSources());
  }
  start() { if (!this.timer && !this.closed) { this.timer = setInterval(() => this.scan(), 30000); this.timer.unref(); this.scan(); } }
  view() {
    return { ...this.registry.settings(), ...this.status, interval_seconds: 30,
      channel_url: 'https://www.youtube.com/channel/' + CHANNEL + '/streams', council_url: DIRECTORY_URLS[0],
      records: this.registry.list().slice(0, 100) };
  }
  async fetchSources() {
    const results = await Promise.allSettled([
      (async () => {
        const pages = await Promise.allSettled(DIRECTORY_URLS.map(async url => parseCouncilDirectory(await councilHtml(url, this.controller.signal))));
        if (!pages.some(page => page.status === 'fulfilled')) throw new Error('의회 방송 목록을 조회하지 못했습니다.');
        const items = [...new Map(pages.flatMap(page => page.status === 'fulfilled' ? page.value : []).map(item => [item.page_url, item])).values()].slice(0, 24);
        const candidates = [];
        for (const item of items) {
          if (this.controller.signal.aborted) break;
          try { candidates.push(await councilCandidate(item, this.controller.signal)); }
          catch (error) { candidates.push({ ...item, kind: 'council', detail_error: error.message }); }
        }
        return candidates;
      })(),
      youtubeDirectory(this.config, this.controller.signal)
    ]);
    const items = []; const statuses = {};
    for (const [index, result] of results.entries()) {
      const name = index === 0 ? 'council' : 'youtube';
      statuses[name] = result.status === 'fulfilled' ? { ok: true, count: result.value.length } : { ok: false, error: result.reason.message };
      if (result.status === 'fulfilled') items.push(...result.value);
    }
    this.status.sources = statuses;
    if (!Object.values(statuses).some(source => source.ok)) throw new Error('두 방송 목록을 조회하지 못했습니다. 다음 확인 때 재시도합니다.');
    return items;
  }
  scan() {
    if (this.closed || !this.registry.settings().enabled) return Promise.resolve();
    if (this.pending) return this.pending;
    this.controller = new AbortController(); this.status.phase = 'checking';
    this.pending = (async () => {
      try {
        const items = await this.scanSources();
        if (this.closed || this.controller.signal.aborted || !this.registry.settings().enabled) return;
        for (const item of items) this.registry.upsert(item);
        this.assign();
        this.status = { ...this.status, phase: 'watching', checked_ms: Date.now(), error: null };
      } catch (error) {
        if (!this.closed && !this.controller.signal.aborted) this.status = { ...this.status, phase: 'retry', error: error.message, checked_ms: Date.now() };
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
  assign() {
    const seen = new Set();
    for (const stream of this.store.streams().sort((a, b) => Number(this.monitor.active(b.stream_id)) - Number(this.monitor.active(a.stream_id)))) {
      const key = stream.broadcast_id || stream.video_id;
      if (!key) continue;
      if (seen.has(key) && stream.auto_discovered && !this.monitor.active(stream.stream_id) && !this.monitor.pending.has(stream.stream_id)) {
        this.monitor.invalidate(stream.stream_id);
        this.store.db.prepare('DELETE FROM streams WHERE id=?').run(stream.stream_id);
        this.store.event('stream', { stream_id: stream.stream_id, deleted: true });
      } else seen.add(key);
    }
    const records = this.registry.list().filter(item => !item.suspended && !item.completed && ['live', 'waiting'].includes(item.phase))
      .sort((a, b) => (a.phase === 'live' ? -1 : 1) - (b.phase === 'live' ? -1 : 1));
    for (const record of records) {
      const streams = this.store.streams();
      const existing = streams.find(stream => stream.broadcast_id === record.id || (record.video_id && stream.video_id === record.video_id));
      if (existing) {
        if (!existing.broadcast_id) this.store.saveStream({ ...existing, broadcast_id: record.id });
        this.registry.save({ ...record, stream_id: existing.stream_id, queued: false,
          suspended: existing.auto_start === false || record.suspended });
        continue;
      }
      const id = Array.from({ length: 8 }, (_, i) => 'ch' + (i + 1)).find(id => {
        const stream = streams.find(item => item.stream_id === id);
        if (!stream) return true;
        const archived = stream.broadcast_id && this.registry.get(stream.broadcast_id);
        return stream.auto_discovered && !this.monitor.active(id) && !this.monitor.pending.has(id)
          && archived && (archived.completed || archived.suspended || ['ended', 'offline'].includes(archived.phase)
            || (record.phase === 'live' && archived.phase === 'waiting'));
      });
      if (!id) { this.registry.save({ ...record, queued: true }); continue; }
      this.monitor.invalidate(id);
      const stream = { stream_id: id, name: record.title.slice(0, 100), page_url: record.page_url, video_id: record.video_id ?? null,
        kind: record.kind, approved: true, approval_note: '사용자가 승인한 제주특별자치도의회 공식 방송 자동 수집',
        prompt: '', auto_start: true, auto_discovered: true, broadcast_id: record.id, capture_from_start: true,
        resolved_kind: record.resolved_kind, media_url: record.media_url };
      this.store.saveStream(stream); this.store.event('stream', viewerStream(stream));
      this.registry.save({ ...record, stream_id: id, queued: false });
    }
  }
  setEnabled(enabled) {
    this.controller?.abort(); return this.registry.setEnabled(enabled);
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.pending; }
}
