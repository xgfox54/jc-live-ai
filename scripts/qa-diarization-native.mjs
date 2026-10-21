import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiarizationEngine } from '../src/diarization-engine.mjs';

const directory = resolve(process.argv[2]); await mkdir(directory, { recursive: true });
const config = { diarizationDirectory: resolve('bin/diarization'), diarizationPython: 'C:/Python314/python.exe',
  diarizationChunkFrames: 64, diarizationLog: directory + '/native.log' };
const result = { started_at: new Date().toISOString(), passed: false };
const engine = new DiarizationEngine(config); let restarted;
try {
  await engine.start(); const keys = Array.from({ length: 8 }, () => randomUUID());
  for (const key of keys) await engine.request('open', key);
  await assert.rejects(engine.request('open', randomUUID()), /capacity exceeded/);
  assert.equal(engine.ready, true); result.ninth_cache_rejected_without_failure = true;
  await assert.rejects(engine.request('push', keys[0], Buffer.alloc(352002)), /Invalid diarization request/);
  result.oversized_pcm_rejected = true;
  for (const key of keys) await engine.request('push', key, Buffer.alloc(32000));
  const pending = engine.request('push', keys[0], Buffer.alloc(320000));
  setImmediate(() => engine.child.kill());
  await assert.rejects(pending, /exited|unavailable|EPIPE|EOF/i);
  assert.equal(engine.ready, false); result.process_death_rejects_pending = true;
  await assert.rejects(engine.request('open', randomUUID()), /unavailable/);
  result.failed_engine_rejects_new_cache = true; await engine.stop();
  restarted = new DiarizationEngine(config); await restarted.start(); const fresh = randomUUID();
  await restarted.request('open', fresh); await restarted.request('push', fresh, Buffer.alloc(32000));
  await restarted.request('finish', fresh); await restarted.request('close', fresh);
  result.fresh_engine_recovers = true; result.passed = true;
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  await engine.stop(); await restarted?.stop(); result.finished_at = new Date().toISOString();
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
