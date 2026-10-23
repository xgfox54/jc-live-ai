import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AltEngine } from '../src/alt-engine.mjs';

test('SenseVoice Korean text survives a Windows CP949 parent environment', {
  skip: !process.env.JC_TEST_ALT_PCM,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jc-alt-encoding-'));
  const prior = process.env.PYTHONIOENCODING;
  const engine = new AltEngine({ altLog: join(dir, 'worker.log') });
  t.after(async () => {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PYTHONIOENCODING = 'cp949';
  try { await engine.start(); }
  finally {
    if (prior === undefined) delete process.env.PYTHONIOENCODING;
    else process.env.PYTHONIOENCODING = prior;
  }
  const audio = await readFile(process.env.JC_TEST_ALT_PCM);
  const reply = await engine.transcribe({ pcm: audio.subarray(0, 7 * 32000) });
  assert.doesNotMatch(reply.text, /\uFFFD/, 'worker reply contains damaged Unicode before database storage');
  assert.match(reply.text, /[가-힣]/, 'fixture must contain Korean speech');
});
