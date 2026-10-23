import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhisperEngine } from '../src/engine.mjs';

// The worker is spawned as <worker> <model> <beam> <device>; node runs the "model" argument as a fake worker script.
test('a worker that exits after a successful start is started again', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-engine-'));
  const script = join(dir, 'worker.mjs');
  writeFileSync(script, "console.log(JSON.stringify({ ready: true })); process.stdin.resume();\n");
  const engine = new WhisperEngine({ worker: process.execPath, model: script, beam: 1, device: 'cpu', engineLog: join(dir, 'engine.log') });
  try {
    await engine.start(); const first = engine.child.pid;
    engine.child.kill();
    while (engine.child.pid === first || !engine.ready) await new Promise(resolve => setTimeout(resolve, 100));
    assert.notEqual(engine.child.pid, first);
  } finally { await engine.stop(); rmSync(dir, { recursive: true, force: true }); }
});
