import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('native loader rejects invalid tensor types and accepts the approved model', {
  skip: !process.env.JC_TEST_PATCHED_WORKER || !process.env.JC_TEST_WHISPER_MODEL,
}, async () => {
  const worker = resolve(process.env.JC_TEST_PATCHED_WORKER);
  const model = resolve(process.env.JC_TEST_WHISPER_MODEL);
  const original = await readFile(model);
  assert.equal(original.readUInt32LE(0), 0x67676d6c);
  let offset = 56 + original.readInt32LE(48) * original.readInt32LE(52) * 4;
  const count = original.readInt32LE(offset); offset += 4;
  assert.ok(count > 0 && count < 100000);
  for (let index = 0; index < count; index++) offset += 4 + original.readUInt32LE(offset);
  assert.ok(offset + 44 < original.length);
  const dir = await mkdtemp(join(tmpdir(), 'jc-loader-'));
  const run = path => spawnSync(worker, [path, '1', 'cpu'], {
    input: '', encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2_000_000,
  });
  try {
    for (const type of [-1, 2147483647]) {
      const fixture = Buffer.from(original.subarray(0, offset + 44));
      fixture.writeInt32LE(type, offset + 8);
      const path = join(dir, 'invalid-' + type + '.bin'); await writeFile(path, fixture);
      const result = run(path);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /invalid ttype/);
      assert.doesNotMatch(result.stdout, /"ready":true/);
    }
    const result = run(model);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"ready":true/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
