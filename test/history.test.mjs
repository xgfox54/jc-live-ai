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
