import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';
import { syncRequest } from '../web/lib/http.mjs';
import { publicationConnectionMessage } from '../public/client-state.mjs';
import { pollSnapshots } from '../public/polling.mjs';
import { PublicationControl, validatePublicationSettings } from '../src/publication-control.mjs';
import { publicationState } from '../scripts/publication-state.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

function fixture(t, overrides = {}) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  let now = 1792882800000; let calls = 0; let writes = 0; const rows = new Map(); const bodies = [];
  const storage = { async read(path) { return structuredClone(rows.get(path)); }, async write(path, value, etag) {
    assert.equal(etag, rows.get(path)?.etag); rows.set(path, { value: structuredClone(value), etag: String(++writes) });
  } };
  const settings = { endpoint: 'https://fixture.vercel.app/api/sync', secret: 'c'.repeat(64), ...overrides };
  const context = { config: {}, store, registry, scheduler: { states: () => [] }, minutes: { flush() {} }, settings,
    now: () => now, random: () => .5, fetcher: async (url, options) => {
      calls++; bodies.push(JSON.parse(options.headers['Content-Encoding'] ? gunzipSync(options.body) : options.body));
      return syncRequest(new Request(url, options), { storage, secret: settings.secret, now: () => now });
    } };
  let publisher = new CloudPublisher(context);
  t.after(async () => { await publisher.close(); store.close(); });
  return { context, store, registry, rows, bodies, storage, get publisher() { return publisher; }, get calls() { return calls; }, get writes() { return writes; },
    time: ms => { now += ms; }, change: name => store.saveStream({ stream_id: 'ch0', name, page_url: '' }),
    restart: async () => { await publisher.close(); publisher = new CloudPublisher(context); return publisher; } };
}

test('24-hour virtual idle including force and restart sends no POST or Blob writes after initialization', async t => {
  const f = fixture(t); f.change('본회의'); await f.publisher.flush(); const initial = f.calls;
  for (let minute = 0; minute < 1440; minute++) { f.time(60000); await f.publisher.flush({ force: true }); }
  await f.restart(); await f.publisher.flush({ force: true });
  assert.equal(f.calls, initial); assert.equal(f.writes, 1);
  assert.equal(f.publisher.view().queued, 0);
  assert.equal(f.rows.get('site.json').value.snapshot.publication.active, false);
});

test('all force/event/archive triggers respect snapshot spacing and shared burst bound; latest snapshot wins', async t => {
  const f = fixture(t, { burst_limit: 3, burst_window_ms: 60000 });
  for (let second = 0; second < 10; second++) {
    f.change('회의 ' + second);
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.publisher.flush({ force: i % 2 === 0, trigger: 'event' })));
    f.time(1000);
  }
  assert.equal(f.calls, 3); assert.equal(f.publisher.view().queued, 1);
  f.time(60000); await f.publisher.flush();
  assert.equal(f.rows.get('site.json').value.snapshot.streams[0].name, '회의 9');
  assert.equal(f.publisher.view().queued, 0);
});

test('accepted write with lost acknowledgement retries same request beyond window after restart', async t => {
  const f = fixture(t); f.change('본회의'); let drop = true;
  const send = f.context.fetcher;
  f.context.fetcher = async (...args) => { const result = await send(...args); if (drop) { drop = false; throw new Error('private-response-loss'); } return result; };
  f.publisher.fetcher = f.context.fetcher;
  await f.publisher.flush(); assert.equal(f.writes, 1); assert.equal(f.publisher.view().queued, 1);
  const id = f.bodies[0].publication.request_id;
  f.time(360001); await f.restart(); await f.publisher.flush();
  assert.equal(f.bodies[1].publication.request_id, id); assert.equal(f.writes, 1);
  assert.equal(f.publisher.view().metrics.deduplicated, 1); assert.equal(f.publisher.view().queued, 0);
});

