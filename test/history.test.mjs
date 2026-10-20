import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { TranscriptState } from '../public/client-state.mjs';
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
