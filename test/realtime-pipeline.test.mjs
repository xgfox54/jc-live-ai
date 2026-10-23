import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Segmenter } from '../src/segmenter.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService, correctionIssue } from '../src/ai-correction.mjs';
import { LiveCorrection } from '../src/live-correction.mjs';
import { viewerLiveSegment } from '../src/viewer.mjs';

const tone = seconds => { const pcm = Buffer.alloc(seconds * 32000); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), i); return pcm; };
const quiet = seconds => Buffer.alloc(Math.round(seconds * 32000));
const until = async check => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

test('primary recognition opts speech into live preview and silence creates no draft', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const engine = { ready: true, metadata: {}, stop: async () => {}, transcribe: async () => {
    calls++; return { spans: [{ text: '인식 결과를 전달합니다.' }], inference_ms: 10 };
  } };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 4, silenceRms: 100, segmentSeconds: [5, 5] });
  try {
    const state = scheduler.start({ stream_id: 'ch1' });
    for (let seq = 0; seq < 5; seq++) scheduler.feed('ch1', { session_id: state.session_id, epoch: 0, seq, pcm: tone(1) });
    await until(() => !scheduler.busy);
    const rows = store.segments({ stream: 'ch1' }).items;
    assert.equal(rows.length, 1); assert.equal(rows[0].live_preview, true);
    assert.equal(viewerLiveSegment(rows[0]).text, '인식 결과를 전달합니다.');
    for (let seq = 5; seq < 10; seq++) scheduler.feed('ch1', { session_id: state.session_id, epoch: 0, seq, pcm: quiet(1) });
    await until(() => !scheduler.busy);
    assert.equal(calls, 1); assert.equal(store.liveSegments('ch1').length, 1);
  } finally { await scheduler.close(); store.close(); }
});

test('segmenter closes the first chunk inside a pause and keeps every chunk between the minimum and maximum length', () => {
  // Given speech, a half-second pause at 6 s, then more speech
  const segmenter = new Segmenter({ minS: 4, maxS: 10 });
  // When
  const pieces = segmenter.push(Buffer.concat([tone(6), quiet(0.5), tone(5)]));
  // Then the cut lands inside the pause and no chunk is shorter than 4 s or longer than 10 s
  assert.ok(pieces[0].end_ms > 6000 && pieces[0].end_ms < 6500, String(pieces[0].end_ms));
  for (const piece of pieces) assert.ok(piece.end_ms - piece.start_ms >= 4000 && piece.end_ms - piece.start_ms <= 10000);
  const rest = segmenter.flush(); assert.equal(rest[0]?.start_ms ?? pieces.at(-1).end_ms, pieces.at(-1).end_ms);
});
test('segmenter forces a cut at the maximum length when nobody pauses', () => {
  const segmenter = new Segmenter({ minS: 4, maxS: 8 });
  const pieces = segmenter.push(tone(12));
  assert.equal(pieces.length, 1); assert.ok(pieces[0].end_ms >= 4000 && pieces[0].end_ms <= 8000);
});
test('an engine pool runs different streams in parallel while each stream stays in order', async () => {
  // Given a two-slot engine that records overlap
  let running = 0; let peak = 0; const order = new Map(); const perStream = new Map();
  const engine = { ready: true, capacity: 2, metadata: {}, stop: async () => {}, transcribe: async job => {
    running++; peak = Math.max(peak, running);
    perStream.set(job.stream_id, (perStream.get(job.stream_id) ?? 0) + 1);
    assert.equal(perStream.get(job.stream_id), 1, 'one chunk per stream at a time');
    await new Promise(resolve => setTimeout(resolve, 10));
    perStream.set(job.stream_id, perStream.get(job.stream_id) - 1); running--;
    order.set(job.stream_id, [...(order.get(job.stream_id) ?? []), job.start_ms]);
    return { spans: [{ text: 'x' }], inference_ms: 10 };
  } };
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 12, silenceRms: 0, segmentSeconds: [5, 5] });
  // When three streams each send 20 s
  for (const id of ['ch1', 'ch2', 'ch3']) {
    const c = scheduler.start({ stream_id: id });
    for (let seq = 0; seq < 20; seq++) scheduler.feed(id, { session_id: c.session_id, epoch: 0, seq, pcm: quiet(1) });
  }
  await until(() => !scheduler.busy);
  // Then two chunks overlapped and each stream kept its time order
  assert.equal(peak, 2);
  for (const id of ['ch1', 'ch2', 'ch3']) assert.deepEqual(order.get(id), [0, 5000, 10000, 15000]);
  await scheduler.close(); store.close();
});
test('number check accepts spelling variants of one amount and still flags changed values', () => {
  for (const [source, candidate] of [['4천억원', '4000억 원'], ['6천만 원이', '6000만 원이'], ['1억 9천입니다.', '1억 9000만 원입니다.'],
    ['9억 8천만원 증액 1.53%', '9억 8000만 원 증액 1.53%'], ['23년도 24년도', '2023년도, 2024년도'], ['18만 6천원', '18만 6000원']])
    assert.equal(correctionIssue(source, candidate), null, source);
  assert.equal(correctionIssue('712만원으로', '712명으로'), 'numbers');
  assert.equal(correctionIssue('9억 원', '8억 원'), 'numbers');
  assert.equal(correctionIssue('그 이거는 우리', '이것은'), null);
});

