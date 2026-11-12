import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { viewerLiveSegment, viewerSnapshot } from '../src/viewer.mjs';
import { publicLiveSegment, publicSnapshot } from '../web/lib/model.mjs';
import { TranscriptState, TranscriptHistory } from '../public/client-state.mjs';

const row = { stream_id: 'ch0', session_id: 's1', segment_id: 'seg1', timeline_epoch: 0, start_ms: 0, end_ms: 10000,
  raw_text: '오늘 회의를 시작하겠습니다.', corrected_text: null, ai_corrected: false, version: 1, live_preview: true,
  preview_updated_ms: Date.now(), audio_received_ms: Date.now(), speech_activity: { state: 'speech' }, sequence: 1 };
test('only newly opted-in recognition drafts are projected and corrected text replaces the same identity', () => {
  assert.equal(viewerLiveSegment({ ...row, live_preview: false }), null);
  const draft = publicLiveSegment(viewerLiveSegment({ ...row, secret: 'PRIVATE', raw_source: 'main' }));
  assert.equal(draft.text, row.raw_text); assert.equal(draft.display_state, 'draft'); assert.equal(draft.ai_corrected, false);
  assert.doesNotMatch(JSON.stringify(draft), /raw_text|corrected_text|PRIVATE|raw_source/);
  const history = new TranscriptHistory(); const state = new TranscriptState();
  state.reset({ event_id: 1, segments: [], live_segments: [draft] }); history.update([...state.segments.values()]);
  const corrected = publicLiveSegment(viewerLiveSegment({ ...row, ai_corrected: true, version: 2, corrected_text: '지금부터 회의를 시작하겠습니다.' }));
  state.apply({ event_id: 2, kind: 'live-segment', payload: corrected }); history.update([...state.segments.values()]);
  history.update([draft]);
  assert.equal(history.items.length, 1); assert.equal(history.items[0].text, corrected.text); assert.equal(history.items[0].ai_corrected, true);
  const removed = publicLiveSegment(viewerLiveSegment({ ...row, version: 3, speech_activity: { state: 'silence' } }));
  history.update([removed]); assert.equal(history.items[0].display_state, 'removed'); assert.equal(history.items[0].text, '');
});
test('a pending phrase Whisper also makes over silence waits for the speaker check and invented endings are cut', () => {
  const waiting = viewerLiveSegment({ ...row, raw_text: '감사합니다.', speaker_state: 'pending', speech_activity: { state: 'unknown' } });
  assert.equal(waiting.display_state, 'removed'); assert.equal(waiting.text, '');
  assert.equal(viewerLiveSegment({ ...row, raw_text: '다음 안건을 상정합니다. MBC 뉴스 김성현입니다.' }).text, '다음 안건을 상정합니다.');
  assert.equal(viewerLiveSegment({ ...row, ai_corrected: true, version: 2, corrected_text: '다음은 애국가를 부르겠습니다. 찬송가 2장.' }).text,
    '다음은 애국가를 부르겠습니다.');
  assert.equal(viewerLiveSegment({ ...row, raw_text: '제주 사삼 희생자 지원' }).text, '제주 4.3 희생자 지원');
});
test('live snapshots and cloud validators scope drafts to the requested broadcast and preserve archive policy', () => {
  const store = new Store(':memory:');
  try {
    store.saveStream({ stream_id: 'ch0', name: '본회의', page_url: '' });
    const first = store.segment(row); store.segment({ ...row, live_preview: false, raw_text: 'OLD_PRIVATE' });
    store.segment({ ...row, stream_id: 'ch1', raw_text: 'OTHER_CHANNEL' });
    const snapshot = viewerSnapshot({ store, scheduler: { states: () => [] } }, ['ch0']);
    const projected = publicSnapshot(snapshot);
    assert.equal(projected.live_segments.length, 1); assert.equal(projected.segments.length, 0);
    assert.doesNotMatch(JSON.stringify(projected), /OLD_PRIVATE|OTHER_CHANNEL/);
    store.correct(first.segment_id, { version: 1, origin: 'ai', text: '보정된 회의 발언입니다.' });
    const next = publicSnapshot(viewerSnapshot({ store, scheduler: { states: () => [] } }, ['ch0']));
    assert.equal(next.live_segments[0].display_state, 'corrected'); assert.equal(next.segments[0].segment_id, first.segment_id);
    assert.equal(store.liveSegments('ch0')[0].version, 2);
    assert.throws(() => publicLiveSegment({ ...projected.live_segments[0], display_state: 'removed', text: 'must be empty' }));
    assert.throws(() => publicLiveSegment({ ...projected.live_segments[0], text: 'x'.repeat(5001) }));
    assert.deepEqual(publicSnapshot({ ...snapshot, live_policy: 'unknown' }).live_segments, []);
  } finally { store.close(); }
});