test('permanent errors block repeated force attempts, retain local writes and persist across restart', async t => {
  for (const [status, code] of [[401, 'credentials'], [503, 'quota'], [503, 'suspended'], [409, 'conflict']]) await t.test(code, async t => {
    const f = fixture(t); let attempts = 0;
    f.publisher.fetcher = async () => { attempts++; return Response.json({ code }, { status }); };
    f.change('시작'); await f.publisher.flush();
    for (let n = 0; n < 20; n++) { f.time(60000); f.change('변경 ' + n); await f.publisher.flush({ force: true }); }
    await f.restart(); await f.publisher.flush({ force: true });
    assert.equal(attempts, 1); assert.equal(f.calls, 0); assert.equal(f.publisher.view().blocked_reason, code);
    assert.equal(f.publisher.view().queued, 1); assert.equal(f.store.streams()[0].name, '변경 19');
    assert.doesNotMatch(JSON.stringify(f.publisher.view()), /cccccccc|private-response/);
    f.publisher.control.resume(); f.time(60000); await f.publisher.flush();
    // The refused request queued before the stop is never sent; the first request after resuming is the current content.
    assert.equal(f.bodies[0].snapshot.streams[0].name, '변경 19');
    f.time(1000); await f.publisher.flush();
    assert.equal(f.rows.get('site.json').value.snapshot.streams[0].name, '변경 19');
  });
});

test('429 Retry-After and bounded transient retries are shared by every trigger', async t => {
  const f = fixture(t, { retry_limit: 3 }); let attempts = 0;
  f.publisher.fetcher = async () => { attempts++; return new Response(null, { status: 429, headers: { 'Retry-After': '120' } }); };
  await f.publisher.flush(); f.time(60000); await f.publisher.flush({ force: true }); assert.equal(attempts, 1);
  f.time(60000); await f.publisher.flush(); assert.equal(attempts, 2);
  f.time(120000); await f.publisher.flush(); assert.equal(attempts, 3);
  f.time(86400000); await f.publisher.flush({ force: true }); assert.equal(attempts, 3);
  assert.equal(f.publisher.view().blocked_reason, 'retry_exhausted');
});

test('two publishers sharing a database cannot duplicate an in-flight snapshot', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; });
  f.publisher.fetcher = async (...args) => { await gate; return f.context.fetcher(...args); };
  const first = f.publisher.flush(); await new Promise(setImmediate);
  const other = new CloudPublisher(f.context);
  try { await other.flush({ force: true }); assert.equal(f.calls, 0); }
  finally { release(); await first; await other.close(); }
  assert.equal(f.calls, 1);
});

test('budget is opt-in, preserves a final reserve and never resets on wall-clock month changes', async t => {
  const f = fixture(t, { budget: { period_id: 'verified-window', advanced_limit: 100, advanced_used: 90, reserved_final: 10, enforce: true } });
  await f.publisher.flush(); assert.equal(f.calls, 0); assert.equal(f.publisher.view().queued, 1);
  f.time(31 * 86400000); await f.restart(); await f.publisher.flush(); assert.equal(f.calls, 0);
  assert.equal(f.publisher.view().budget.estimated_used, 90);
});

test('idle publication does not claim active realtime freshness and hidden polls stop; errors back off', async () => {
  const now = Date.now();
  assert.match(publicationConnectionMessage({ published_ms: now - 86400000 }, { content_driven: true, active: false }, true, now), /저장된 자료/);
  assert.match(publicationConnectionMessage({ published_ms: now - 86400000 }, { content_driven: true, active: true }, true, now), /지연/);
  const controller = new AbortController(); const waits = []; let calls = 0; let hidden = true;
  await pollSnapshots({ signal: controller.signal, interval: 5000, connection() {}, random: () => .5,
    hidden: () => hidden, sleep: async ms => { waits.push(ms); if (waits.length === 2) hidden = false; },
    refresh: async () => { calls++; if (calls === 3) controller.abort(); else throw new Error('offline'); } });
  assert.deepEqual(waits, [60000,60000,10000,20000]); assert.equal(calls, 3);
});

test('another publisher refreshes acknowledged archive index before composing snapshot', async t => {
  const f = fixture(t); const other = new CloudPublisher(f.context);
  t.after(() => other.close());
  const summary = { id: 'b'.repeat(64), title: '합성 회의', scheduled_at: '', status: 'draft', updated_ms: 1,
    segment_count: 0, session_count: 0, publication_policy: 'ai-corrected-v1' };
  f.publisher.remember(summary.id, { summary, hash: 'fixture', published_ms: 1 });
  await f.publisher.flushSnapshot(); f.time(2000); await other.flushSnapshot();
  assert.deepEqual(f.rows.get('site.json').value.minutes_index.map(item => item.id), [summary.id]);
  assert.equal(f.calls, 1);
});

