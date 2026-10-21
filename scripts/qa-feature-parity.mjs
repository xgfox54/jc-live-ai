import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { WhisperEngine } from '../src/engine.mjs';
import { createService } from '../src/server.mjs';
import { FileInputs } from '../src/files.mjs';

const audio = resolve(process.argv[2]); const output = resolve(process.argv[3] ?? 'reports/parity-native'); mkdirSync(output, { recursive: true });
const config = { worker: resolve('bin/jc-live-worker.exe'), model: resolve('models/ggml-small-q5_1.bin'), device: 'gpu', beam: 2, batch: 1,
  engineLog: join(output, 'engine.log'), chunkSeconds: 10, queueChunks: 12, silenceRms: 0, recordAudio: true,
  recordings: join(output, 'recordings'), minutesDirectory: join(output, 'minutes'), importDirectory: join(output, 'imports'),
  diarizationDirectory: resolve('bin/diarization'), analysisDirectory: join(output, 'analysis'), ffmpeg: resolve('bin/ffmpeg.exe'),
  adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex') };
const store = new Store(join(output, 'test.sqlite')); const engine = new WhisperEngine(config); const scheduler = new Scheduler(store, engine, config);
const inputs = new FileInputs(scheduler, config); const service = createService({ store, scheduler, inputs, config });
const source = { stream_id: 'ch1', session_id: 'authorized-source', state: 'stopped', timeline_epoch: 0, total_processed_s: 0, audio_processed_until: 0 };
const folder = join(config.recordings, source.stream_id, source.session_id); mkdirSync(folder, { recursive: true });
copyFileSync(audio, join(folder, 'audio.pcm'));
writeFileSync(join(folder, 'source.json'), JSON.stringify({ stream_id: source.stream_id, session_id: source.session_id, format: 's16le', sample_rate: 16000, channels: 1 }));
store.saveSession(source);
const record = service.registry.upsert({ title: '사용자 승인 방송의 저장 원음 시험', page_url: 'https://www.youtube.com/live/k349Q6iyR_0', sources: ['https://www.youtube.com/live/k349Q6iyR_0'], kind: 'youtube' });
service.registry.attach({ stream_id: 'ch1', broadcast_id: record.id }, source);
store.segment({ ...source, start_ms: 0, end_ms: 1000, raw_text: '원문 보존 확인용 표시' });
const result = { input: 'previously authorized local broadcast recording', ai: 'not_called', cloud: 'disabled', native: {}, http: {} };
try {
  await engine.start(); const started = Date.now();
  const job = await service.audioReview.start(record.id, { session_id: source.session_id }); await service.audioReview.pending;
  const finished = service.audioReview.jobs(record.id).find(item => item.id === job.id); assert.equal(finished.phase, 'completed');
  const rows = service.registry.segments(job.result_id); assert.ok(rows.length > 0); assert.equal(service.registry.segments(record.id)[0].raw_text, '원문 보존 확인용 표시');
  result.native.retranscription = { phase: finished.phase, audio_s: finished.total_bytes / 32000, elapsed_ms: Date.now() - started, segments: rows.length, source_preserved: true };
  const diarizeStarted = Date.now(); const speakerJob = await service.audioReview.diarize(record.id, source.session_id); await service.audioReview.pending;
  const speakers = service.audioReview.jobs(record.id).find(item => item.id === speakerJob.id); assert.equal(speakers.phase, 'completed');
  result.native.diarization = { phase: speakers.phase, elapsed_ms: Date.now() - diarizeStarted, spans: speakers.spans.length, unique_labels: [...new Set(speakers.spans.map(span => span.speaker))] };
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); const base = 'http://127.0.0.1:' + service.server.address().port;
  const auth = { Authorization: 'Bearer ' + config.adminToken }; const pcm = readFileSync(audio).subarray(0, 32000 * 12); const wave = Buffer.alloc(44);
  wave.write('RIFF'); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40);
  const response = await fetch(base + '/api/admin/import?stream=ch2&approved=1&name=authorized.wav', { method: 'POST', headers: auth, body: Buffer.concat([wave, pcm]) });
  assert.equal(response.status, 202); const imported = await response.json();
  while (inputs.isActive('ch2') || scheduler.busy) await new Promise(resolve => setTimeout(resolve, 25));
  service.minutes.flush(); assert.ok(service.registry.segments(imported.broadcast_id).length);
  result.http.upload = { status: response.status, segments: service.registry.segments(imported.broadcast_id).length, collector_error: scheduler.channel('ch2').error ?? null };
  const clip = await fetch(base + '/api/admin/workspace/audio?segment=' + rows[0].segment_id, { headers: auth }); assert.equal(clip.status, 200);
  result.http.clip = { status: clip.status, bytes: (await clip.arrayBuffer()).byteLength, type: clip.headers.get('content-type') };
  result.passed = true; writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  await service.audioReview.close(); await inputs.close(); await scheduler.close();
  if (service.server.listening) await service.close(); else { await service.review.close(); await service.correctionAI.close(); service.minutes.close(); }
  store.close();
}
