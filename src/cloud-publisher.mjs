import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { viewerSnapshot, viewerSegment } from './viewer.mjs';
import { viewerMinuteList, viewerMinutes } from './viewer-minutes.mjs';

export function cloudSettings(config) {
  if (!config.cloudSyncFile) return null;
  const value = JSON.parse(readFileSync(config.cloudSyncFile, 'utf8'));
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.vercel.app') || endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== '/api/sync' || endpoint.search || endpoint.hash
    || !/^[a-f0-9]{64}$/.test(value.secret) || [config.adminToken, config.viewerToken].includes(value.secret))
    throw new Error('Invalid cloud publication configuration');
  const interval_ms = value.interval_ms ?? 60000; const minutes_interval_ms = value.minutes_interval_ms ?? 300000;
  if (!Number.isSafeInteger(interval_ms) || interval_ms < 60000 || interval_ms > 3600000
    || !Number.isSafeInteger(minutes_interval_ms) || minutes_interval_ms < 60000 || minutes_interval_ms > 3600000)
    throw new Error('Invalid cloud publication interval');
  return { endpoint: endpoint.href, secret: value.secret,
    interval_ms, minutes_interval_ms };
}
export class CloudPublisher {
  constructor(context) {
    Object.assign(this, context); this.fetcher = context.fetcher ?? fetch; this.now = context.now ?? Date.now;
    this.closed = false; this.status = { phase: 'disabled', error: null }; this.known = new Map();
    try { this.settings = context.settings ?? cloudSettings(context.config); }
    catch { this.status = { phase: 'blocked', error: '공개 웹사이트 연결 설정을 확인해 주세요.' }; return; }
    if (!this.settings) return;
    this.key = createHash('sha256').update(this.settings.endpoint).digest('hex');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS cloud_publications(endpoint TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(endpoint,id));');
    for (const row of this.store.db.prepare('SELECT id,document FROM cloud_publications WHERE endpoint=?').all(this.key))
      this.known.set(row.id, JSON.parse(row.document));
    if (this.known.get('site')?.published_ms) this.status.published_ms = this.known.get('site').published_ms;
    this.status.phase = 'waiting';
  }
  view() { return { enabled: Boolean(this.settings), ...this.status }; }
  start() {
    if (!this.settings || this.timer || this.closed) return;
    this.onLiveEvent = event => {
      const liveText = event.kind === 'segment' && event.payload.live_preview === true;
      const liveState = ['session', 'status'].includes(event.kind);
      if ((!liveText && !liveState) || this.liveTimer) return;
      this.liveTimer = setTimeout(async () => {
        this.liveTimer = null;
        if (this.pending) await this.pending;
        if (!this.closed) await this.flush();
      }, 1000);
      this.liveTimer.unref();
    };
    this.store.on('event', this.onLiveEvent);
    this.timer = setInterval(() => this.flush(), this.settings.interval_ms); this.timer.unref(); this.flush();
  }
  remember(id, value) {
    this.known.set(id, value);
    this.store.db.prepare('INSERT INTO cloud_publications VALUES(?,?,?) ON CONFLICT(endpoint,id) DO UPDATE SET document=excluded.document')
      .run(this.key, id, JSON.stringify(value));
  }
  async send(payload, signal, published_ms = this.now()) {
    const raw = Buffer.from(JSON.stringify({ ...payload, published_ms }));
    if (raw.length > 64_000_000) throw new Error('publication_expanded_size');
    const compressed = raw.length > 100000;
    const body = compressed ? gzipSync(raw) : raw;
    if (body.length > 3500000) throw new Error('publication_size');
    const response = await this.fetcher(this.settings.endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.settings.secret,
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) },
      body, redirect: 'error', signal });
    if (!response.ok) throw new Error('publication_http_' + response.status);
  }
  async flush({ force = false } = {}) {
    if (this.closed || !this.settings) return;
    const archive = this.flushArchive();
    await this.flushSnapshot({ force });
    await archive;
  }
  updateStatus(kind, phase) {
    this.status = { ...this.status, [kind + '_phase']: phase };
    const phases = [this.status.live_phase, this.status.archive_phase];
    this.status.phase = phases.includes('retry') ? 'retry' : phases.includes('publishing') ? 'publishing' : 'published';
    this.status.error = this.status.phase === 'retry'
      ? '공개 웹사이트 동기화에 실패했습니다. 로컬 녹음과 전사는 계속됩니다. 연결 설정·권한·저장 한도를 확인해 주세요.' : null;
  }
  async flushSnapshot({ force = false } = {}) {
    while (this.pending) { await this.pending; if (!force) return; }
    if (this.closed || !this.settings) return;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(25000)]);
    this.pending = this.publish(signal).finally(() => { this.pending = null; });
    return this.pending;
  }
  flushArchive() {
    if (this.archivePending) return this.archivePending;
    this.archiveController = new AbortController();
    const signal = AbortSignal.any([this.archiveController.signal, AbortSignal.timeout(25000)]);
    this.archivePending = this.publishArchive(signal).finally(() => { this.archivePending = null; });
    return this.archivePending;
  }
  async publishArchive(signal) {
    this.updateStatus('archive', 'publishing');
    let changed = false;
    try {
      this.minutes.flush();
      for (const summary of viewerMinuteList(this.registry)) {
        const previous = this.known.get(summary.id);
        if (previous?.segment_schema === 3 && previous.summary.publication_policy === 'ai-corrected-v1' && previous.summary.updated_ms === summary.updated_ms) continue;
        if (previous?.segment_schema === 3 && previous.summary.publication_policy === 'ai-corrected-v1' && previous.summary.status === summary.status && summary.segment_count - previous.summary.segment_count <= 100
          && this.now() - previous.sent_ms < this.settings.minutes_interval_ms) continue;
        const document = viewerMinutes(this.registry, summary.id); const segments = this.registry.segments(summary.id).map(viewerSegment).filter(Boolean);
        await this.send({ kind: 'minutes', document, segments }, signal);
        this.remember(summary.id, { summary, sent_ms: this.now(), segment_schema: 3 });
        changed = true;
      }
      this.updateStatus('archive', 'published');
    } catch {
      if (!this.closed) this.updateStatus('archive', 'retry');
    }
    if (changed && !this.closed) await this.flushSnapshot({ force: true });
  }
  async publish(signal) {
    this.updateStatus('live', 'publishing');
    try {
      const snapshot = viewerSnapshot(this, this.store.streams().map(stream => stream.stream_id));
      const summaries = [...this.known.entries()].filter(([id]) => id !== 'site').map(([, value]) => value.summary);
      const value = { kind: 'snapshot', snapshot, minutes_index: summaries.sort((a, b) => b.updated_ms - a.updated_ms) };
      const hash = createHash('sha256').update(JSON.stringify({ ...value,
        snapshot: { ...snapshot, publication: { ...snapshot.publication, last_published_ms: null } } })).digest('hex');
      const previous = this.known.get('site');
      if (hash !== previous?.hash || this.now() - (previous?.published_ms ?? 0) >= this.settings.interval_ms) {
        const published_ms = Math.max(this.now(), (previous?.published_ms ?? 0) + 1);
        await this.send(value, signal, published_ms); this.remember('site', { hash, published_ms });
        this.status.published_ms = published_ms;
      }
      this.updateStatus('live', 'published');
    } catch {
      if (!this.closed) this.updateStatus('live', 'retry');
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); clearTimeout(this.liveTimer);
    if (this.onLiveEvent) this.store.off('event', this.onLiveEvent);
    this.controller?.abort(); this.archiveController?.abort(); await Promise.all([this.pending, this.archivePending]); }
}
