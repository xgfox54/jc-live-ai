import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';
const onlyId=process.argv[4];if(onlyId&&!/^[A-Za-z0-9_-]{11}$/.test(onlyId))throw Error('Invalid test video ID');
const output=resolve('reports/player'+(onlyId?'-'+onlyId:''));mkdirSync(output,{recursive:true});
const {omowright}=await(await import(pathToFileURL(process.argv[2]))).loadOmowright();
const profile=mkdtempSync(join(tmpdir(),'sr-player-qa-'));
const store=new Store(':memory:');const scheduler=new Scheduler(store,{ready:true,stop:async()=>{}},{});
const service=createService({store,scheduler,config:{},inputs:{}});service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
let browser;
try{
  browser=await omowright.connectPipe({browserPath:process.argv[3],browserArgs:['--headless=new','--disable-gpu','--no-first-run',
    '--autoplay-policy=no-user-gesture-required','--user-data-dir='+profile],storageRoot:profile});
  const observations=[];
  for(const id of onlyId?[onlyId]:['RzhKkQ1EtyU','R5wgbc8f_KE','7zaWV3fFpx8','i0muD4B9KVU','CySLP7qKtT0','yN32Y1s7Z80','rbhnaSjg5Mw','jd9-CPghSuE']){
  const page=await browser.newTab('http://127.0.0.1:'+service.server.address().port+'?video='+id);
  await page.evaluate(async()=>{
    const {OfficialPlayer}=await import('/player.mjs');globalThis.playerMessages=[];
    globalThis.playerProbe=new OfficialPlayer(document.querySelector('#player'),v=>playerMessages.push(v));
    await playerProbe.select({video_id:new URL(location.href).searchParams.get('video'),stream_id:'ch1'});
  });
  for(let i=0;i<100;i++){
    if(await page.evaluate(()=>typeof playerProbe.player?.getPlayerState==='function'))break;
    await new Promise(r=>setTimeout(r,100));
  }
  await page.evaluate(()=>{playerProbe.player.mute();playerProbe.player.playVideo();});
  await new Promise(r=>setTimeout(r,5000));
  const before=await page.evaluate(()=>({state:playerProbe.player.getPlayerState(),time:playerProbe.player.getCurrentTime(),duration:playerProbe.player.getDuration(),messages:playerMessages}));
  await page.evaluate(()=>playerProbe.player.seekTo(60,true));await new Promise(r=>setTimeout(r,3000));
  const after=await page.evaluate(()=>({state:playerProbe.player.getPlayerState(),time:playerProbe.player.getCurrentTime(),messages:playerMessages}));
  const result={source:'https://www.youtube.com/watch?v='+id,source_type:'public archived broadcast VOD',
    before,after,seek_60s_observed:after.time>=58&&after.time<=67,live_DVR:'not tested; source is VOD',
    audio_video_alignment:'not verified; no common PTS anchor'};
  observations.push(result);writeFileSync(output+'/result.json',JSON.stringify(observations,null,2));
  writeFileSync(output+'/'+id+'.png',await page.screenshot());console.log(JSON.stringify(result));
  await page.evaluate(()=>playerProbe.player.pauseVideo());
  }
}catch(error){writeFileSync(output+'/result.json',JSON.stringify({error:error.message,live_DVR:'not tested'}));throw error;}
finally{if(browser)await browser.close();await scheduler.close();await service.close();store.close();rmSync(profile,{recursive:true,force:true});}
