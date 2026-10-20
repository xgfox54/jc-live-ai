import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const seconds = Number(process.argv[2] ?? 60);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) throw Error('Test duration must be 10 to 600 seconds');
const url = 'https://www.youtube.com/live/k349Q6iyR_0';
const directory = resolve('reports/live-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
for (const key of ['worker', 'model', 'ffmpeg', 'ytdlp']) config[key] = resolve(config[key]);
Object.assign(config, { port: 0, database: directory + '/live.sqlite', tokenFile: directory + '/access.secret',
  engineLog: directory + '/engine.log', recordAudio: true, recordings: directory + '/recordings', files: {} });
writeFileSync(directory + '/config.json', JSON.stringify(config, null, 2));
const result = { started_at: new Date().toISOString(), source_url: url, requested_audio_seconds: seconds,
  project: 'JC-LIVE', actual_gpu: true, passed: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child; let base; let token; let stdout = ''; let stderr = '';
async function api(path, data) {
  const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const body = await response.json(); if (!response.ok) throw Error(body.error ?? 'API request failed'); return body;
}
try {
  const metadata = await run(config.ytdlp, ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--encoding', 'utf-8',
    '--js-runtimes', 'node:' + process.execPath, '--socket-timeout', '15', '--retries', '1', '--skip-download',
    '--print', '%(id)s\t%(title)s\t%(live_status)s\t%(availability)s', url], { windowsHide: true, timeout: 60000 });
  const [id, title, live_status, availability] = metadata.stdout.trim().split('\t');
  result.source = { id, title, live_status, availability };
  child = spawn(process.execPath, ['src/main.mjs', directory + '/config.json'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline) {
    const line = stdout.split('\n').find(value => value.includes('service.ready'));
    if (line) { const ready = JSON.parse(line); base = ready.url; result.engine = ready.engine; break; }
    if (child.exitCode !== null) throw Error('Service exited before readiness'); await sleep(100);
  }
  assert.ok(base, 'Model readiness timeout');
  token = JSON.parse(readFileSync(config.tokenFile, 'utf8')).adminToken;
  await api('/api/admin/streams', { stream_id: 'ch1', name: 'JC-LIVE 방송 시험', kind: 'youtube',
    page_url: url, approved: true, approval_note: '사용자가 JC-LIVE 라이브 시험용으로 지정한 주소' });
  await api('/api/admin/streams/ch1/start', {});
  const deadline = Date.now() + (seconds + 90) * 1000;
  let state;
  while (Date.now() < deadline) {
    state = (await api('/api/admin/metrics')).states.find(item => item.stream_id === 'ch1');
    if (state.error) throw Error(state.error);
    if (state.total_received_s >= seconds) break;
    await sleep(500);
  }
  assert.ok(state.total_received_s >= seconds, 'Live audio deadline exceeded');
  await api('/api/admin/streams/ch1/stop', {});
  const drainDeadline = Date.now() + 60000;
  while (Date.now() < drainDeadline) {
    const metrics = await api('/api/admin/metrics'); result.metrics = metrics;
    state = metrics.states.find(item => item.stream_id === 'ch1');
    if (state.state === 'stopped') break; await sleep(100);
  }
  result.state = state;
  const snapshot = await api('/api/snapshot'); result.transcripts = snapshot.segments; result.gaps = snapshot.gaps;
  assert.ok(state.total_processed_s >= seconds && !state.error && state.queue_length === 0);
  assert.ok(result.transcripts.length > 0); assert.equal(result.gaps.length, 0);
  const exited = once(child, 'exit'); await api('/api/admin/shutdown', {}); await exited;
  assert.equal(child.exitCode, 0); result.graceful_exit_code = child.exitCode; result.passed = true;
} catch (error) {
  result.error = String(error.message).replace(/https?:\/\/\S+/g, '[URL]'); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null)
    await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  result.finished_at = new Date().toISOString();
  writeFileSync(directory + '/result.json', JSON.stringify(result, null, 2));
  writeFileSync(directory + '/service.log', stdout + stderr);
  console.log(JSON.stringify({ report: directory + '/result.json', passed: result.passed,
    live_status: result.source?.live_status, received_s: result.state?.total_received_s,
    processed_s: result.state?.total_processed_s, segments: result.transcripts?.length, error: result.error }));
}
