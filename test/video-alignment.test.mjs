import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedOffsets, videoOffsets, ALIGNMENT_METHOD } from '../src/video-alignment.mjs';
import { buildMinutes } from '../src/minutes.mjs';
import { publicMinutes } from '../web/lib/model.mjs';

const probe = (session, offset_s, status = 'matched') => ({ session, pcm_s: 15, offset_s, status });
test('only consistent, mostly matched sessions receive a video offset', () => {
  const result = { probes: [probe('a', 2165.075), probe('a', 2165.075), probe('a', 2165.08), { session: 'a', status: 'silent' },
    probe('b', 10), probe('b', 10),
    probe('c', 30), probe('c', 30.5), probe('c', 30),
    probe('d', 5), probe('d', 5), probe('d', 5), probe('d', 9, 'ambiguous'), probe('d', 9, 'ambiguous')] };
  const accepted = acceptedOffsets(result, { one: 'a', two: 'b', three: 'c', four: 'd' });
  assert.deepEqual(Object.keys(accepted), ['one']);
  assert.equal(accepted.one.offset_ms, 2165075); assert.equal(accepted.one.spread_ms, 5); assert.equal(accepted.one.probes, 4);
});

test('aligned sessions use the video clock in labels, gaps and public minutes; restarted epochs keep collection time', () => {
  const row = (id, session_id, start_ms, epoch = 0) => ({ segment_id: 's' + id, session_id, timeline_epoch: epoch, start_ms, end_ms: start_ms + 5000,
    corrected_text: '발언 ' + id, ai_corrected: true });
  const sessions = [{ session_id: 'one', state: 'stopped' }, { session_id: 'two', state: 'stopped' }];
  const rows = [row(1, 'one', 0), row(2, 'one', 60000), row(3, 'two', 0), row(4, 'two', 10000, 1)];
  const alignment = { phase: 'complete', method: ALIGNMENT_METHOD, video_id: 'pwvxi_rX3ao', sessions: { one: { offset_ms: 2165075 }, two: { offset_ms: 7574930 } } };
  assert.deepEqual([...videoOffsets(alignment, sessions, rows)], [['one', 2165075]]);
  assert.equal(videoOffsets({ ...alignment, phase: 'failed' }, sessions, rows).size, 0);
  const value = buildMinutes({ id: 'a'.repeat(64), title: '시험', sources: [], stream_id: 'ch0' }, sessions, rows,
    [{ session_id: 'one', timeline_epoch: 0, start_ms: 30000, end_ms: 31000, reason: 'queue_overflow' }], { videoAlignment: alignment });
  assert.equal(value.transcript[0].start_ms, 2165075); assert.equal(value.transcript[0].video_time, true);
  assert.equal(value.transcript[2].start_ms, 0); assert.equal(value.transcript[2].video_time, undefined);
  assert.equal(value.gaps[0].start_ms, 2195075);
  assert.match(value.markdown, /영상 00:36:05~00:36:10/);
  assert.ok(value.warnings.some(text => text.startsWith('"영상"으로 표시한 시각')));
  const published = publicMinutes({ ...value, publication_policy: 'ai-corrected-v1' });
  assert.equal(published.transcript[0].video_time, true); assert.deepEqual(published.video_alignment, { video_id: 'pwvxi_rX3ao', sessions: [{ session_number: 1, offset_ms: 2165075 }] });
  assert.throws(() => publicMinutes({ ...value, publication_policy: 'ai-corrected-v1', video_alignment: { video_id: 'javascript:x', sessions: [] } }));
});

