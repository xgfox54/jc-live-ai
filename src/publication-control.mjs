import { randomUUID } from 'node:crypto';

// A lane lease outlasts the longest POST time limit (120 s, cloud-publisher.mjs), so another process cannot publish
// the same lane while a large archive upload is still in flight.
const LANE_LEASE_MS = 150_000;
// The server refused these requests, so nothing was stored and the request is not retried as it is.
const REFUSED = ['credentials', 'quota', 'suspended', 'conflict', 'invalid', 'size'];
export const publicationDefaults = {
  interval_ms: 60000, minutes_interval_ms: 300000, min_snapshot_ms: 1000,
  burst_limit: 128, burst_window_ms: 60000, retry_base_ms: 1000, retry_max_ms: 60000, retry_limit: 5,
};
export function validatePublicationSettings(value) {
  const settings = { ...publicationDefaults, ...value };
  const ranges = { interval_ms: [60000, 3600000], minutes_interval_ms: [60000, 3600000],
    min_snapshot_ms: [1000, 5000], burst_limit: [3, 600], burst_window_ms: [1000, 60000],
    retry_base_ms: [1000, 60000], retry_max_ms: [1000, 3600000], retry_limit: [1, 10] };
  for (const [key, [low, high]] of Object.entries(ranges))
    if (!Number.isSafeInteger(settings[key]) || settings[key] < low || settings[key] > high) throw new Error('Invalid publication control setting');
  if (settings.retry_max_ms < settings.retry_base_ms) throw new Error('Invalid retry range');
  if (settings.budget) {
    const b = settings.budget;
    for (const key of ['advanced_limit', 'advanced_used', 'reserved_final'])
      if (!Number.isSafeInteger(b[key]) || b[key] < 0) throw new Error('Invalid publication budget');
    if (!b.advanced_limit || b.reserved_final > b.advanced_limit || typeof b.period_id !== 'string' || !b.period_id.trim()) throw new Error('Invalid publication budget period');
    if (b.enforce !== undefined && typeof b.enforce !== 'boolean') throw new Error('Invalid publication budget policy');
  }
  return settings;
}

