import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { videoId } from '../src/validate.mjs';
const code=readFileSync(new URL('../public/pcm-worklet.mjs',import.meta.url),'utf8');
function worklet(rate){
  const messages=[];let Constructor;
  class Processor {constructor(){this.port={postMessage:value=>messages.push(value)};}}
  runInNewContext(code,{sampleRate:rate,AudioWorkletProcessor:Processor,
    registerProcessor:(_,value)=>{Constructor=value;}});
  return {processor:new Constructor(),messages};
}
test('16k, 44.1k and 48k input each produce exactly one second of mono PCM',()=>{
  for(const rate of [16000,44100,48000]){
    const {processor,messages}=worklet(rate);
    for(let offset=0;offset<rate;offset+=128){
      const length=Math.min(128,rate-offset);
      processor.process([[new Float32Array(length).fill(0.75),new Float32Array(length).fill(0.25)]]);
    }
    processor.port.onmessage({data:'flush'});
    const pcm=messages.filter(m=>m!=='flushed').map(m=>new Int16Array(m));
    assert.equal(pcm.reduce((sum,x)=>sum+x.length,0),16000);
    assert.ok(pcm.every(x=>x.every(v=>v===16384)));
    assert.equal(messages.at(-1),'flushed');
  }
});
test('worklet instances isolate samples and flush the incomplete final packet',()=>{
  const a=worklet(16000);const b=worklet(16000);
  a.processor.process([[new Float32Array(123).fill(1)]]);
  b.processor.process([[new Float32Array(55).fill(-1)]]);
  for(const fixture of [a,b])fixture.processor.port.onmessage({data:'flush'});
  assert.equal(new Int16Array(a.messages[0]).length,123);
  assert.equal(new Int16Array(b.messages[0]).length,55);
  assert.ok(new Int16Array(a.messages[0]).every(v=>v>0));
  assert.ok(new Int16Array(b.messages[0]).every(v=>v<0));
  a.processor.process([[new Float32Array(128)]]);assert.equal(a.messages.length,2);
});
test('council query parameters cannot be reinterpreted as a YouTube input',()=>{
  assert.equal(videoId('https://www.council.jeju.kr/broadcast/index.do?v=RzhKkQ1EtyU'),null);
  assert.equal(videoId('https://www.youtube.com/live/RzhKkQ1EtyU'),'RzhKkQ1EtyU');
});
