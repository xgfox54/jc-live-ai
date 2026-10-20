import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { TranscriptState } from '../public/client-state.mjs';
import { evaluateSeek, visibleAt } from '../public/player.mjs';
import { sourcePage } from '../src/validate.mjs';

const config = { chunkSeconds: 5, queueChunks: 2, silenceRms: 0 };
const fakeEngine = () => ({ ready: true, metadata: { test_only: true }, stop: async () => {},
  transcribe: async job => ({ spans: [{ text: job.prompt }], inference_ms: 1 }) });
const pcm = Buffer.alloc(32000);
function send(scheduler, id, count = 5) {
  const c = scheduler.channel(id);
  for (let seq = 0; seq < count; seq++) scheduler.feed(id,
    { session_id: c.session_id, epoch: c.timeline_epoch, seq, pcm });
}
async function settled(scheduler) {
  while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
}
test('eight streams preserve distinct prompts and sessions through shared worker', async () => {
  // Given
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, fakeEngine(), config);
  for (let i = 1; i <= 8; i++) scheduler.start({ stream_id: 'ch' + i, prompt: 'text-' + i });
  // When
  for (let i = 1; i <= 8; i++) send(scheduler, 'ch' + i);
  await settled(scheduler);
  // Then
  const segments = store.snapshot([...scheduler.channels.keys()]).segments;
  assert.equal(segments.length, 8); assert.equal(new Set(segments.map(s => s.session_id)).size, 8);
  for (const segment of segments) assert.equal(segment.raw_text, 'text-' + segment.stream_id.slice(2));
  await scheduler.close(); store.close();
});
test('duplicate packets are idempotent and missing sequence requires discontinuity', async () => {
  // Given
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, fakeEngine(), config);
  const c = scheduler.start({ stream_id: 'ch1' });
  const packet = { session_id: c.session_id, epoch: 0, seq: 0, pcm };
  scheduler.feed('ch1', packet);
  // When
  const result = scheduler.feed('ch1', packet);
  // Then
  assert.equal(result.duplicate, true); assert.equal(scheduler.channel('ch1').total_received_s, 1);
  assert.throws(() => scheduler.feed('ch1', { ...packet, seq: 2 }), /Missing packet/);
  await scheduler.close(); store.close();
});
test('queue overflow produces a durable gap while other channels continue', async () => {
  // Given
  const store = new Store(':memory:'); const engine = fakeEngine(); let release;
  engine.transcribe = () => new Promise(resolve => { release = () => resolve({ spans: [], inference_ms: 1 }); });
  const scheduler = new Scheduler(store, engine, config); scheduler.start({ stream_id: 'ch1' }); send(scheduler, 'ch1');
  // When
  const c = scheduler.channel('ch1');
  for (let seq = 5; seq < 30; seq++) scheduler.feed('ch1', { session_id: c.session_id, epoch: 0, seq, pcm });
  // Then
  assert.equal(c.queue.length, 2); assert.equal(scheduler.metrics.gaps, 3);
  assert.equal(store.events(0).filter(e => e.kind === 'gap').length, 3);
  engine.transcribe = fakeEngine().transcribe; release(); await settled(scheduler);
  await scheduler.close(); store.close();
});
test('silence advances processed audio without inventing speech', async () => {
  // Given
  const store = new Store(':memory:'); const engine = fakeEngine();
  engine.transcribe = () => { throw new Error('Silence must bypass inference'); };
  const scheduler = new Scheduler(store, engine, { ...config, silenceRms: 0.001 });
  scheduler.start({ stream_id: 'ch1' });
  // When
  send(scheduler, 'ch1'); await settled(scheduler);
  // Then
  assert.equal(scheduler.channel('ch1').audio_processed_until, 5000);
  assert.equal(scheduler.channel('ch1').last_speech_segment_end, null);
  assert.equal(store.snapshot(['ch1']).segments.length, 0);
  await scheduler.close(); store.close();
});
test('correction and event survive reopen while raw text and history are preserved', () => {
  // Given
  const dir = mkdtempSync(join(tmpdir(), 'sr-live-')); let store = new Store(join(dir, 'db.sqlite'));
  const segment = store.segment({ stream_id: 'ch1', session_id: 'session', start_ms: 0, end_ms: 5000, raw_text: 'original' });
  // When
  store.correct(segment.segment_id, { version: 1, text: '<script>unsafe()</script>' }); store.close();
  store = new Store(join(dir, 'db.sqlite'));
  // Then
  const saved = store.snapshot(['ch1']).segments[0];
  assert.equal(saved.raw_text, 'original'); assert.equal(saved.version, 2);
  assert.equal(store.events(0).length, 2);
  assert.throws(() => store.correct(segment.segment_id, { version: 1, text: 'stale' }), /conflict/);
  store.close(); rmSync(dir, { recursive: true });
});
test('client ignores duplicate and reordered events but keeps actual repeated sentences', () => {
  // Given
  const state = new TranscriptState();
  const a = { segment_id: 'a', stream_id: 'ch1', raw_text: 'repeat', version: 1 };
  state.apply({ event_id: 1, kind: 'segment', payload: a });
  // When
  state.apply({ event_id: 3, kind: 'segment', payload: { ...a, corrected_text: 'review', version: 2 } });
  state.apply({ event_id: 2, kind: 'segment', payload: a });
  state.apply({ event_id: 4, kind: 'segment', payload: { ...a, segment_id: 'b' } });
  // Then
  assert.equal(state.segments.size, 2); assert.equal(state.segments.get('a').version, 2);
});
test('unverified or wrong-epoch player cannot expose future captions', () => {
  // Given
  const segment = { session_id: 'a', timeline_epoch: 1, start_ms: 5000, end_ms: 10000 };
  // When / Then
  assert.equal(visibleAt(segment, null), false);
  assert.equal(visibleAt(segment, { session: 'a', epoch: 0, audioMs: 9000 }), false);
  assert.equal(visibleAt(segment, { session: 'a', epoch: 1, audioMs: 4999 }), false);
  assert.equal(visibleAt(segment, { session: 'a', epoch: 1, audioMs: 9999 }), false);
  assert.equal(visibleAt(segment, { session: 'a', epoch: 1, audioMs: 10000 }), true);
  assert.equal(evaluateSeek(90, 60).supported, false);
  assert.equal(evaluateSeek(61, 60).supported, true);
});
test('source pages reject internal hosts, credentials and unsupported schemes', () => {
  // Given
  const blocked = ['http://127.0.0.1/a', 'https://169.254.169.254/', 'file:///C:/x',
    'https://www.youtube.com.evil.test/a', 'https://user@www.youtube.com/watch?v=x'];
  // When / Then
  for (const url of blocked) assert.throws(() => sourcePage(url));
  assert.equal(sourcePage('https://www.council.jeju.kr/broadcast/index.do'), 'https://www.council.jeju.kr/broadcast/index.do');
});
