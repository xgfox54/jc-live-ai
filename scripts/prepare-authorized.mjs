import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const config=JSON.parse(readFileSync('config.local.json'));
const directory=resolve('data/authorized-youtube');
const sources=JSON.parse(readFileSync(directory+'/provenance.json'));
const manifest=[];const pcm={};
for(const source of sources){
  if(!source.collected)throw Error('Unavailable source: '+source.id);
  const output=directory+'/'+source.channel+'.pcm';
  execFileSync(config.ffmpeg,['-nostdin','-v','error','-y','-i',directory+'/'+source.channel+'.webm',
    '-vn','-ac','1','-ar','16000','-f','s16le',output],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  const bytes=readFileSync(output);pcm[source.channel]=output;
  manifest.push({...source,pcm_sha256:createHash('sha256').update(bytes).digest('hex'),pcm_seconds:bytes.length/32000});
}
writeFileSync(directory+'/manifest.json',JSON.stringify(manifest,null,2));
writeFileSync('data/config-real.json',JSON.stringify({...config,benchmarkPcm:pcm,collectorInput:true,
  recordAudio:false,benchmarkSourceDescription:sources.length+' distinct user supplied public Korean broadcast recordings'},null,2));
console.log(JSON.stringify(manifest));