test('next channel diarization runs while the single Whisper slot is occupied', async () => {
  const store = new Store(':memory:'); const prepared = []; const recognized = [];
  let release; let running = 0; let peak = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const engine = { ready: true, capacity: 1, get available() { return 1 - running; }, metadata: {}, stop: async () => {},
    transcribe: async job => {
      running++; peak = Math.max(peak, running); recognized.push(job.stream_id);
      if (recognized.length === 1) await gate;
      running--; return { spans: [{ text: '회의를 진행합니다.' }], inference_ms: 1 };
    } };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 4, silenceRms: 0 });
  scheduler.diarizer = { engine: { ready: true }, process: async job => {
    prepared.push(job.stream_id);
    return { speaker_state: 'assigned', speaker_turns: [{ start_ms: job.start_ms, end_ms: job.end_ms, speaker_id: 1 }] };
  }, finish: async () => {}, close: async () => {} };
  try {
    for (const id of ['ch1', 'ch2']) {
      const state = scheduler.start({ stream_id: id });
      for (let seq = 0; seq < 5; seq++) scheduler.feed(id, { session_id: state.session_id, epoch: 0, seq, pcm: tone(1) });
      if (id === 'ch1') await until(() => recognized.length === 1);
    }
    await until(() => prepared.length === 2);
    assert.deepEqual(prepared, ['ch1', 'ch2'], 'second channel must prepare before the first GPU inference completes');
    assert.deepEqual(recognized, ['ch1']);
    release(); await until(() => !scheduler.busy);
    assert.equal(peak, 1); assert.deepEqual(recognized, ['ch1', 'ch2']);
    assert.equal(store.snapshot(['ch1', 'ch2']).segments.length, 2);
  } finally { release(); await scheduler.close(); store.close(); }
});

