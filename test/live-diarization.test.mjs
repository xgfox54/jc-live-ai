import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { LiveDiarization, speakerAnnotation } from '../src/live-diarization.mjs';
import { viewerSegment } from '../src/viewer.mjs';
import { publicSegment } from '../web/lib/model.mjs';
import { speakerText } from '../public/speakers.mjs';

class CacheEngine {
  constructor() { this.ready = true; this.states = new Map(); this.maximum = 0; }
  async request(operation, key, pcm) {
    if (operation === 'open') {
      assert.ok(!this.states.has(key)); this.states.set(key, { seconds: 0, segments: [] });
      this.maximum = Math.max(this.maximum, this.states.size);
    }
    const state = this.states.get(key);
    if (operation === 'push') {
      if (this.failNext) { this.failNext = false; throw new Error('native failure'); }
      const end = state.seconds + pcm.length / 32000;
      state.segments.push({ start: state.seconds, end, speaker: pcm.readInt16LE(2) }); state.seconds = end;
    }
    const result = { key, processed_s: state?.seconds ?? 0, segments: state?.segments ?? [], inference_ms: 1 };
    if (operation === 'close') this.states.delete(key);
    return result;
  }
  async stop() { assert.equal(this.states.size, 0); }
}
function fixture() {
  const store = new Store(':memory:'); const native = new CacheEngine();
  const engine = { ready: true, metadata: {}, stop: async () => {}, transcribe: async job =>
    ({ spans: [{ text: '방송-' + job.pcm.readInt16LE(0) }], inference_ms: 1 }) };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 12, silenceRms: 0 });
  scheduler.diarizer = new LiveDiarization(store, {}, native);
  return { store, scheduler, native };
}
function feed(scheduler, id, speaker) {
  const channel = scheduler.channel(id); const pcm = Buffer.alloc(32000);
  pcm.writeInt16LE(Number(id.slice(2)), 0); pcm.writeInt16LE(speaker, 2);
  for (let n = 0; n < 5; n++) scheduler.feed(id,
    { session_id: channel.session_id, epoch: channel.timeline_epoch, seq: channel.next_seq, pcm });
}
async function settled(scheduler) {
  const deadline = Date.now() + 3000;
  while (scheduler.busy || scheduler.finishes.size) {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve));
  }
}

test('eight channel caches preserve 64 local speaker slots without cross-channel results', async () => {
  const f = fixture();
  try {
    for (let channel = 1; channel <= 8; channel++) f.scheduler.start({ stream_id: 'ch' + channel });
    for (let speaker = 1; speaker <= 8; speaker++) for (let channel = 1; channel <= 8; channel++) feed(f.scheduler, 'ch' + channel, speaker);
    for (let channel = 1; channel <= 8; channel++) f.scheduler.stop('ch' + channel);
    await settled(f.scheduler);
    const all = Array.from({ length: 8 }, (_, i) => f.store.segments({ stream: 'ch' + (i + 1), limit: 200 }).items).flat();
    assert.equal(all.length, 64); assert.equal(f.native.maximum, 8);
    assert.equal(new Set(all.map(row => row.speaker_scope)).size, 8);
    for (let channel = 1; channel <= 8; channel++) {
      const rows = all.filter(row => row.stream_id === 'ch' + channel);
      assert.deepEqual(rows.map(row => row.speaker_id).sort(), [1,2,3,4,5,6,7,8]);
      assert.ok(rows.every(row => row.raw_text === '방송-' + channel && row.speaker_state === 'assigned'));
    }
    assert.equal(f.scheduler.diarizer.metrics.errors, 0);
  } finally { await f.scheduler.close(); f.store.close(); }
});

test('epoch and missing-audio boundaries finalize the old cache and use a fresh speaker scope', async () => {
  const f = fixture();
  try {
    f.scheduler.start({ stream_id: 'ch1' }); feed(f.scheduler, 'ch1', 2); await settled(f.scheduler);
    const original = f.store.segments({ stream: 'ch1' }).items[0]; assert.equal(original.speaker_state, 'pending');
    f.scheduler.epoch('ch1'); feed(f.scheduler, 'ch1', 7); f.scheduler.stop('ch1'); await settled(f.scheduler);
    const rows = f.store.segments({ stream: 'ch1' }).items;
    assert.equal(rows[0].speaker_id, 2); assert.equal(rows[1].speaker_id, 7);
    assert.notEqual(rows[0].speaker_scope, rows[1].speaker_scope);
    assert.equal(f.scheduler.diarizer.metrics.resets, 1);
  } finally { await f.scheduler.close(); f.store.close(); }
});

