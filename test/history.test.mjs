import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { TranscriptState, TranscriptHistory } from '../public/client-state.mjs';
test('snapshot preserves gap warnings and provides a non-overlapping history cursor',()=>{
  const store=new Store(':memory:');
  try{
    store.saveStream({stream_id:'ch1'});
    for(let i=0;i<120;i++)store.segment({stream_id:'ch1',session_id:'session',timeline_epoch:0,
      start_ms:i*1000,end_ms:(i+1)*1000,raw_text:String(i)});
    store.event('gap',{stream_id:'ch1',session_id:'session',reason:'input_discontinuity',extent:'unknown'});
    const snapshot=store.snapshot(['ch1']);const state=new TranscriptState();state.reset(snapshot);
    assert.equal(snapshot.segments.length,100);
    assert.equal(state.gaps.get('ch1').reason,'input_discontinuity');
    const previous=store.segments({stream:'ch1',before:snapshot.before.ch1});
    assert.equal(previous.items.length,20);
    const latestIds=new Set(snapshot.segments.map(s=>s.segment_id));
    assert.ok(previous.items.every(s=>!latestIds.has(s.segment_id)));
  }finally{store.close();}
});
const records = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => ({
  segment_id: 'segment-' + (start + index), sequence: start + index, version: 1, stream_id: 'ch0',
  start_ms: (start + index) % 100 * 1000, ai_corrected: true, text: '보정된 발언 ' + (start + index)
}));
test('viewer retains the entire meeting after paging and periodic snapshot replacement', () => {
  const state = new TranscriptState(); const history = new TranscriptHistory();
  state.reset({ event_id: 1, segments: records(1901, 2000) });
  history.update([...state.segments.values()], 1901);
  while (history.cursor) {
    const cursor = history.cursor; const start = Math.max(1, cursor - 200);
    history.addPage({ items: records(start, cursor - 1), before: start === 1 ? 0 : start }, cursor);
  }
  state.reset({ event_id: 2, segments: records(1902, 2001) }); history.update([...state.segments.values()], 1902);
  assert.equal(history.items.length, 2001); assert.equal(history.cursor, 0);
  assert.deepEqual(history.items.map(item => item.sequence), records(1, 2001).map(item => item.sequence));
  history.update([{ ...records(1, 1)[0], version: 2, text: '수정된 문장' }]);
  history.update(records(1, 1)); assert.equal(history.items[0].text, '수정된 문장');
  assert.equal(new TranscriptHistory().items.length, 0);
});
test('viewer fills the missing middle after reconnecting beyond the latest snapshot window', () => {
  const history = new TranscriptHistory(); history.update(records(301, 400), 301);
  history.addPage({ items: records(101, 300), before: 101 }, 301);
  history.update(records(901, 1000), 901);
  assert.equal(history.cursor, 901);
  history.addPage({ items: records(701, 900), before: 701 }, 901);
  history.addPage({ items: records(501, 700), before: 501 }, 701);
  history.addPage({ items: records(301, 500), before: 301 }, 501);
  assert.equal(history.cursor, 101); assert.equal(history.items.length, 900);
  history.addPage({ items: records(1, 100), before: 0 }, 101);
  assert.equal(history.items.length, 1000); assert.equal(history.cursor, 0);
});
test('invalid history responses preserve the records and retry cursor', () => {
  const history = new TranscriptHistory(); history.update(records(101, 200), 101);
  for (const before of [101, 102, -1, NaN]) assert.throws(() => history.addPage({ items: records(1, 100), before }, 101));
  assert.equal(history.items.length, 100); assert.equal(history.cursor, 101);
});
test('the whole record loads newest first and a snapshot that arrives later leaves nothing to load', () => {
  // Given a channel opened before its snapshot arrived, whose first request takes the newest 2,000 sentences
  const history = new TranscriptHistory(); history.update([], 2901);
  history.addPage({ items: records(1001, 3000), before: 1001 }, Number.MAX_SAFE_INTEGER);
  assert.equal(history.cursor, 1001);
  history.addPage({ items: records(1, 1000), before: 0 }, 1001);
  // When the snapshot with the latest 100 sentences arrives
  history.update(records(2901, 3000), 2901);
  // Then the record is complete without asking again for sentences it already has
  assert.equal(history.cursor, 0); assert.equal(history.items.length, 3000);
});
test('old live previews in a snapshot do not hide the published sentences before the snapshot window', () => {
  // Given the latest 100 published sentences and live previews of two older sentences whose text changed lately
  const history = new TranscriptHistory();
  const previews = [500, 1200].map(sequence => ({ ...records(sequence, sequence)[0], display_state: 'corrected' }));
  history.update([...records(1901, 2000), ...previews], 1901);
  // When earlier sentences are read in pages of 200
  assert.equal(history.cursor, 1901);
  while (history.cursor) {
    const cursor = history.cursor; const start = Math.max(1, cursor - 200);
    history.addPage({ items: records(start, cursor - 1), before: start === 1 ? 0 : start }, cursor);
  }
  // Then every sentence of the meeting is there
  assert.equal(history.items.length, 2000);
});
test('an empty record is read once and asked again only for its first published sentence', () => {
  // Given a channel whose broadcast has no published sentence yet, read to its start
  const history = new TranscriptHistory(); history.update([], undefined);
  assert.equal(history.cursor, Number.MAX_SAFE_INTEGER);
  history.addPage({ items: [], before: 0 }, Number.MAX_SAFE_INTEGER);
  // When the screen is drawn again without a sentence
  history.update([], undefined); history.update([], null);
  // Then nothing is left to load, so the record is not requested again
  assert.equal(history.cursor, 0);
  // When the first published sentence arrives, the record is read once more before it
  history.update(records(7, 7), undefined); assert.equal(history.cursor, 7);
  history.addPage({ items: [], before: 0 }, 7); assert.equal(history.cursor, 0);
  // A first draft alone does not ask again either
  const drafted = new TranscriptHistory(); drafted.update([], undefined);
  drafted.addPage({ items: [], before: 0 }, Number.MAX_SAFE_INTEGER);
  drafted.update([{ ...records(9, 9)[0], ai_corrected: false, display_state: 'draft' }], undefined);
  assert.equal(drafted.cursor, 0);
});
test('the start row of an empty record leaves nothing to load, and a screen that was away still loads what it missed', () => {
  // Given a screen that read an empty record and received its undrawn start row
  const start = { segment_id: 'record-start', stream_id: 'ch0', sequence: 1, version: 0, text: '', ai_corrected: false, display_state: 'removed' };
  const history = new TranscriptHistory(); history.update([], undefined);
  history.addPage({ items: [start], before: 0 }, Number.MAX_SAFE_INTEGER);
  history.update([], undefined); assert.equal(history.cursor, 0);
  // When 999 sentences were published while it was away and the snapshot brings the latest 100
  history.update(records(901, 1000), 901);
  // Then it loads the sentences before them down to the start of the record
  assert.equal(history.cursor, 901);
  while (history.cursor) {
    const cursor = history.cursor; const first = Math.max(2, cursor - 200);
    history.addPage({ items: records(first, cursor - 1), before: first === 2 ? 0 : first }, cursor);
  }
  assert.equal(history.items.filter(item => item.ai_corrected).length, 999);
});