function liveFixture(t, reply) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const scheduler = { states: () => [], channels: new Map() };
  const calls = [];
  const aiFetch = async (url, options) => {
    const body = JSON.parse(options.body); const style = body.messages[0].content.startsWith('한국어 회의') ? 'plain' : 'minutes';
    calls.push(style); const segments = JSON.parse(body.messages[1].content).segments;
    const content = JSON.stringify({ corrections: segments.map(part => ({ id: part.id, text: reply(part.text, style) })) });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
  };
  const ai = new CorrectionService({ store, registry, scheduler, aiFetch });
  ai.saveSettings({ model: 'fixture', automatic: true, provider: 'proxy', base: 'http://127.0.0.1:10100/v1' });
  const live = new LiveCorrection({ store, registry, ai, hedgeMs: 1000, timeoutMs: 2000 });
  const page_url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const record = registry.upsert({ page_url, sources: [page_url], title: '즉시 후보정 시험', kind: 'youtube' });
  registry.attach({ stream_id: 'ch2', broadcast_id: record.id }, { session_id: 'live-session' });
  const add = text => store.segment({ stream_id: 'ch2', session_id: 'live-session', start_ms: 0, end_ms: 6000, raw_text: text,
    ready_ms: Date.now(), audio_received_ms: Date.now() });
  const read = id => JSON.parse(store.db.prepare('SELECT document FROM segments WHERE id=?').get(id).document);
  t.after(async () => { await live.close(); await ai.close(); store.close(); });
  return { store, live, calls, add, read };
}
test('a new segment is corrected and published immediately even after its speaker label changes the version', async t => {
  // Given automatic proxy correction
  const f = liveFixture(t, text => text.replace('어 그 돌봄 써비스', '돌봄 서비스'));
  // When a segment arrives and diarization annotates it before the reply
  const row = f.add('어 그 돌봄 써비스 예산입니다.');
  f.store.db.prepare('UPDATE segments SET version=2, document=? WHERE id=?').run(JSON.stringify({ ...f.read(row.segment_id), version: 2 }), row.segment_id);
  await until(() => f.read(row.segment_id).corrected_text !== null);
  // Then the corrected sentence is public without an administrator action
  const segment = f.read(row.segment_id);
  assert.equal(segment.corrected_text, '돌봄 서비스 예산입니다.'); assert.equal(segment.ai_corrected, true);
  assert.equal(f.live.metrics.applied, 1);
});
test('a flagged minutes-style edit falls back to a word-preserving correction before publication', async t => {
  // Given a minutes-style reply that changes an amount and a plain reply that keeps it
  const f = liveFixture(t, (text, style) => style === 'minutes' ? text.replace('100원', '200원') : text.replace('써비스', '서비스'));
  // When
  const row = f.add('써비스 예산은 100원입니다.');
  await until(() => f.read(row.segment_id).corrected_text !== null);
  // Then the safe fallback is published and the flagged edit stays for review
  assert.equal(f.read(row.segment_id).corrected_text, '서비스 예산은 100원입니다.');
  assert.deepEqual(f.calls, ['minutes', 'plain']);
  const issues = f.store.db.prepare("SELECT json_extract(document,'$.issue') AS issue FROM ai_candidates").all().map(row => row.issue);
  assert.deepEqual(issues.sort(), [null, 'numbers'].sort());
});