test('budget rollover requires explicit review, reports block and cannot reset the same period', async t => {
  const f = fixture(t);
  const settings = period_id => validatePublicationSettings({ budget: { period_id, advanced_limit: 100,
    advanced_used: 0, reserved_final: 10, enforce: true } });
  const a = new PublicationControl(f.store, 'budget-review', settings('old'), Date.now);
  a.queue('site', {}, 'fixture', null);
  const b = new PublicationControl(f.store, 'budget-review', settings('verified-new'), Date.now);
  b.resume(); assert.equal(b.view().blocked_reason, 'budget_period_review');
  assert.equal(b.admit('site').blocked, 'budget_period_review');
  b.reviewBudgetPeriod(); assert.equal(b.admit('site').allowed, true);
  assert.throws(() => b.reviewBudgetPeriod(), /has not changed/);
});

test('85 percent policy defers intermediate archives but permits live and final within reserve', async t => {
  const f = fixture(t, { budget: { period_id: 'verified', advanced_limit: 100, advanced_used: 85, reserved_final: 5, enforce: true } });
  const control = f.publisher.control;
  control.queue('archive', {}, 'fixture', null);
  assert.equal(control.admit('archive').blocked, 'budget_archive_deferred');
  assert.equal(control.admit('archive', true).allowed, true); control.release('archive');
  await f.publisher.flushSnapshot(); assert.equal(f.calls, 1);
});

test('manual resume preserves attempted identity and never replaces an ambiguous accepted request', async t => {
  const f = fixture(t); const send = f.context.fetcher; let lost = true;
  f.publisher.fetcher = async (...args) => { const result = await send(...args); if (lost) { lost = false; throw new Error('lost'); } return result; };
  f.change('이전 상태'); await f.publisher.flushSnapshot();
  const id = f.bodies[0].publication.request_id;
  f.change('최신 상태'); f.publisher.control.resume(); f.time(2000); await f.publisher.flushSnapshot();
  assert.equal(f.bodies[1].publication.request_id, id); assert.equal(f.writes, 1);
  f.time(1000); await f.publisher.flushSnapshot();
  assert.equal(f.rows.get('site.json').value.snapshot.streams[0].name, '최신 상태');
});

test('platform 402 without JSON stops after one attempt and retains queued snapshot', async t => {
  const f = fixture(t); let attempts = 0;
  f.publisher.fetcher = async () => { attempts++; return new Response('Payment required', { status: 402 }); };
  await f.publisher.flush(); f.time(60000); await f.publisher.flush({ force: true });
  assert.equal(attempts, 1); assert.equal(f.publisher.view().blocked_reason, 'suspended');
  assert.equal(f.publisher.view().queued, 1);
});

test('operator command reports no secrets and resumes without deleting identity or local records', async t => {
  const f = fixture(t); f.change('보존할 회의');
  f.publisher.fetcher = async () => Response.json({ code: 'quota' }, { status: 503 });
  await f.publisher.flush();
  const before = publicationState(f.store.db, f.context.settings);
  const publisher = f.publisher.control.load().publisher_id;
  assert.equal(before.blocked_reason, 'quota');
  assert.doesNotMatch(JSON.stringify(before), /cccccccc|secret|payload|text/);
  const after = publicationState(f.store.db, f.context.settings, { resume: true });
  // The refused request is dropped (2026-11-14); the next pass sends the current content under the same publisher identity.
  assert.equal(after.blocked_reason, null); assert.equal(after.queued, 0); assert.equal(f.publisher.control.outbox('site'), undefined);
  assert.equal(f.publisher.control.load().publisher_id, publisher);
  assert.equal(f.store.streams()[0].name, '보존할 회의');
});

test('unchanged baseline Store constructor reopens added tables without losing existing records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-publication-compat-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  const path = join(directory, 'fixture.sqlite'); let store;
  try {
    store = new Store(path); store.saveStream({ stream_id: 'ch0', name: '보존할 회의', page_url: '' });
    const settings = validatePublicationSettings({}); const control = new PublicationControl(store, 'fixture', settings, Date.now);
    const pending = control.queue('site', {}, 'fixture', null);
    store.close(); store = new Store(path);
    assert.equal(store.streams()[0].name, '보존할 회의');
    const reopened = new PublicationControl(store, 'fixture', settings, Date.now);
    assert.equal(reopened.outbox('site').payload.publication.request_id, pending.payload.publication.request_id);
    assert.equal(reopened.view().queued, 1);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
