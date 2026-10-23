import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioTimeline, sourceTimeAt } from '../src/audio-timeline.mjs';

const frame = (n, pts, samples = 16000) => `[Parsed_ashowinfo_2 @ x] n:${n} pts:${pts} pts_time:0 fmt:s16 channels:1 chlayout:mono rate:16000 nb_samples:${samples} checksum:0`;
test('source timestamp map preserves nonzero origin and separates discontinuities', () => {
  const timeline = new AudioTimeline();
  timeline.write(frame(0, 160000) + '\n' + frame(1, 176000).slice(0, 42));
  timeline.write(frame(1, 176000).slice(42) + '\n' + frame(2, 80000) + '\n');
  const result = timeline.finish(96000);
  assert.equal(result.status, 'verified');
  assert.equal(result.spans.length, 2);
  assert.deepEqual(sourceTimeAt(result, 1000), { source_seconds: 11, source_epoch: 0 });
  assert.deepEqual(sourceTimeAt(result, 2000), { source_seconds: 5, source_epoch: 1 });
  assert.equal(sourceTimeAt(result, 3000), null);
});
test('missing frame or PCM length mismatch disables mapping', () => {
  for (const [next, bytes] of [[2, 64000], [1, 64002]]) {
    const timeline = new AudioTimeline(); timeline.write(frame(0, 0) + '\n' + frame(next, 16000) + '\n');
    const result = timeline.finish(bytes);
    assert.equal(result.status, 'unverified'); assert.equal(sourceTimeAt(result, 0), null);
  }
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { FileInputs } from '../src/files.mjs';

test('real decoder records source offset and PTS jump against exact output PCM length', { skip: !existsSync('bin/ffmpeg.exe') }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-source-pts-')); const input = join(directory, 'source.mkv');
  const state = { state: 'running', queue: [], session_id: 'source-pts', timeline_epoch: 0 }; let bytes = 0;
  const scheduler = { channel: () => state, feed: (_, packet) => { bytes += packet.pcm.length; }, stop() {}, store: { event() {} } };
  const inputs = new FileInputs(scheduler, { ffmpeg: resolve('bin/ffmpeg.exe'), queueChunks: 8, recordAudio: true, recordings: directory });
  try {
    const fixture = spawnSync(resolve('bin/ffmpeg.exe'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3',
      '-af', 'asetnsamples=n=16000,asetpts=PTS+10/TB+5/TB*gte(N\\,16000)', '-c:a', 'pcm_s16le', input], { windowsHide: true, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    await inputs.start({ stream_id: 'ch1', kind: 'file' }, input, false, { local: true });
    const timeline = JSON.parse(readFileSync(join(directory, 'ch1/source-pts/audio-timeline.json')));
    assert.equal(timeline.status, 'verified'); assert.equal(bytes, 96000);
    assert.deepEqual(sourceTimeAt(timeline, 0), { source_seconds: 10, source_epoch: 0 });
    assert.deepEqual(sourceTimeAt(timeline, 1000), { source_seconds: 16, source_epoch: 1 });
    assert.equal(timeline.video_alignment, 'unverified');
  } finally { await inputs.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unfinished stderr frame cannot verify a recording', () => {
  const timeline = new AudioTimeline(); timeline.write(frame(0, 0));
  assert.equal(timeline.finish(32000).status, 'unverified');
});
test('checkpoint maps only written prefix and never claims complete capture', () => {
  const timeline = new AudioTimeline(); timeline.write(frame(0, 160000) + '\n' + frame(1, 176000) + '\n');
  const saved = timeline.checkpoint(32000);
  assert.equal(saved.status, 'verified-prefix');
  assert.equal(saved.capture_complete, false);
  assert.equal(saved.mapped_samples, 16000);
  assert.deepEqual(sourceTimeAt(saved, 999), { source_seconds: 10.999, source_epoch: 0 });
  assert.equal(sourceTimeAt(saved, 1000), null);
  assert.equal(saved.video_alignment, 'unverified');
});

test('recording publishes a durable checkpoint before stopping and finalizes manual stop', { skip: !existsSync('bin/ffmpeg.exe') }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-durable-'));
  const input = join(directory, 'tone.wav');
  const state = { state: 'running', queue: [], session_id: 'durable', timeline_epoch: 0 };
  const scheduler = { channel: () => state, feed() {}, stop() {}, store: { event() {} } };
  const inputs = new FileInputs(scheduler, { ffmpeg: resolve('bin/ffmpeg.exe'), queueChunks: 8, recordAudio: true, recordings: directory });
  try {
    const generated = spawnSync(resolve('bin/ffmpeg.exe'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=5', input], { windowsHide: true });
    assert.equal(generated.status, 0);
    const task = inputs.start({ stream_id: 'tone', kind: 'file' }, input, true, { local: true });
    await new Promise(resolve => setTimeout(resolve, 1400));
    const path = join(directory, 'tone/durable/audio-timeline.json');
    const checkpoint = JSON.parse(readFileSync(path));
    assert.equal(checkpoint.status, 'verified-prefix');
    assert.equal(checkpoint.capture_complete, false);
    assert.ok(checkpoint.mapped_samples > 0);
    await inputs.stop('tone'); await task;
    const final = JSON.parse(readFileSync(path));
    assert.equal(final.capture_complete, false);
    assert.ok(final.pcm_bytes >= checkpoint.pcm_bytes);
    assert.equal(final.video_alignment, 'unverified');
  } finally { await inputs.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('invalid stderr and malformed persisted spans cannot map source time', () => {
  const timeline = new AudioTimeline(); timeline.write(frame(0, 0) + '\n' + frame(2, 16000) + '\n');
  assert.equal(sourceTimeAt(timeline.checkpoint(64000), 0), null);
  const valid = new AudioTimeline(); valid.write(frame(0, 0) + '\n');
  const value = valid.checkpoint(32000); value.spans[0].samples++;
  assert.equal(sourceTimeAt(value, 0), null);
});


test('session collision preserves previous metadata, PCM, and timeline', { skip: !existsSync('bin/ffmpeg.exe') }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-collision-'));
  const session = join(directory, 'tone/existing'); mkdirSync(session, { recursive: true });
  const originals = { 'source.json': '{"original":true}', 'audio.pcm': 'old PCM', 'audio-timeline.json': '{"original":true}' };
  for (const [name, value] of Object.entries(originals)) writeFileSync(join(session, name), value);
  const state = { state: 'running', queue: [], session_id: 'existing', timeline_epoch: 0 };
  const scheduler = { channel: () => state, feed() {}, stop() {}, store: { event() {} } };
  const inputs = new FileInputs(scheduler, { ffmpeg: resolve('bin/ffmpeg.exe'), recordAudio: true, recordings: directory });
  try {
    await inputs.start({ stream_id: 'tone', kind: 'file' }, join(directory, 'missing.wav'), false, { local: true });
    for (const [name, value] of Object.entries(originals)) assert.equal(readFileSync(join(session, name), 'utf8'), value);
    assert.equal(state.recording_failed, true);
  } finally { await inputs.close(); rmSync(directory, { recursive: true, force: true }); }
});
