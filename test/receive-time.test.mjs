import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerSegment } from '../src/viewer.mjs';
import { publicSegment } from '../web/lib/model.mjs';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';

test('public projections preserve actual receive time across sessions without changing audio positions', () => {
  const base = { stream_id: 'ch0', timeline_epoch: 0, version: 1, ai_corrected: true,
    corrected_text: '의사일정을 진행합니다.', raw_text: '비공개 원문' };
  const previous = { ...base, segment_id: 'one', session_id: 'previous', start_ms: 5300000, end_ms: 5310000, audio_received_ms: 1792737400000 };
  const restarted = { ...base, segment_id: 'two', session_id: 'restarted', start_ms: 0, end_ms: 10000, audio_received_ms: 1792737480000 };
  const a = publicSegment(viewerSegment(previous)); const b = publicSegment(viewerSegment(restarted));
  assert.ok(b.audio_received_ms > a.audio_received_ms);
  assert.equal(b.start_ms, 0); assert.equal(b.end_ms, 10000);
  assert.equal(a.start_ms, 5300000);
  assert.equal(b.session_id, 'restarted');
  assert.equal(b.raw_text, undefined);
  assert.equal(b.video_start_ms, undefined);
  assert.equal(viewerSegment({ ...restarted, ai_corrected: false }), null);
  assert.equal(publicSegment(viewerSegment({ ...restarted, audio_received_ms: undefined })).audio_received_ms, null);
  assert.throws(() => publicSegment({ ...b, audio_received_ms: '2026-10-23' }));
  assert.throws(() => publicSegment({ ...b, audio_received_ms: -1 }));
});

test('draining a delayed final audio buffer retains receive time, not shutdown time', async () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { ready: true, metadata: {}, stop: async () => {},
    transcribe: async () => ({ spans: [{ text: '마지막 발언입니다.' }], inference_ms: 0 }) },
  { chunkSeconds: 5, queueChunks: 4, silenceRms: 0 });
  try {
    const s = scheduler.start({ stream_id: 'ch0' }); const receivedMs = Date.now() - 120000;
    scheduler.feed('ch0', { session_id: s.session_id, epoch: 0, seq: 0, pcm: Buffer.alloc(16000, 1) }, { receivedMs });
    scheduler.stop('ch0', 'eof'); await scheduler.close();
    const row = store.snapshot(['ch0']).segments[0];
    assert.equal(row.audio_received_ms, receivedMs);
    assert.equal(scheduler.channel('ch0').last_receive_ms, receivedMs);
    assert.ok(row.ready_ms > receivedMs + 60000);
  } finally { await scheduler.close(); store.close(); }
});