function refineFixture(t, replies, { delay = 30, nextWaitMs = 40 } = {}) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const requests = [];
  const aiFetch = async (url, options) => {
    const body = JSON.parse(options.body); const input = JSON.parse(body.messages[1].content); const segments = input.segments;
    requests.push({ model: body.model, input });
    if (body.model === 'refiner') await new Promise(resolve => setTimeout(resolve, delay));
    const content = JSON.stringify({ corrections: segments.map(part => ({ id: part.id, text: replies[body.model](part.text) })) });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
  };
  const ai = new CorrectionService({ store, registry, scheduler: { states: () => [], channels: new Map() }, aiFetch });
  ai.saveSettings({ model: 'fast', refine_model: 'refiner', automatic: true, provider: 'proxy', base: 'http://127.0.0.1:10100/v1' });
  const live = new LiveCorrection({ store, registry, ai, hedgeMs: 1000, timeoutMs: 2000, nextWaitMs });
  const page_url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const record = registry.upsert({ page_url, sources: [page_url], title: '정밀 후보정 시험', kind: 'youtube' });
  registry.attach({ stream_id: 'ch3', broadcast_id: record.id }, { session_id: 'refine-session' });
  let start = 0;
  const add = (text, extra = {}) => { start += 6000; return store.segment({ stream_id: 'ch3', session_id: 'refine-session', start_ms: start - 6000, end_ms: start,
    raw_text: text, ready_ms: Date.now(), audio_received_ms: Date.now(), ...extra }); };
  const read = id => JSON.parse(store.db.prepare('SELECT document FROM segments WHERE id=?').get(id).document);
  t.after(async () => { await live.close(); await ai.close(); store.close(); });
  return { store, live, add, read, requests };
}
test('the refinement model replaces the fast correction after it is published', async t => {
  // Given a fast model and a slower, better refinement model
  const f = refineFixture(t, { fast: text => text.replace('써비스', '서비스'), refiner: () => '돌봄 서비스 예산입니다.' });
  // When
  const row = f.add('돌봄 써비스 예산 입니다');
  await until(() => f.read(row.segment_id).corrected_text === '돌봄 서비스 예산 입니다');
  await until(() => f.live.metrics.refine_applied === 1);
  // Then the fast text was public first and the refined text replaced it
  assert.equal(f.read(row.segment_id).corrected_text, '돌봄 서비스 예산입니다.');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM corrections WHERE segment_id=?').get(row.segment_id).n, 2);
});
test('refinement keeps an administrator edit and does not publish a changed amount', async t => {
  // Given a refinement that changes the amount
  const f = refineFixture(t, { fast: text => text, refiner: text => text.replace('100원', '200원') }, { delay: 60 });
  // When one sentence is edited by hand before the refinement arrives
  const edited = f.add('예산 100원입니다.'); const flagged = f.add('예산은 100원입니다.');
  await until(() => f.read(edited.segment_id).corrected_text !== null && f.read(flagged.segment_id).corrected_text !== null);
  const current = f.read(edited.segment_id);
  f.store.correct(edited.segment_id, { version: current.version, text: '예산 100원입니다(관리자).', origin: 'manual' });
  await until(() => f.live.metrics.refine_skipped + f.live.metrics.refine_held >= 2);
  // Then
  assert.equal(f.read(edited.segment_id).corrected_text, '예산 100원입니다(관리자).');
  assert.equal(f.read(flagged.segment_id).corrected_text, '예산은 100원입니다.');
  assert.equal(f.live.metrics.refine_applied, 0);
});
test('refinement waits for the next sentence and receives both recognizer results', async t => {
  // Given a segment with a second recognizer result, followed by the next sentence
  const f = refineFixture(t, { fast: text => text, refiner: text => text + '.' }, { nextWaitMs: 5000 });
  const first = f.add('예산이 올', { alt_text: '예산이 올라' });
  await until(() => f.read(first.segment_id).corrected_text !== null);
  assert.equal(f.requests.filter(r => r.model === 'refiner').length, 0);
  // When the next sentence arrives
  f.add('라갔습니다');
  await until(() => f.live.metrics.refine_applied >= 1);
  // Then the refinement request carried the next sentence and the alternative recognizer text
  const refine = f.requests.find(r => r.model === 'refiner');
  assert.equal(refine.input.next, '라갔습니다');
  assert.equal(refine.input.segments[0].alt, '예산이 올라');
  assert.equal(f.requests.find(r => r.model === 'fast').input.segments[0].alt, undefined);
});



test('speaker directory parses official video minutes and gives the newest same-committee names before the meeting day', async () => {
  // Given two published video-minute pages and one page whose minutes are not yet published
  const page = (title, labels) => new TextEncoder().encode('<div class="head"><h1>x</h1><p>' + title + '</p></div>' + labels.map(l => '<div>○' + l + '  <br /></div>').join(''));
  const pages = { 3601: page('제450회 임시회 제1차 행정자치위원회 (2026-06-01 월요일)', ['자치행정국장 홍길동', '김위원 위원']),
    3602: page('제451회 임시회 제1차 교육위원회 (2026-06-02 화요일)', ['교육국장 이교육']), 3603: page('제452회 임시회 제1차 행정자치위원회 (2026-07-01 수요일)', []) };
  const fetcher = async url => { const id = Number(new URL(url).searchParams.get('fidx'));
    return pages[id] ? new Response(pages[id]) : new Response('', { status: 404 }); };
  const { SpeakerDirectory } = await import('../src/speaker-directory.mjs');
  const directory = new SpeakerDirectory({ file: join(tmpdir(), 'speakers-' + process.pid + '.json'), fetcher, startAt: 3601, misses: 2, delayMs: 0, now: () => Date.parse('2026-07-02') });
  // When
  await directory.refresh();
  // Then labels come only from the same committee and the unpublished page is kept for a later retry
  assert.deepEqual(directory.glossaryFor('행정자치위원회'), ['김위원 위원', '자치행정국장 홍길동']);
  assert.deepEqual(directory.glossaryFor('교육위원회'), ['교육국장 이교육']);
  assert.equal(directory.meetings.find(item => item.fidx === 3603).labels.length, 0);
});
