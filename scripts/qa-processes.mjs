import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine } from '../src/engine.mjs';
const allYouTube = process.argv.includes('--youtube-eight');
const videoIds = ['RzhKkQ1EtyU','R5wgbc8f_KE','7zaWV3fFpx8','i0muD4B9KVU','CySLP7qKtT0','yN32Y1s7Z80','rbhnaSjg5Mw','jd9-CPghSuE'];
const root = resolve(allYouTube ? 'reports/processes-eight-youtube' : 'reports/processes'); mkdirSync(root,{recursive:true});
const config = JSON.parse(readFileSync('config.local.json'));
Object.assign(config,{port:0,database:root+'/live.sqlite',tokenFile:root+'/access.secret',engineLog:root+'/engine.log',
  ytdlp:resolve(config.ytdlp),recordAudio:true,recordings:root+'/recordings',files:{}});
for(let i=2;i<=8;i++)config.files['ch'+i]=resolve('data/synthetic-speech/ch'+i+'.wav');
writeFileSync(root+'/config.json',JSON.stringify(config));
let child; let base; let token; let log='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){
  child=spawn(process.execPath,['src/main.mjs',root+'/config.json'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;log+=b;});child.stderr.on('data',b=>{log+=b;});
  for(let i=0;i<200;i++){
    const line=output.split('\n').find(x=>x.includes('service.ready'));
    if(line){base=JSON.parse(line).url;token=JSON.parse(readFileSync(config.tokenFile)).adminToken;return;}
    if(child.exitCode!==null)throw Error('Service exited before ready');await sleep(100);
  }throw Error('Service readiness timeout');
}
async function api(path,data){const r=await fetch(base+path,{method:data===undefined?'GET':'POST',
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;}
async function stop(){const ended=once(child,'exit');await api('/api/admin/shutdown',{});await ended;}
const result={started_at:new Date().toISOString(),actual_processes:true};
try{
  await launch();result.ready=(await(await fetch(base+'/health/ready')).json()).ready;
  for(let i=1;i<=8;i++){
    const youtubeInput=allYouTube || i===1;
    await api('/api/admin/streams',{stream_id:'ch'+i,name:'Process QA '+i,kind:youtubeInput?'youtube':'file',approved:true,
      page_url:youtubeInput?'https://www.youtube.com/watch?v='+videoIds[i-1]:'',approval_note:'User supplied test videos; permitted synthetic files'});
    await api('/api/admin/streams/ch'+i+'/start',{});
  }
  await sleep(allYouTube?30000:15000);await api('/api/admin/streams/ch2/stop',{});const stopped=await api('/api/admin/metrics');
  await sleep(allYouTube?30000:20000);const metrics=await api('/api/admin/metrics');
  result.before=stopped.states;result.after=metrics.states;
  result.independent_stop=metrics.states.filter(s=>s.stream_id!=='ch2').every(s=>{
    const before=stopped.states.find(previous=>previous.stream_id===s.stream_id);
    return s.total_received_s>before.total_received_s+10 && s.total_processed_s>before.total_processed_s && !s.error;
  });
  assert.ok(result.independent_stop);
  assert.equal(metrics.errors,0);assert.equal(metrics.gaps,0);
  const youtube=metrics.states.find(s=>s.stream_id==='ch1');result.youtube_received_seconds=youtube.total_received_s;
  result.youtube_error=youtube.error;result.youtube_url_to_audio=youtube.total_received_s>=5;
  result.eight_url_inputs=allYouTube;
  if(allYouTube){result.all_urls_received=metrics.states.every(s=>s.total_received_s>=10);assert.ok(result.all_urls_received);}
  await stop();result.graceful_stop=child.exitCode===0;
  await launch();const snapshot=await api('/api/snapshot');result.restart_segments=snapshot.segments.length;
  result.persisted_stopped_sessions=snapshot.states.filter(s=>s.state==='stopped').length;await stop();
  await launch();await api('/api/admin/streams/ch3/start',{});await sleep(10000);
  const crashPid=child.pid;const crashed=once(child,'exit');
  await promisify(execFile)('taskkill.exe',['/PID',String(crashPid),'/T','/F'],{windowsHide:true});await crashed;
  await launch();const recovered=await api('/api/snapshot');
  result.forced_web_restart_interrupted=recovered.states.find(s=>s.stream_id==='ch3')?.state==='interrupted';
  result.forced_web_restart_gap=recovered.gaps.some(g=>g.stream_id==='ch3'&&g.reason==='process_restart');
  assert.ok(result.forced_web_restart_interrupted&&result.forced_web_restart_gap);await stop();
  const crashConfig={...config,engineLog:root+'/worker-crash.log'};
  const store=new Store(':memory:');const engine=new WhisperEngine(crashConfig);await engine.start();
  const scheduler=new Scheduler(store,engine,crashConfig);store.saveStream({stream_id:'ch1',name:'crash'});
  const session=scheduler.start({stream_id:'ch1'});const exited=once(engine.child,'exit');engine.child.kill();await exited;
  result.worker_crash_ready=engine.ready;
  assert.throws(()=>scheduler.feed('ch1',{session_id:session.session_id,epoch:0,seq:0,pcm:Buffer.alloc(32000)}),/engine failed/);
  result.worker_crash_rejects_input=true;await scheduler.close();store.close();
  writeFileSync(root+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){result.error=error.message;writeFileSync(root+'/result.json',JSON.stringify(result,null,2));throw error;}
finally{
  if(child?.exitCode===null)await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true})
    .catch(error=>{log+='Owned test process cleanup failed: '+error.message+'\n';});
  writeFileSync(root+'/service.log',log);
}
