import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { FileInputs } from '../src/files.mjs';

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
