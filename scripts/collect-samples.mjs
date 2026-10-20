import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const run = promisify(execFile);
const root = resolve('data/authorized-youtube'); await mkdir(root, { recursive: true });
const ids = ['RzhKkQ1EtyU','R5wgbc8f_KE','7zaWV3fFpx8','i0muD4B9KVU','CySLP7qKtT0','yN32Y1s7Z80','rbhnaSjg5Mw','jd9-CPghSuE'];
const config = JSON.parse(await readFile('config.local.json', 'utf8'));
const ffmpeg = resolve(config.ffmpeg);
const base = ['--ignore-config','--no-plugin-dirs','--no-playlist','--js-runtimes','node:' + process.execPath,
  '--socket-timeout','15','--retries','1','--ffmpeg-location',ffmpeg];
const results = JSON.parse(await readFile(root + '/provenance.json','utf8').catch(()=>'[]'));
for (const [index,id] of ids.entries()) {
  if (results.some(row=>row.id===id && row.collected)) continue;
  const url = 'https://www.youtube.com/watch?v=' + id;
  const row = { id, url, channel: 'ch' + (index + 1), checked_at: new Date().toISOString() };
  try {
    const meta = await run(resolve(config.ytdlp), [...base,'--skip-download','--print',
      '%(id)s\t%(duration)s\t%(live_status)s\t%(availability)s',url], { windowsHide:true, timeout:60000 });
    row.metadata = meta.stdout.trim();
    const duration = Number(row.metadata.split('\t')[1]);
    row.start_seconds = Math.min(600, Math.max(0, duration - 310)); row.duration_seconds = 300;
    await run(resolve(config.ytdlp), [...base,'--no-progress','-f','bestaudio',
      '--download-sections','*' + row.start_seconds + '-' + (row.start_seconds + 300),
      '-o',root + '/' + row.channel + '.%(ext)s', url], { windowsHide:true, timeout:180000, maxBuffer:1048576 });
    row.collected = true;
  } catch (error) {
    row.collected = false;
    row.error = String(error.stderr ?? error.message).replace(/https?:\/\/[^\s]+/g,'[URL]').slice(-1500);
  }
  const previous=results.findIndex(item=>item.id===id);
  if(previous>=0)results[previous]=row;else results.push(row);
  await writeFile(root + '/provenance.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(row));
}
