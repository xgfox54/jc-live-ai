import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { FileInputs, resumeStart } from '../src/files.mjs';

test('real decoder distinguishes EOF, duration limit, live disconnection and manual stop', { skip: !existsSync('bin/ffmpeg.exe') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-eof-')); const pcm = join(dir, 'sample.pcm'); writeFileSync(pcm, Buffer.alloc(64000));
  const state = { state: 'running', queue: [], session_id: 'one', timeline_epoch: 0 }; let received = 0; let reason;
  const scheduler = { channel: () => state, feed: (_, packet) => { received += packet.pcm.length; }, stop: (_, value) => { reason = value; }, store: { event() {} } };
  const inputs = new FileInputs(scheduler, { ffmpeg: resolve('bin/ffmpeg.exe'), queueChunks: 8 });
  try {
    await inputs.start({ stream_id: 'ch2', kind: 'file' }, pcm, false, { local: true, raw: true });
    assert.equal(reason, 'eof'); assert.equal(received, 64000);
    await inputs.start({ stream_id: 'ch2', kind: 'file' }, pcm, false, { local: true, raw: true, duration: 1 });
    assert.equal(reason, 'duration_limit');
    inputs.endProbe = async () => ({ phase: 'live', key: 'youtube:abcdefghijk' });
    await inputs.start({ stream_id: 'ch2', kind: 'youtube' }, pcm, false, { local: true, raw: true }); assert.equal(reason, 'end_unverified');
    assert.equal(state.input_end_live, true);
    inputs.endProbe = async () => { throw new Error('Expected one supported official council player'); };
    await inputs.start({ stream_id: 'ch2', kind: 'youtube' }, pcm, false, { local: true, raw: true }); assert.equal(reason, 'end_unverified');
    assert.equal(state.input_end_live, false);
    inputs.endProbe = async () => ({ phase: 'ended', key: 'youtube:abcdefghijk' });
    await inputs.start({ stream_id: 'ch2', kind: 'youtube' }, pcm, false, { local: true, raw: true }); assert.equal(reason, 'eof');
    const task = inputs.start({ stream_id: 'ch2', kind: 'file' }, pcm, true, { local: true, raw: true, loop: true });
    await new Promise(resolve => setTimeout(resolve, 100)); await inputs.stop('ch2'); await task;
    assert.notEqual(reason, 'eof');
    const ended = inputs.start({ stream_id: 'ch2', kind: 'youtube' }, pcm, true, { local: true, raw: true, loop: true });
    await new Promise(resolve => setTimeout(resolve, 100)); await inputs.stop('ch2', 'eof'); await ended;
    assert.equal(reason, 'eof');
  } finally { await inputs.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('a resumed collection starts just before the resume point by the live playlist clock', () => {
  const start = Date.parse('2026-11-05T01:00:00.000Z');
  const playlist = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-PROGRAM-DATE-TIME:2026-11-05T01:00:00.000Z',
    ...Array.from({ length: 12 }, (_, i) => ['#EXTINF:5.0,', 'segment' + i]).flat()].join('\n');
  assert.deepEqual(resumeStart(playlist, start + 42_000), { index: -9, from_ms: start + 15_000 });
  // A stalled playlist starts at its newest segment instead of reading the received audio again.
  assert.deepEqual(resumeStart(playlist, start + 3_600_000), { index: -1, from_ms: start + 55_000 });
  // A break longer than the playlist starts at its oldest segment; without date markers the clock estimate is used.
  assert.deepEqual(resumeStart(playlist, start - 3_600_000), { index: -12, from_ms: start });
  assert.deepEqual(resumeStart('#EXTM3U\n#EXTINF:5.0,\nsegment', 1_000_000, 1_012_000), { index: -4, from_ms: 992_000 });
});

test('an input that fails as its broadcast ends finishes like a normal end; a failure while it is live stays a collection failure', { skip: !existsSync('bin/ffmpeg.exe') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-ended-')); const missing = join(dir, 'missing.pcm');
  const state = { state: 'running', queue: [], session_id: 'one', timeline_epoch: 0 }; const gaps = []; let reason;
  const scheduler = { channel: () => state, feed() {}, stop: (_, value) => { reason = value; }, store: { event: (kind, payload) => gaps.push(payload.reason) } };
  const inputs = new FileInputs(scheduler, { ffmpeg: resolve('bin/ffmpeg.exe'), queueChunks: 8 });
  try {
    // 2026-11-24: both meetings that ended logged a collection failure when the YouTube stream closed after adjournment.
    inputs.endProbe = async () => ({ phase: 'offline', key: 'youtube:abcdefghijk' });
    await inputs.start({ stream_id: 'ch2', kind: 'youtube' }, missing, false, { local: true, raw: true });
    assert.equal(reason, 'eof'); assert.deepEqual(gaps, []); assert.equal(state.error, undefined); assert.equal(state.input_failed, undefined);
    // 2026-11-26: the council removes the live playlist of an ended meeting, so the end check finds it offline.
    inputs.endProbe = async () => ({ phase: 'offline', key: 'hls:https://vod.council.jeju.kr/live/XHC051/chunklist.m3u8' });
    await inputs.start({ stream_id: 'ch6', kind: 'council' }, missing, false, { local: true, raw: true });
    assert.equal(reason, 'eof'); assert.deepEqual(gaps, []); assert.equal(state.input_failed, undefined);
    inputs.endProbe = async () => ({ phase: 'live', key: 'youtube:abcdefghijk' });
    await inputs.start({ stream_id: 'ch2', kind: 'youtube' }, missing, false, { local: true, raw: true });
    assert.equal(reason, 'error'); assert.deepEqual(gaps, ['collector_failed']); assert.equal(state.input_failed, true);
    inputs.endProbe = async () => { throw new Error('end check failed'); };
    await inputs.start({ stream_id: 'ch2', kind: 'council' }, missing, false, { local: true, raw: true });
    assert.equal(reason, 'error'); assert.equal(gaps.length, 2);
    await inputs.start({ stream_id: 'ch2', kind: 'file' }, missing, false, { local: true, raw: true });
    assert.equal(reason, 'error'); assert.equal(gaps.length, 3);
  } finally { await inputs.close(); rmSync(dir, { recursive: true, force: true }); }
});
