import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService, parseCorrections, correctionIssue } from '../src/ai-correction.mjs';
import { glossaryCatalog, glossaryText } from '../src/glossary.mjs';
import { createService } from '../src/server.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { proxyBase, sealCredential, openCredential } from '../src/ai-proxy.mjs';
import { buildMinutes } from '../src/minutes.mjs';

function fixture(t, transform = text => text.replace('돌봄 써비스', '돌봄 서비스')) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const scheduler = { states: () => [], channels: new Map() };
  const calls = [];
  const aiFetch = async (url, options) => {
    if (url.endsWith('/tags')) return Response.json({ models: [{ name: 'fixture-model' }] });
    if (url.endsWith('/show')) return Response.json({});
    const value = JSON.parse(options.body); calls.push(value);
    const segments = JSON.parse(value.messages.at(-1).content).segments;
    return Response.json({ message: { content: JSON.stringify({ corrections: segments.map(part => ({ ...part, text: transform(part.text) })) }) } });
  };
  const ai = new CorrectionService({ store, registry, scheduler, aiFetch });
  ai.saveSettings({ model: 'fixture-model', automatic: false });
  const page_url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const record = registry.upsert({ page_url, sources: [page_url], title: '후보정 시험', kind: 'youtube' });
  registry.attach({ stream_id: 'ch1', broadcast_id: record.id }, { session_id: 'session-one' });
  store.saveSession({ stream_id: 'ch1', session_id: 'session-one', state: 'stopped' });
  const add = (text = '돌봄 써비스 예산은 100원입니다.', evidence = {}) => store.segment({ stream_id: 'ch1', session_id: 'session-one',
    start_ms: 0, end_ms: 10000, raw_text: text, ...evidence });
  t.after(async () => { await ai.close(); store.close(); });
  return { ai, store, registry, scheduler, calls, id: record.id, add };
}
test('all eleven original field packs fit correction context, prioritize custom words and retain whole terms', () => {
  assert.equal(glossaryCatalog.packs.length, 11);
  for (const pack of glossaryCatalog.packs) {
    assert.ok(pack.terms.length > 400);
    const result = glossaryText([pack.id], '');
    assert.equal(result.text, pack.terms.join(', ')); assert.ok(result.text.length <= 3000);
  }
  const result = glossaryText(['welfare', 'budget'], '사업명, 사업명, 추가어');
  assert.ok(result.text.startsWith('사업명, 추가어, ')); assert.ok(result.omitted > 0);
  assert.match(result.text, /체납률/); assert.match(result.text, /통합돌봄/);
  assert.match(glossaryText(['council', 'jeju'], '').text, /제주 4\.3/);
  assert.throws(() => glossaryText(['missing'], ''));
  assert.throws(() => glossaryText(['welfare', 'welfare'], ''));
});
test('strict correction response rejects unknown, duplicate and missing IDs and flags number or length changes', () => {
  const parts = [{ id: 'S0', text: '100원 예산안입니다.' }];
  for (const raw of ['bad', '{"corrections":[]}', '{"corrections":[{"id":"S1","text":"예산"}]}',
    '{"corrections":[{"id":"S0","text":"예산"},{"id":"S0","text":"예산"}]}',
    '{"corrections":[{"id":"S0","text":"예산","extra":1}]}'])
    assert.throws(() => parseCorrections(raw, parts));
  assert.equal(parseCorrections('{"corrections":[{"id":"S0","text":"100원 예산안입니다."}]}', parts).get('S0'), parts[0].text);
  assert.equal(correctionIssue('100원입니다.', '200원입니다.'), 'numbers');
  assert.equal(correctionIssue('예산안 검토를 요청하는 발언입니다.', '예산'), 'length');
});
test('generation preserves raw speech, persists candidates and applies only explicit reviewed changes with history', async t => {
  const f = fixture(t); const row = f.add(); f.ai.start(f.id); await f.ai.pending;
  assert.equal(f.ai.jobs()[0].phase, 'completed'); assert.equal(f.calls.length, 1);
  let candidate = f.ai.list(f.id).items[0]; assert.equal(candidate.issue, null);
  assert.equal(f.store.snapshot(['ch1']).segments[0].corrected_text, null);
  const result = f.ai.apply(candidate.id);
  assert.equal(result.raw_text, row.raw_text); assert.equal(result.corrected_text, '돌봄 서비스 예산은 100원입니다.');
  assert.equal(result.version, 2); assert.equal(f.ai.list(f.id).items[0].status, 'applied');
  assert.throws(() => f.ai.apply(candidate.id), error => error.status === 409);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT document FROM corrections').get().document).origin, 'ai');
});
test('numeric warnings require acknowledgement and stale candidates never overwrite manual edits', async t => {
  const f = fixture(t, text => text.replace('100', '200')); const row = f.add();
  f.ai.start(f.id); await f.ai.pending; const candidate = f.ai.list(f.id).items[0];
  assert.equal(candidate.issue, 'numbers');
  assert.throws(() => f.ai.apply(candidate.id), error => error.status === 409);
  assert.deepEqual(await f.ai.applySafe(f.id), { applied: 0, skipped: 1 });
  f.store.correct(row.segment_id, { version: 1, text: '직접 확인한 발언' });
  assert.equal(f.ai.list(f.id).items[0].stale, true);
  assert.throws(() => f.ai.apply(candidate.id, true), error => error.status === 409);
  assert.equal(f.store.snapshot(['ch1']).segments[0].corrected_text, '직접 확인한 발언');
});
test('failed, cancelled and interrupted generation retains raw text and supports retry without duplicates', async t => {
  const f = fixture(t); f.add(); const original = f.ai.fetcher;
  f.ai.fetcher = async () => { throw new Error('Local model unavailable'); };
  f.ai.start(f.id); await f.ai.pending; assert.equal(f.ai.jobs()[0].phase, 'failed');
  assert.equal(f.ai.list(f.id).items.length, 0);
  f.ai.fetcher = original; f.ai.start(f.id); await f.ai.pending;
  f.ai.start(f.id); await f.ai.pending; assert.equal(f.ai.list(f.id).items.length, 1);
  f.add('두 번째 발언입니다.');
  let began; const started = new Promise(resolve => { began = resolve; });
  f.ai.fetcher = async (url, options) => { began(); await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); };
  f.ai.start(f.id); await started; await f.ai.cancel(f.id);
  assert.equal(f.ai.jobs()[0].phase, 'cancelled'); assert.equal(f.ai.list(f.id).items.length, 1);
  assert.equal(f.store.snapshot(['ch1']).segments[1].corrected_text, null);
  f.ai.save('ai_jobs', f.id, { id: f.id, phase: 'running' });
  await f.ai.close();
  const reopened = new CorrectionService(f); assert.equal(reopened.jobs()[0].phase, 'interrupted'); await reopened.close();
});
test('collection takes precedence and long rows split into bounded requests without dropping text', async t => {
  const f = fixture(t, text => text); const raw = '검토할 발언입니다. '.repeat(190); f.add(raw);
  f.scheduler.states = () => [{ state: 'running' }];
  assert.throws(() => f.ai.start(f.id), error => error.status === 409);
  f.scheduler.states = () => [];
  f.ai.start(f.id); assert.throws(() => f.ai.start(f.id), error => error.status === 409); await f.ai.pending;
  assert.ok(f.calls.length >= 2);
  assert.equal(f.ai.list(f.id).items[0].text.replaceAll(' ', ''), raw.trim().replaceAll(' ', ''));
  assert.ok(f.calls.every(call => JSON.parse(call.messages.at(-1).content).segments.reduce((sum, part) => sum + part.text.length, 0) <= 1800));
});
test('service shutdown interrupts automatic correction and restart resumes the saved backlog', async t => {
  const f = fixture(t); f.add();
  f.registry.saveMinutes(buildMinutes(f.registry.get(f.id), f.registry.sessions(f.id), f.registry.segments(f.id), []));
  f.ai.saveSettings({ model: 'fixture-model', automatic: true });
  const original = f.ai.fetcher;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  f.ai.fetcher = async (url, options) => {
    if (url.endsWith('/show')) return Response.json({});
    began();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  f.ai.start(f.id); await started; await f.ai.close();
  assert.equal(f.ai.jobs()[0].phase, 'interrupted');
  const reopened = new CorrectionService({ ...f, aiFetch: original });
  try {
    reopened.auto();
    assert.ok(reopened.pending, 'saved automatic backlog must resume after shutdown');
    await reopened.pending;
    assert.equal(reopened.jobs()[0].phase, 'completed');
    assert.equal(f.store.snapshot(['ch1']).segments[0].ai_corrected, true);
  } finally { await reopened.close(); }
});
test('candidate history pages are complete and rejected candidates stay excluded from automatic reuse', async t => {
  const f = fixture(t, text => text); for (let i = 0; i < 53; i++) f.add('발언 ' + i);
  f.ai.start(f.id); await f.ai.pending;
  const first = f.ai.list(f.id); assert.equal(first.items.length, 50);
  const older = f.ai.list(f.id, first.before); assert.equal(older.items.length, 3);
  f.ai.reject(first.items[0].id); f.ai.start(f.id); await f.ai.pending;
  assert.equal(f.ai.list(f.id).items[0].status, 'rejected'); assert.equal(f.calls.length, 14);
});
test('AI configuration and candidates require admin authentication and never appear in viewer output', async t => {
  const store = new Store(':memory:'); const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64) };
  const scheduler = new Scheduler(store, { ready: true, stop: async () => {} }, config);
  const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  t.after(async () => { await service.close(); await scheduler.close(); store.close(); });
  const base = 'http://127.0.0.1:' + service.server.address().port;
  assert.equal((await fetch(base + '/api/admin/ai')).status, 401);
  const headers = { Authorization: 'Bearer ' + config.adminToken, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/admin/ai', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/admin/ai/settings', { method: 'POST', headers,
    body: JSON.stringify({ model: 'fixture-model', automatic: true }) })).status, 200);
  const value = await (await fetch(base + '/api/viewer/snapshot')).text();
  assert.doesNotMatch(value, /fixture-model|glossary|candidates/);
});
test('proxy binds encrypted keys to destinations and clears them on address change', t => {
  for (const base of ['http://192.168.0.1/v1', 'http://127.0.0.1.evil.test', 'https://user:password@example.test',
    'https://example.test?key=secret', 'file:///tmp', 'https://example.test/#secret']) assert.throws(() => proxyBase(base));
  assert.equal(proxyBase('http://localhost:10100/v1/'), 'http://127.0.0.1:10100/v1');
  const token = 'a'.repeat(64); const base = 'https://proxy.example.test/v1';
  const sealed = sealCredential('private-key', base, token);
  assert.doesNotMatch(JSON.stringify(sealed), /private-key/);
  assert.equal(openCredential(sealed, base, token), 'private-key');
  assert.throws(() => openCredential(sealed, 'https://elsewhere.test/v1', token));
  assert.throws(() => openCredential(sealed, base, 'b'.repeat(64)));
  const f = fixture(t); f.ai.config.adminToken = token;
  f.ai.saveSettings({ model: 'proxy-model', automatic: false, provider: 'proxy', base, api_key: 'private-key' });
  assert.equal(f.ai.settings().has_api_key, true);
  assert.doesNotMatch(JSON.stringify(f.ai.view()), /private-key/);
  f.ai.saveSettings({ model: 'proxy-model', automatic: false, provider: 'proxy', base: 'https://changed.example.test/v1' });
  assert.equal(f.ai.settings().has_api_key, false);
});
test('proxy rejects truncated output and creates incremental candidates during collection', async t => {
  const f = fixture(t); f.ai.config.adminToken = 'a'.repeat(64);
  f.ai.saveSettings({ model: 'proxy-model', automatic: true, provider: 'proxy', base: 'http://127.0.0.1:10100/v1', api_key: 'private-key' });
  let truncated = true; const calls = [];
  f.ai.fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'proxy-model' }] });
    const body = JSON.parse(options.body); const parts = JSON.parse(body.messages.at(-1).content).segments;
    return Response.json({ choices: [{ finish_reason: truncated ? 'length' : 'stop',
      message: { content: JSON.stringify({ corrections: parts }) } }] });
  };
  assert.deepEqual((await f.ai.models()).models, ['proxy-model']);
  f.scheduler.states = () => [{ state: 'running' }]; f.add();
  f.registry.saveMinutes(buildMinutes(f.registry.get(f.id), f.registry.sessions(f.id), f.registry.segments(f.id), []));
  f.ai.auto(); await f.ai.pending; assert.equal(f.ai.jobs()[0].phase, 'failed'); assert.equal(f.ai.list(f.id).items.length, 0);
  truncated = false; f.ai.start(f.id); await f.ai.pending; assert.equal(f.ai.list(f.id).items.length, 1);
  f.add('추가 발언입니다.'); f.ai.auto(); await f.ai.pending; assert.equal(f.ai.list(f.id).items.length, 2);
  const chat = calls.find(call => call.url.endsWith('/chat/completions'));
  assert.equal(chat.options.redirect, 'error'); assert.equal(chat.options.headers.Authorization, 'Bearer private-key');
  const payload = JSON.parse(chat.options.body); assert.equal(payload.stream, false); assert.equal(payload.model, 'proxy-model');
  assert.equal(payload.tools, undefined); assert.equal(payload.max_tokens, 16000);
});
test('automatic correction publishes safe candidates, keeps flagged ones for review and retries failures with backoff', async t => {
  let now = 1_000_000; let fail = true;
  const f = fixture(t, text => text.replace('돌봄 써비스', '돌봄 서비스').replace('200원', '300원'));
  f.ai.now = () => now; const original = f.ai.fetcher;
  f.ai.fetcher = async (url, options) => { if (fail && url.endsWith('/chat')) return new Response('busy', { status: 503 }); return original(url, options); };
  f.ai.saveSettings({ model: 'fixture-model', automatic: true });
  assert.equal(f.ai.settings().auto_apply_safe, true);
  f.add(); f.add('돌봄 써비스 예산은 200원입니다.'); f.add('MBC 뉴스 김지경입니다.', { speech_activity: { state: 'silence' } });
  f.registry.saveMinutes(buildMinutes(f.registry.get(f.id), f.registry.sessions(f.id), f.registry.segments(f.id), []));
  f.ai.auto(); await f.ai.pending; assert.equal(f.ai.jobs()[0].phase, 'failed'); assert.equal(f.ai.jobs()[0].failures, 1);
  fail = false; now += 30_000; f.ai.auto(); assert.equal(f.ai.pending, null);
  now += 31_000; f.ai.auto(); await f.ai.pending;
  const items = f.ai.list(f.id).items;
  assert.deepEqual(items.map(item => item.status).sort(), ['applied', 'pending', 'rejected']);
  assert.equal(items.find(item => item.status === 'rejected').issue, 'hallucination');
  assert.equal(items.find(item => item.status === 'pending').issue, 'numbers');
  const published = f.store.segments({ stream: 'ch1', published: true }).items;
  assert.deepEqual(published.map(item => item.corrected_text), ['돌봄 서비스 예산은 100원입니다.']);
  assert.equal(f.ai.jobs()[0].failures, 0);
});
test('enabling automatic correction publishes earlier pending candidates except hallucinations', async t => {
  const f = fixture(t); f.add(); f.add('MBC 뉴스 김지경입니다.', { speech_activity: { state: 'silence' } });
  f.ai.start(f.id); await f.ai.pending;
  assert.deepEqual(f.ai.list(f.id).items.map(item => item.status).sort(), ['pending', 'rejected']);
  f.ai.saveSettings({ model: 'fixture-model', automatic: true });
  f.registry.saveMinutes(buildMinutes(f.registry.get(f.id), f.registry.sessions(f.id), f.registry.segments(f.id), []));
  f.ai.auto(); await new Promise(resolve => setImmediate(resolve)); await f.ai.pending;
  assert.deepEqual(f.store.segments({ stream: 'ch1', published: true }).items.map(item => item.corrected_text), ['돌봄 서비스 예산은 100원입니다.']);
});
test('test-run recordings are excluded from public minutes and automatic correction', async t => {
  const f = fixture(t); f.add();
  f.registry.saveMinutes(buildMinutes(f.registry.get(f.id), f.registry.sessions(f.id), f.registry.segments(f.id), []));
  f.registry.save({ ...f.registry.get(f.id), test_run: true });
  f.ai.saveSettings({ model: 'fixture-model', automatic: true }); f.ai.auto();
  assert.ok(!f.ai.pending); assert.equal(f.calls.length, 0);
  const { viewerMinuteList, viewerMinutes } = await import('../src/viewer-minutes.mjs');
  assert.equal(viewerMinuteList(f.registry).length, 0); assert.equal(viewerMinutes(f.registry, f.id), null);
  assert.equal(f.registry.minuteList().length, 1);
});
