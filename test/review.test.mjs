import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService } from '../src/ai-correction.mjs';
import { ReviewService, groundedNote, sourceGroups } from '../src/review.mjs';
import { AudioReview } from '../src/audio-review.mjs';
import { parseSpeakers, speakerFor } from '../src/diarization.mjs';
import { CaptureRecording } from '../src/capture-recording.mjs';
import { createService } from '../src/server.mjs';
import { buildMinutes } from '../src/minutes.mjs';
import { viewerMinutes } from '../src/viewer-minutes.mjs';
import { publicMinutes } from '../web/lib/model.mjs';
import { ModelManager } from '../src/model-manager.mjs';
import { TranscriptState } from '../public/client-state.mjs';
import { importAudio } from '../src/import-audio.mjs';

const note = parts => ({ summary: [{ text: parts[0].text, source_id: parts[0].id, quote: parts[0].text }], decisions: [], proposals: [], actions: [], numbers: [], open_questions: [] });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-review-'));
  const config = { adminToken: 'a'.repeat(64), viewerToken: 'b'.repeat(64), chunkSeconds: 5, queueChunks: 12, silenceRms: 0,
    recordings: join(dir, 'recordings'), minutesDirectory: join(dir, 'minutes'), importDirectory: join(dir, 'imports') };
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const engine = { ready: true, metadata: {}, transcribe: async () => ({ spans: [{ text: '재전사 시험 발언입니다.' }], inference_ms: 0 }), stop: async () => {} };
  const scheduler = new Scheduler(store, engine, config);
  const ai = new CorrectionService({ store, registry, scheduler, config }); ai.saveSettings({ provider: 'proxy', model: 'fixture', automatic: false });
  const review = new ReviewService({ store, registry, correctionAI: ai }); const audio = new AudioReview({ store, registry, scheduler, config });
  const record = registry.upsert({ title: '검토 시험', page_url: 'https://www.youtube.com/watch?v=abcdefghijk', sources: ['https://www.youtube.com/watch?v=abcdefghijk'], kind: 'youtube' });
  store.saveSession({ stream_id: 'ch1', session_id: 'source-one', timeline_epoch: 0, state: 'stopped', total_processed_s: 10, audio_processed_until: 10000 });
  registry.attach({ stream_id: 'ch1', broadcast_id: record.id }, { session_id: 'source-one' });
  const add = (text = '사업 예산 100원을 검토합니다.', start = 0) => store.segment({ stream_id: 'ch1', session_id: 'source-one', timeline_epoch: 0, start_ms: start, end_ms: start + 1000, raw_text: text });
  const recording = (seconds = 12) => { const folder = join(config.recordings, 'ch1', 'source-one'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'audio.pcm'), Buffer.alloc(32000 * seconds));
    writeFileSync(join(folder, 'source.json'), JSON.stringify({ stream_id: 'ch1', session_id: 'source-one', format: 's16le', sample_rate: 16000, channels: 1 })); };
  t.after(async () => { await review.close(); await audio.close(); await ai.close(); await scheduler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const publish = () => { for (const row of registry.segments(record.id)) if (!row.ai_corrected) store.correct(row.segment_id, { version: row.version, text: row.raw_text, origin: 'ai' }); };
  return { dir, config, store, registry, scheduler, engine, ai, review, audio, id: record.id, record, add, recording, publish };
}

test('structured notes require literal source quotes and reject invented numbers, owners and unknown sources', () => {
  const sources = [{ id: 's1', text: '담당자는 홍길동이며 사업 예산 100원을 검토합니다.' }];
  const original = note(sources); assert.deepEqual(groundedNote(JSON.stringify(original), sources), original);
  for (const field of [{ source_id: 'missing' }, { quote: '사업 예산 200원' }, { text: '사업 예산 200원입니다.' }, { owner: '김철수' }, { due: '내일' }]) {
    const value = structuredClone(original); Object.assign(value.summary[0], field); assert.throws(() => groundedNote(value, sources));
  }
  assert.throws(() => groundedNote({ summary: [] }, sources));
});

test('saved AI batches resume without regenerating completed work and manual minutes survive later refresh', async t => {
  const f = fixture(t); for (let i = 0; i < 6; i++) f.add(('제' + i + ' 발언을 검토합니다. ').repeat(70), i * 1000);
  assert.throws(() => f.review.start(f.id), error => error.status === 400); f.publish();
  let calls = 0; f.ai.requestText = async messages => { calls++; if (calls === 2) throw new Error('fixture disconnected'); return JSON.stringify(note(JSON.parse(messages[1].content).segments)); };
  f.review.start(f.id); await f.review.pending; assert.equal(f.review.view(f.id).job.phase, 'failed'); const completed = f.review.view(f.id).job.completed; assert.equal(completed, 1);
  f.review.start(f.id); await f.review.pending; const state = f.review.view(f.id); assert.equal(state.job.phase, 'completed'); assert.equal(calls, state.job.total + 1);
  assert.equal(f.store.snapshot(['ch1']).segments[0].corrected_text, f.store.snapshot(['ch1']).segments[0].raw_text);
  f.registry.saveMinutes(buildMinutes(f.record, f.registry.sessions(f.id), f.registry.segments(f.id), []));
  assert.equal(f.registry.minutes(f.id).method, 'grounded_ai');
  f.review.edit(f.id, { version: 0, markdown: '# 담당자 검토본' });
  assert.throws(() => f.review.edit(f.id, { version: 0, markdown: 'stale' }), error => error.status === 409);
  f.registry.saveMinutes(buildMinutes(f.record, f.registry.sessions(f.id), f.registry.segments(f.id), []));
  assert.equal(f.registry.minutes(f.id).markdown, '# 담당자 검토본');
  const first = f.registry.segments(f.id)[0]; f.store.correct(first.segment_id, { version: first.version, text: '담당자가 변경한 전사문' });
  assert.equal(f.review.view(f.id).stale, true); assert.equal(f.registry.minutes(f.id).method, 'manual_review');
  const publicDocument = publicMinutes(viewerMinutes(f.registry, f.id));
  assert.equal(publicDocument.method, 'extractive_transcript'); assert.equal(publicDocument.transcript.length, 6); assert.equal(publicDocument.summary, null);
  assert.doesNotMatch(publicDocument.markdown, /담당자 검토본/); assert.match(publicDocument.markdown, /## 발언 내용 정리/);
});

test('pause persists checkpoint, completed notes are reused and collection blocks local generation', async t => {
  const f = fixture(t); f.add('발언 검토 '.repeat(700)); f.publish(); let calls = 0;
  f.ai.requestText = async messages => { calls++; f.review.pause(f.id); return JSON.stringify(note(JSON.parse(messages[1].content).segments)); };
  f.review.start(f.id); await f.review.pending; assert.equal(f.review.view(f.id).job.phase, 'paused'); assert.equal(calls, 1);
  f.ai.requestText = async messages => { calls++; return JSON.stringify(note(JSON.parse(messages[1].content).segments)); };
  f.review.start(f.id); await f.review.pending; assert.equal(f.review.view(f.id).job.phase, 'completed'); assert.equal(calls, sourceGroups(f.registry.segments(f.id)).length);
  f.ai.saveSettings({ provider: 'ollama', model: 'local-fixture', automatic: false }); f.scheduler.start({ stream_id: 'ch2' });
  assert.throws(() => f.review.start(f.id), error => error.status === 409);
});

test('search reaches older than browser cache, matches both text versions and keeps literal query characters', t => {
  const f = fixture(t); const first = f.add('이전 기록 특별검색어 100%_');
  for (let i = 0; i < 250; i++) f.add('뒤에 저장된 발언 ' + i, (i + 1) * 1000);
  f.store.correct(first.segment_id, { version: 1, text: '검토문에서찾을말' });
  assert.equal(f.review.search(f.id, '특별검색어').items[0].segment_id, first.segment_id);
  assert.equal(f.review.search(f.id, '검토문에서찾을말').items[0].raw_text, first.raw_text);
  assert.equal(f.review.search(f.id, '100%_').items.length, 1);
  assert.ok(f.review.export(f.id, 'raw').includes('특별검색어')); assert.ok(f.review.export(f.id, 'reviewed').includes('검토문에서찾을말'));
  assert.equal(f.review.export(f.id, 'json').corrections.length, 1);
  const page = f.review.search(f.id); assert.equal(page.items.length, 100); assert.ok(page.before); assert.equal(f.review.search(f.id, '', page.before).items.length, 100);
  f.add('반복 의심 문장을 검토하는 발언입니다.', 300000); f.add('반복 의심 문장을 검토하는 발언입니다.', 301000);
  assert.equal(f.review.search(f.id, '', Number.MAX_SAFE_INTEGER, true).items.length, 1);
});

test('stored audio replay bounds, resumable retranscription and separate result records preserve originals', async t => {
  const f = fixture(t); const row = f.add(); f.recording();
  const wav = await f.audio.clip(row.segment_id); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.length, 32044);
  f.store.segment({ stream_id: 'ch1', session_id: 'source-one', timeline_epoch: 1, start_ms: 0, end_ms: 1000, raw_text: '다른 시간축' });
  await assert.rejects(f.audio.clip(f.registry.segments(f.id)[1].segment_id), error => error.status === 409);
  let calls = 0; f.engine.transcribe = async () => { calls++; f.audio.pause(); return { spans: [{ text: '별도 재전사 결과' }], inference_ms: 0 }; };
  const job = await f.audio.start(f.id, { session_id: 'source-one' }); await f.audio.pending;
  assert.equal(f.audio.jobs(f.id)[0].offset, 320000); assert.equal(f.audio.jobs(f.id)[0].phase, 'paused');
  f.engine.transcribe = async () => { calls++; return { spans: [{ text: '재개 결과' }], inference_ms: 0 }; };
  await f.audio.start(f.id, { job_id: job.id }); await f.audio.pending;
  assert.equal(f.audio.jobs(f.id)[0].phase, 'completed'); assert.equal(calls, 2); assert.equal(f.registry.segments(job.result_id).length, 2);
  assert.equal(f.registry.segments(f.id)[0].raw_text, row.raw_text); assert.equal(f.registry.segments(f.id).length, 2);
});

test('participant results validate duration and preserve manually assigned participants', async t => {
  assert.throws(() => parseSpeakers({ segments: [{ start: 0, end: 10, speaker: 9 }] }, 10));
  assert.throws(() => parseSpeakers({ segments: [{ start: 0, end: 11, speaker: 1 }] }, 10));
  assert.equal(speakerFor({ start_ms: 0, end_ms: 1000 }, [{ start: 0, end: 1, speaker: 2 }]), 2);
  const f = fixture(t); f.recording(); const manual = f.add(); const auto = f.add('둘째 발언', 1000);
  f.store.speaker(manual.segment_id, 1, 7);
  await f.audio.diarize(f.id, 'source-one', async () => [{ start: 0, end: 12, speaker: 2 }]); await f.audio.pending;
  const rows = f.registry.segments(f.id); assert.equal(rows[0].speaker_id, 7); assert.equal(rows[1].speaker_id, 2); assert.equal(rows[1].raw_text, auto.raw_text);
});

test('capture recordings ignore duplicate PCM packets and keep exact sample count', t => {
  const f = fixture(t); f.config.recordAudio = true; const state = f.scheduler.start({ stream_id: 'ch2' });
  const recorder = new CaptureRecording(f); const packet = { session_id: state.session_id, epoch: 0, seq: 0, pcm: Buffer.alloc(32000) };
  recorder.append('ch2', packet, f.scheduler.feed('ch2', packet)); recorder.append('ch2', packet, f.scheduler.feed('ch2', packet));
  assert.equal(readFileSync(join(f.config.recordings, 'ch2', state.session_id, 'audio.pcm')).length, 32000);
});

test('saved connections hide encrypted credentials and switching disables automatic data transfer', async t => {
  const f = fixture(t); f.ai.saveSettings({ model: 'fixture', provider: 'proxy', base: 'http://127.0.0.1:10100/v1', automatic: true, auto_apply_safe: true, api_key: 'fixture-private-key' });
  const profile = f.ai.saveProfile('시험 연결'); assert.doesNotMatch(JSON.stringify(f.ai.profiles()), /fixture-private-key|cipher|credential|value/);
  f.ai.saveSettings({ model: 'second', automatic: false }); f.ai.useProfile(profile.id);
  assert.equal(f.ai.settings().model, 'fixture'); assert.equal(f.ai.settings().automatic, false); assert.equal(f.ai.settings().auto_apply_safe, false);
  assert.equal(f.ai.proxyHeaders(f.ai.settings()).Authorization, 'Bearer fixture-private-key');
});

test('workspace APIs enforce administrator and origin checks; diagnostics exclude transcripts and secrets', async t => {
  const f = fixture(t); f.add('private-transcript-marker');
  const service = createService({ store: f.store, scheduler: f.scheduler, config: f.config, inputs: { stop: async () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close());
  const base = 'http://127.0.0.1:' + service.server.address().port;
  const endpoint = '/api/admin/workspace/search?broadcast=' + f.id;
  assert.equal((await fetch(base + endpoint)).status, 401);
  assert.equal((await fetch(base + endpoint, { headers: { Authorization: 'Bearer ' + f.config.viewerToken } })).status, 401);
  assert.equal((await fetch(base + endpoint, { headers: { Authorization: 'Bearer ' + f.config.adminToken, Origin: 'https://evil.test' } })).status, 403);
  const diagnostics = await (await fetch(base + '/api/admin/workspace/diagnostics', { headers: { Authorization: 'Bearer ' + f.config.adminToken } })).text();
  assert.doesNotMatch(diagnostics, /private-transcript-marker|aaaaaa|bbbbb|127.0.0.1:10100|api_key/);
  assert.equal((await fetch(base + endpoint, { headers: { Authorization: 'Bearer ' + f.config.adminToken } })).status, 200);
});

test('provisional inference remains outside final storage and final speech replaces the preview', async t => {
  const f = fixture(t); f.config.chunkSeconds = 10; f.config.interim = true;
  let calls = 0; f.engine.transcribe = async () => ({ spans: [{ text: ++calls === 1 ? '처리 중인 미확정 문장' : '최종 확정 문장' }], inference_ms: 1 });
  const stream = f.scheduler.start({ stream_id: 'ch2' }); const client = new TranscriptState(); const events = [];
  f.store.on('event', event => { events.push(event); client.apply(event); });
  for (let seq = 0; seq < 5; seq++) f.scheduler.feed('ch2', { session_id: stream.session_id, epoch: 0, seq, pcm: Buffer.alloc(32000) });
  while (f.scheduler.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.segments({ stream: 'ch2' }).items.length, 0); assert.equal(client.partials.get('ch2').raw_text, '처리 중인 미확정 문장');
  for (let seq = 5; seq < 10; seq++) f.scheduler.feed('ch2', { session_id: stream.session_id, epoch: 0, seq, pcm: Buffer.alloc(32000) });
  while (f.scheduler.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.segments({ stream: 'ch2' }).items[0].raw_text, '최종 확정 문장'); assert.equal(client.partials.size, 0);
  assert.equal(f.scheduler.metrics.unique_audio_s, 10); assert.equal(events.filter(event => event.kind === 'partial').length, 1);
});

test('local model download parses streaming progress, refuses active processing and protects selected model from deletion', async t => {
  const f = fixture(t); const requests = [];
  const manager = new ModelManager(f.ai, async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response('{"status":"pulling","completed":50,"total":100}\n{"status":"success"}\n'); });
  manager.start('fixture-local:1'); await manager.pending; assert.equal(manager.status.phase, 'completed'); assert.equal(f.ai.externalBusy, false);
  await manager.remove('unused-local'); assert.equal(requests.at(-1).url, 'http://127.0.0.1:11434/api/delete');
  await assert.rejects(manager.remove('fixture'), error => error.status === 409);
  f.scheduler.start({ stream_id: 'ch2' }); assert.throws(() => manager.start('another'), error => error.status === 409); await manager.close();
});

test('file import validates source approval, extension and size before decoding', async t => {
  const f = fixture(t); let decoding = 0;
  const context = { ...f, inputs: { isActive: () => false, start: async () => { decoding++; } }, minutes: { attach: (stream, session) => f.registry.attach(stream, session) } };
  const req = data => { const iterable = (async function* () { yield data; })(); iterable.headers = {}; return iterable; };
  for (const query of ['stream=ch1&name=fixture.wav', 'stream=ch13&name=fixture.wav&approved=1', 'stream=ch1&name=fixture.exe&approved=1'])
    await assert.rejects(importAudio(context, req(Buffer.alloc(10)), new URL('http://localhost/?' + query)), error => error.status === 400);
  const oversized = req(Buffer.alloc(0)); oversized.headers['content-length'] = 300 * 1024 * 1024;
  await assert.rejects(importAudio(context, oversized, new URL('http://localhost/?stream=ch2&name=fixture.wav&approved=1')), error => error.status === 413);
  await assert.rejects(importAudio(context, req(Buffer.alloc(32)), new URL('http://localhost/?stream=ch2&name=fixture.wav&approved=1')), error => error.status === 400);
  const wav = Buffer.alloc(32); wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1');
  const result = await importAudio(context, req(wav), new URL('http://localhost/?stream=ch2&name=fixture.wav&approved=1'));
  assert.equal(result.bytes, 32); assert.equal(decoding, 1); assert.equal(f.store.streams().find(stream => stream.stream_id === 'ch2').approved, true);
});