test('a native failure marks pending speakers unavailable while transcription continues', async () => {
  const f = fixture();
  try {
    f.scheduler.start({ stream_id: 'ch1' }); feed(f.scheduler, 'ch1', 1); await settled(f.scheduler);
    f.native.failNext = true; feed(f.scheduler, 'ch1', 2); await settled(f.scheduler);
    feed(f.scheduler, 'ch1', 3); f.scheduler.stop('ch1'); await settled(f.scheduler);
    const rows = f.store.segments({ stream: 'ch1' }).items;
    assert.equal(rows.length, 3); assert.equal(rows[0].speaker_state, 'unavailable');
    assert.equal(rows[1].speaker_state, 'unavailable'); assert.equal(rows[2].speaker_id, 3);
    assert.equal(f.scheduler.metrics.errors, 0); assert.equal(f.scheduler.diarizer.metrics.errors, 1);
  } finally { await f.scheduler.close(); f.store.close(); }
});

test('mixed speakers remain interval labels rather than an invented single speaker', () => {
  const job = { start_ms: 0, end_ms: 1000 };
  const context = { base_ms: 0, next_ms: 1000, scope: 'scope-one', finished: true };
  const reply = { processed_s: 1, segments: [{ start: 0, end: .5, speaker: 1 }, { start: .5, end: 1, speaker: 8 }] };
  const value = speakerAnnotation(job, reply, context);
  assert.equal(value.speaker_state, 'multiple'); assert.equal(value.speaker_id, null);
  assert.match(speakerText(value), /1·8/);
  assert.throws(() => speakerAnnotation(job, { ...reply, processed_s: 99 }, context));
  assert.throws(() => speakerAnnotation(job, { ...reply, segments: [{ start: 0, end: 1, speaker: 9 }] }, context));
});

test('native readiness blocks new input and restart recovery resolves pending labels', async () => {
  const f = fixture();
  try {
    f.native.ready = false;
    assert.throws(() => f.scheduler.start({ stream_id: 'ch1' }), /diarization engine is not ready/);
    f.native.ready = true; f.scheduler.start({ stream_id: 'ch1' });
    feed(f.scheduler, 'ch1', 1); await settled(f.scheduler);
    f.store.recover();
    assert.equal(f.store.segments({ stream: 'ch1' }).items[0].speaker_state, 'unavailable');
    assert.equal(f.store.states()[0].state, 'interrupted');
  } finally { await f.scheduler.close(); f.store.close(); }
});

test('late speaker updates preserve manual choices, AI provenance and public stream scopes', () => {
  const store = new Store(':memory:');
  try {
    const row = store.segment({ stream_id: 'ch1', session_id: 'session-one', timeline_epoch: 0,
      start_ms: 0, end_ms: 1000, raw_text: '보존할 원문', speaker_scope: 'scope-one', speaker_state: 'pending' });
    const corrected = store.correct(row.segment_id, { version: 1, text: '공개 후보정문', origin: 'ai' });
    const annotation = { speaker_scope: 'scope-one', speaker_id: 8, speaker_state: 'assigned',
      speaker_method: 'nemotron-streaming', speaker_turns: [{ start_ms: 0, end_ms: 1000, speaker_id: 8 }] };
    const tagged = store.annotateSpeakers(row.segment_id, annotation);
    assert.equal(tagged.ai_corrected, true); assert.equal(tagged.raw_text, row.raw_text);
    assert.equal(tagged.corrected_text, corrected.corrected_text);
    const published = publicSegment(viewerSegment(tagged));
    assert.equal(published.speaker_scope, 'scope-one'); assert.equal(published.speaker_id, 8);
    assert.equal('raw_text' in published, false);
    store.speaker(row.segment_id, tagged.version, 3);
    assert.equal(store.annotateSpeakers(row.segment_id, annotation), undefined);
    assert.equal(store.segments({ stream: 'ch1' }).items[0].speaker_id, 3);
    assert.equal(store.annotateSpeakers(row.segment_id, { ...annotation, speaker_scope: 'another-broadcast' }), undefined);
    const manual = store.segments({ stream: 'ch1' }).items[0];
    const cleared = store.speaker(row.segment_id, manual.version, null);
    assert.equal(speakerText(viewerSegment(cleared)), '참여자 미확인');
    assert.deepEqual(viewerSegment(cleared).speaker_ids, []);
  } finally { store.close(); }
});
