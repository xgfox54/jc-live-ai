import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { viewerSnapshot, viewerSegment } from './viewer.mjs';
import { budgetYears } from './budget-year.mjs';
import { viewerMinuteList, viewerMinutes } from './viewer-minutes.mjs';
import { publicationContentHash } from '../web/lib/publication-protocol.mjs';
import { PublicationControl, validatePublicationSettings } from './publication-control.mjs';
import { finalReadiness } from './final-speakers.mjs';

// Each POST gets its own time limit, scaled by the compressed body and counted from the request start.
// 2026-11-05: one 25-second budget per archive pass, which also covered building the documents, timed out the
// 532 KB forum archive five times although the Worker had stored it, and the fifth failure blocked publication.
export const requestTimeoutMs = bytes => Math.min(120_000, 25_000 + Math.ceil(bytes * 0.06));

export function cloudSettings(config) {
  if (!config.cloudSyncFile) return null;
  const value = JSON.parse(readFileSync(config.cloudSyncFile, 'utf8'));
  const endpoint = new URL(value.endpoint);
  const cloudflare = value.provider === 'cloudflare';
  const hostAllowed = cloudflare ? /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(endpoint.hostname)
    : value.provider === undefined && endpoint.hostname.endsWith('.vercel.app');
  if (!hostAllowed || (cloudflare && value.archive_only !== true)
    || endpoint.protocol !== 'https:' || endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== '/api/sync' || endpoint.search || endpoint.hash
    || !/^[a-f0-9]{64}$/.test(value.secret) || [config.adminToken, config.viewerToken].includes(value.secret))
    throw new Error('Invalid cloud publication configuration');
  const interval_ms = value.interval_ms ?? 60000; const minutes_interval_ms = value.minutes_interval_ms ?? 300000;
  if (!Number.isSafeInteger(interval_ms) || interval_ms < 60000 || interval_ms > 3600000
    || !Number.isSafeInteger(minutes_interval_ms) || minutes_interval_ms < 60000 || minutes_interval_ms > 3600000)
    throw new Error('Invalid cloud publication interval');
  return validatePublicationSettings({ ...value, endpoint: endpoint.href, interval_ms, minutes_interval_ms });
}
export class CloudPublisher {
  constructor(context) {
    Object.assign(this, context); this.fetcher = context.fetcher ?? fetch; this.now = context.now ?? Date.now;
    this.archiveOnly = context.config.desktopLive?.enabled === true;
    this.closed = false; this.status = { phase: 'disabled', error: null }; this.known = new Map();
    try { const settings = context.settings ?? cloudSettings(context.config); this.settings = settings && validatePublicationSettings(settings); }
    catch { this.status = { phase: 'blocked', error: '공개 웹사이트 연결 설정을 확인해 주세요.' }; return; }
    if (!this.settings) return;
    this.archiveOnly ||= this.settings.archive_only === true;
    this.key = createHash('sha256').update(this.settings.endpoint).digest('hex');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS cloud_publications(endpoint TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(endpoint,id));');
    for (const row of this.store.db.prepare('SELECT id,document FROM cloud_publications WHERE endpoint=?').all(this.key))
      this.known.set(row.id, JSON.parse(row.document));
    this.control = new PublicationControl(this.store, this.key, this.settings, this.now, context.random);
    this.archiveDirty = new Set(); this.lastArchiveScan = null;
    if (this.known.get('site')?.published_ms) this.status.published_ms = this.known.get('site').published_ms;
    this.status.phase = 'waiting';
    if (this.archiveOnly) {
      const pending = this.store.db.prepare('SELECT document FROM cloud_outbox WHERE endpoint=?').all(this.key).map(row => JSON.parse(row.document));
      // Only a request the archive-only Worker refuses as live data (cloudflare/worker.mjs) blocks the switch. A pending
      // archive index with empty live lists and ended meetings is ordinary publication, for example after a failed POST.
      const live = payload => payload.kind === 'snapshot' ? payload.snapshot.event_id !== 0 || Boolean(payload.snapshot.schedule)
        || ['streams', 'segments', 'live_segments', 'live_pending', 'states', 'health', 'gaps'].some(key => payload.snapshot[key]?.length)
        || payload.minutes_index.some(item => item.status !== 'draft') : payload.document?.status === 'in_progress';
      this.modeBlocked = pending.some(row => live(row.payload));
      if (this.modeBlocked) this.status = { phase: 'blocked', error: '이전 실시간 게시 요청이 남아 있습니다. 게시 상태를 확인한 후 전달 방식을 전환해 주세요.' };
    }
  }
  view() { return { enabled: Boolean(this.settings), ...this.status, ...(this.control ? this.control.view() : {}),
    content_driven: true, delivery_mode: this.archiveOnly ? 'desktop' : 'cloud', mode_transition_blocked: Boolean(this.modeBlocked), live_pending: Boolean(this.control?.outbox('site')) }; }
  start() {
    if (!this.settings || this.timer || this.closed) return;
    this.onLiveEvent = event => {
      const id = event.payload.session_id && this.registry.forSession(event.payload.session_id);
      if (id) this.archiveDirty.add(id);
      const liveText = event.kind === 'segment';
      const liveState = ['session', 'status', 'stream', 'gap'].includes(event.kind);
      if (this.archiveOnly && liveText) return;
      if ((!liveText && !liveState) || this.liveTimer) return;
      this.liveTimer = setTimeout(async () => {
        this.liveTimer = null;
        if (this.pending) await this.pending;
        if (!this.closed) await this.flush({ trigger: 'event' });
      }, 1000);
      this.liveTimer.unref();
    };
    this.store.on('event', this.onLiveEvent);
    this.onBroadcast = id => { this.archiveDirty.add(id); this.scheduleFlush(this.now() + 1000); };
    this.store.on('broadcast', this.onBroadcast);
    this.timer = setInterval(() => this.flush(), this.settings.interval_ms); this.timer.unref(); this.flush();
  }
  scheduleFlush(at) {
    if (!this.timer || this.closed || !Number.isFinite(at)) return;
    if (this.scheduledAt && this.scheduledAt <= at) return;
    clearTimeout(this.wakeTimer); this.scheduledAt = at;
    this.wakeTimer = setTimeout(() => { this.scheduledAt = null; this.flush({ trigger: 'scheduled' }); }, Math.max(1, at - this.now()));
    this.wakeTimer.unref();
  }
  remember(id, value) {
    this.known.set(id, value);
    this.store.db.prepare('INSERT INTO cloud_publications VALUES(?,?,?) ON CONFLICT(endpoint,id) DO UPDATE SET document=excluded.document')
      .run(this.key, id, JSON.stringify(value));
  }
  refreshKnown() {
    this.known = new Map(this.store.db.prepare('SELECT id,document FROM cloud_publications WHERE endpoint=?').all(this.key)
      .map(row => [row.id, JSON.parse(row.document)]));
  }
  async send(payload, signal) {
    const raw = Buffer.from(JSON.stringify({ ...payload, sent_ms: this.now() }));
    if (raw.length > 64_000_000) throw Object.assign(new Error('publication_expanded_size'), { code: 'size' });
    const compressed = raw.length > 100000;
    const body = compressed ? gzipSync(raw) : raw;
    if (body.length > 3500000) throw Object.assign(new Error('publication_size'), { code: 'size' });
    this.control.change(state => { state.metrics.raw_bytes += raw.length; state.metrics.body_bytes += body.length;
      state.metrics.http_posts = (state.metrics.http_posts ?? 0) + 1; });
    // Duration and HTTP status (0 without a response) of the latest POST are kept to diagnose slow or failed uploads.
    const started = this.now(); let response;
    try {
      response = await this.fetcher(this.settings.endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.settings.secret,
          ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) },
        body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs(body.length))]) });
    } finally {
      const elapsed = this.now() - started;
      this.control.change(state => { state.metrics.last_post_ms = elapsed; state.metrics.last_post_status = response?.status ?? 0;
        state.metrics.max_post_ms = Math.max(state.metrics.max_post_ms ?? 0, elapsed); });
    }
    let result; try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) {
      const codes = new Set(['quota', 'suspended', 'credentials', 'conflict', 'temporary', 'invalid']);
      const code = codes.has(result?.code) ? result.code : [401,403].includes(response.status) ? 'credentials'
        : response.status === 402 ? 'suspended' : response.status === 429 ? 'rate_limit' : response.status === 409 ? 'conflict' : response.status === 413 ? 'size'
        : [400,405,415,422].includes(response.status) ? 'invalid' : 'temporary';
      const retry = response.headers?.get('retry-after');
      const retry_ms = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now()) : 0;
      throw Object.assign(new Error('publication_failed'), { code, retry_ms: Number.isFinite(retry_ms) ? retry_ms : 0 });
    }
    return result;
  }
  async flush({ force = false, trigger = 'manual' } = {}) {
    if (this.closed || !this.settings || this.modeBlocked) return;
    const archive = this.flushArchive({ trigger });
    await this.flushSnapshot({ force });
    await archive;
  }
  updateStatus(kind, phase) {
    this.status = { ...this.status, [kind + '_phase']: phase };
    const phases = [this.status.live_phase, this.status.archive_phase];
    this.status.phase = this.control?.view().blocked_reason ? 'blocked' : phases.includes('retry') ? 'retry'
      : phases.includes('publishing') ? 'publishing' : phases.includes('waiting') ? 'waiting' : 'published';
    this.status.error = ['retry', 'blocked'].includes(this.status.phase)
      ? '공개 웹사이트 동기화에 실패했습니다. 로컬 녹음과 전사는 계속됩니다. 연결 설정·권한·저장 한도를 확인해 주세요.' : null;
  }
  async flushSnapshot({ force = false } = {}) {
    if (this.pending) { this.snapshotDirty = true; return this.pending; }
    if (this.closed || !this.settings || this.modeBlocked) return;
    this.controller = new AbortController();
    this.pending = this.publish(this.controller.signal).finally(() => { this.pending = null;
      if (this.snapshotDirty) { this.snapshotDirty = false; this.scheduleFlush(this.now() + this.settings.min_snapshot_ms); } });
    return this.pending;
  }
  flushArchive({ trigger = 'manual' } = {}) {
    if (this.closed || !this.settings || this.modeBlocked) return;
    if (this.archivePending) return this.archivePending;
    this.archiveController = new AbortController();
    this.archivePending = this.publishArchive(this.archiveController.signal, trigger).finally(() => { this.archivePending = null; });
    return this.archivePending;
  }
  async publishArchive(signal, trigger) {
    this.updateStatus('archive', 'publishing');
    let changed = false;
    try {
      this.minutes.flush();
      this.refreshKnown();
      const scan = trigger !== 'event' || this.lastArchiveScan === null || this.now() - this.lastArchiveScan >= this.settings.minutes_interval_ms;
      if (!scan && !this.archiveDirty.size) { this.updateStatus('archive', 'published'); return; }
      const summaries = viewerMinuteList(this.registry).sort((a, b) => Number(a.status === 'in_progress') - Number(b.status === 'in_progress'));
      if (scan) this.lastArchiveScan = this.now();
      let pendingPhase;
      for (const summary of summaries) {
        if (!scan && !this.archiveDirty.has(summary.id)) continue;
        const previous = this.known.get(summary.id);
        // An archive identical to the published one is skipped before the readiness check (about 12 ms per meeting).
        if (previous?.segment_schema === 3 && previous.summary.publication_policy === 'ai-corrected-v1' && previous.summary.updated_ms === summary.updated_ms
          && !this.control.outbox(summary.id)) {
          // The index lists the summary kept with each published archive. A meeting length added or changed since then is taken
          // into that summary; the archive itself is unchanged and is not sent again.
          if (previous.summary.duration_ms !== summary.duration_ms)
            this.remember(summary.id, { ...previous, summary: { ...previous.summary, duration_ms: summary.duration_ms } });
          this.archiveDirty.delete(summary.id); continue;
        }
        if (this.archiveOnly && finalReadiness(this.registry, summary.id, this.getCorrectionAI?.() ?? {}, this.now()) !== 'ready') continue;
        if (previous?.segment_schema === 3 && previous.summary.publication_policy === 'ai-corrected-v1' && previous.summary.status === summary.status && summary.segment_count - previous.summary.segment_count <= 100
          && this.now() - previous.sent_ms < this.settings.minutes_interval_ms && !this.control.outbox(summary.id)) continue;
        let outcome;
        // A meeting whose archive cannot be built or fails the public data check waits for the next pass without holding
        // back the meetings listed after it (2026-11-14: one refused replay link ended every pass before the later archives).
        try {
          // The archived sentences get the same budget-year spelling as the minutes (src/budget-year.mjs).
          const document = viewerMinutes(this.registry, summary.id); const segments = budgetYears(this.registry.segments(summary.id).map(viewerSegment).filter(Boolean),
            this.registry.get(summary.id)?.agenda, row => row.text, (row, text) => ({ ...row, text }));
          // The list is read before the pass and can still show a meeting that ended while earlier archives were sent;
          // the document is rebuilt now, so the index entry takes its status from the document (2026-11-13).
          const sent = { ...summary, status: document.status, updated_ms: document.updated_ms };
          outcome = await this.deliver(summary.id, { kind: 'minutes', document, segments }, signal,
            { summary: sent, sent_ms: this.now(), segment_schema: 3 }, sent.status !== 'in_progress');
        } catch { pendingPhase = 'retry'; continue; }
        if (outcome === 'sent' || outcome === 'unchanged') { this.archiveDirty.delete(summary.id); changed ||= outcome === 'sent'; }
        else { pendingPhase = outcome === 'retry' ? 'retry' : 'waiting'; break; }
      }
      this.updateStatus('archive', pendingPhase ?? 'published');
    } catch {
      if (!this.closed) this.updateStatus('archive', 'retry');
    }
    if (changed && !this.closed) await this.flushSnapshot({ force: true });
  }
  async deliver(id, value, signal, metadata = {}, final = false) {
    const previous = this.known.get(id);
    const hash = publicationContentHash({ ...value, published_ms: 0 });
    if (previous?.hash === hash && !this.control.outbox(id)) {
      this.control.change(state => state.metrics.unchanged++); return 'unchanged';
    }
    const pending = this.control.queue(id, value, hash, previous, metadata);
    const permission = this.control.admit(id, final, pending.payload.publication.request_id);
    if (!permission.allowed) {
      if (permission.next_ms) this.scheduleFlush(permission.next_ms);
      return permission.blocked || pending.error ? 'retry' : 'waiting';
    }
    try {
      const result = await this.send(pending.payload, signal);
      this.remember(id, { ...pending.metadata, hash: pending.hash, published_ms: pending.payload.published_ms });
      this.control.remove(id);
      this.control.change(state => { state.metrics.successes++; state.metrics[result?.unchanged ? 'deduplicated' : 'confirmed_writes']++; });
      if (pending.hash !== hash) { this.control.queue(id, value, hash, this.known.get(id), metadata); this.scheduleFlush(this.now() + this.settings.min_snapshot_ms); return 'waiting'; }
      return 'sent';
    } catch (error) {
      this.control.failure(id, error); this.scheduleFlush(this.control.outbox(id)?.next_ms);
      return 'retry';
    } finally { this.control.release(id); }
  }
  async publish(signal) {
    this.updateStatus('live', 'publishing');
    try {
      this.refreshKnown();
      const snapshot = this.archiveOnly
        ? { event_id: 0, streams: [], segments: [], states: [], gaps: [], before: {}, live_segments: [], live_pending: [] }
        : viewerSnapshot(this, this.store.streams().map(stream => stream.stream_id));
      // Publication-attempt phases and event cursors are not public content changes.
      snapshot.event_id = 0;
      snapshot.publication = { status: 'published', last_published_ms: null, stale_after_ms: 180000,
        content_driven: true, active: snapshot.states.some(state => ['running','draining','degraded','reconnecting'].includes(state.state)) };
      for (const health of snapshot.health ?? []) {
        health.stages.publication = 'published';
        if (health.stage === 'publication') {
          health.status = health.stages.ingestion === 'stopped' ? 'stopped' : 'ready'; health.stage = null;
          health.message = health.status === 'stopped' ? '방송 기록 수집이 종료되었습니다.' : '최근 음성 처리를 마쳤습니다.';
        }
      }
      // An archive-only Worker refuses an index that lists a meeting still being collected, and that refusal stops
      // all publication, so such an entry waits until its ended archive has been sent.
      const summaries = [...this.known.entries()].filter(([id]) => id !== 'site').map(([, value]) => value.summary)
        .filter(summary => !this.archiveOnly || summary.status === 'draft');
      const value = { kind: 'snapshot', snapshot, minutes_index: summaries.sort((a, b) => b.updated_ms - a.updated_ms) };
      const result = await this.deliver('site', value, signal);
      this.status.published_ms = this.known.get('site')?.published_ms;
      this.updateStatus('live', result === 'retry' ? 'retry' : result === 'waiting' ? 'waiting' : 'published');
    } catch {
      if (!this.closed) this.updateStatus('live', 'retry');
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); clearTimeout(this.liveTimer); clearTimeout(this.wakeTimer);
    if (this.onLiveEvent) this.store.off('event', this.onLiveEvent);
    if (this.onBroadcast) this.store.off('broadcast', this.onBroadcast);
    this.controller?.abort(); this.archiveController?.abort(); await Promise.all([this.pending, this.archivePending]); }
}