// Local durable admission state is separate from public content and never sent to viewers.
export class PublicationControl {
  constructor(store, key, settings, now, random = Math.random) {
    Object.assign(this, { store, key, settings, now, random }); this.instance = randomUUID();
    store.db.exec(`CREATE TABLE IF NOT EXISTS cloud_control(endpoint TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_outbox(endpoint TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(endpoint,id));`);
    if (!this.load()) this.save({ publisher_id: randomUUID(), sequence: 0, attempts: [], lanes: {}, blocked: null,
      metrics: { attempts: 0, successes: 0, failures: 0, unchanged: 0, body_bytes: 0, raw_bytes: 0,
        snapshot_attempts: 0, archive_attempts: 0, confirmed_writes: 0, deduplicated: 0 }, budget_period: settings.budget?.period_id ?? null, budget_attempts: 0 });
  }
  load() { const row = this.store.db.prepare('SELECT document FROM cloud_control WHERE endpoint=?').get(this.key); return row && JSON.parse(row.document); }
  save(value) { this.store.db.prepare('INSERT INTO cloud_control VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET document=excluded.document').run(this.key, JSON.stringify(value)); }
  change(fn) { return this.store.transaction(() => { const state = this.load(); const result = fn(state); this.save(state); return result; }); }
  outbox(id) { const row = this.store.db.prepare('SELECT document FROM cloud_outbox WHERE endpoint=? AND id=?').get(this.key, id); return row && JSON.parse(row.document); }
  put(id, value) { this.store.db.prepare('INSERT INTO cloud_outbox VALUES(?,?,?) ON CONFLICT(endpoint,id) DO UPDATE SET document=excluded.document').run(this.key, id, JSON.stringify(value)); }
  remove(id) { this.store.db.prepare('DELETE FROM cloud_outbox WHERE endpoint=? AND id=?').run(this.key, id); }
  queue(id, payload, hash, previous, metadata = {}) {
    return this.store.transaction(() => {
    const pending = this.outbox(id);
    if (pending && (pending.attempted || pending.attempts > 0 || pending.hash === hash)) return pending;
    const state = this.load();
    const identity = { publisher_id: state.publisher_id, revision: ++state.sequence }; this.save(state);
    const value = { payload: { ...payload, published_ms: Math.max(this.now(), (previous?.published_ms ?? 0) + 1),
      publication: { ...identity, request_id: randomUUID(), content_hash: hash } }, hash, metadata, attempts: 0, next_ms: 0 };
    this.put(id, value); return value;
    });
  }
  admit(id, final = false, requestId) {
    return this.change(state => {
      const now = this.now(); const lane = id === 'site' ? 'live' : 'archive';
      const pending = this.outbox(id);
      if (state.blocked) return { blocked: state.blocked };
      if (!pending || pending.next_ms > now) return { next_ms: pending?.next_ms ?? now };
      if (requestId && pending.payload.publication.request_id !== requestId) return { next_ms: now + 1000 };
      if (state.lanes[lane]?.until > now && state.lanes[lane].owner !== this.instance) return { next_ms: state.lanes[lane].until };
      state.attempts = state.attempts.filter(time => time > now - this.settings.burst_window_ms);
      if (state.attempts.length >= this.settings.burst_limit) return { next_ms: state.attempts[0] + this.settings.burst_window_ms };
      if (id === 'site' && state.last_snapshot_ms !== undefined && now - state.last_snapshot_ms < this.settings.min_snapshot_ms)
        return { next_ms: state.last_snapshot_ms + this.settings.min_snapshot_ms };
      const budget = this.settings.budget;
      if (budget && budget.period_id !== state.budget_period) return { blocked: 'budget_period_review' };
      const used = budget ? budget.advanced_used + state.budget_attempts : 0;
      if (budget?.enforce && (used >= budget.advanced_limit * .95 || (!final && used >= budget.advanced_limit - budget.reserved_final)))
        return { blocked: 'budget_limit' };
      if (budget?.enforce && used >= budget.advanced_limit * .85 && id !== 'site' && !final)
        return { blocked: 'budget_archive_deferred' };
      state.lanes[lane] = { owner: this.instance, until: now + LANE_LEASE_MS };
      state.attempts.push(now); state.metrics.attempts++; state.budget_attempts++;
      state.metrics[id === 'site' ? 'snapshot_attempts' : 'archive_attempts']++;
      if (id === 'site') state.last_snapshot_ms = now;
      pending.attempts++; pending.attempted = true; this.put(id, pending);
      return { allowed: true };
    });
  }
  release(id) { this.change(state => { const lane = id === 'site' ? 'live' : 'archive'; if (state.lanes[lane]?.owner === this.instance) delete state.lanes[lane]; }); }
  failure(id, error) {
    const pending = this.outbox(id); if (!pending) return;
    const terminal = REFUSED.includes(error.code);
    pending.next_ms = this.now() + Math.max(error.retry_ms ?? 0,
      Math.min(this.settings.retry_max_ms, this.settings.retry_base_ms * 2 ** Math.min(20, pending.attempts - 1)) * (.5 + this.random()));
    pending.error = terminal ? error.code : 'temporary'; this.put(id, pending);
    this.change(state => { state.metrics.failures++;
      const code = ['credentials', 'quota', 'suspended', 'conflict', 'invalid', 'size', 'rate_limit'].includes(error.code) ? error.code
        : ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'temporary';
      state.metrics.failure_codes ??= {}; state.metrics.failure_codes[code] = (state.metrics.failure_codes[code] ?? 0) + 1;
      if (terminal || pending.attempts >= this.settings.retry_limit)
      state.blocked = terminal ? error.code : 'retry_exhausted'; });
  }
  // An operator must explicitly resume after fixing the cause; force publication never clears a breaker.
  // A refused request is dropped rather than retried, so the next pass sends the current content and never a payload
  // queued before the stop (2026-11-14: the suspended Vercel queue still held 4 November minutes and index).
  resume() { this.change(state => { state.blocked = null; });
    for (const row of this.store.db.prepare('SELECT id,document FROM cloud_outbox WHERE endpoint=?').all(this.key)) {
      const value = JSON.parse(row.document);
      if (REFUSED.includes(value.error)) { this.remove(row.id); continue; }
      value.attempted ||= value.attempts > 0;
      value.attempts = 0; value.next_ms = 0; delete value.error; this.put(row.id, value);
    }
  }
  reviewBudgetPeriod() {
    if (!this.settings.budget) throw new Error('Publication budget is not configured');
    this.change(state => {
      if (state.budget_period === this.settings.budget.period_id) throw new Error('Budget period has not changed');
      state.budget_period = this.settings.budget.period_id; state.budget_attempts = 0;
    });
  }
  view() {
    const state = this.load(); const budget = this.settings.budget;
    const ratio = budget ? (budget.advanced_used + state.budget_attempts) / budget.advanced_limit : 0;
    return { blocked_reason: state.blocked ?? (budget && budget.period_id !== state.budget_period ? 'budget_period_review' : null), metrics: state.metrics,
      queued: this.store.db.prepare('SELECT count(*) AS n FROM cloud_outbox WHERE endpoint=?').get(this.key).n,
      budget: budget ? { period_id: state.budget_period, estimated_used: budget.advanced_used + state.budget_attempts,
        level: ratio >= .95 ? 'stop' : ratio >= .85 ? 'reserve' : ratio >= .70 ? 'warning' : 'normal', enforce: budget.enforce === true } : null };
  }
}
