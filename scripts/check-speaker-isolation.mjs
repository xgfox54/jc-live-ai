import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DiarizationEngine } from '../src/diarization-engine.mjs';

const recordingReport = JSON.parse(await readFile(process.argv[2], 'utf8'));
const directory = resolve(process.argv[3] ?? 'reports/live-diarization-20261021/isolation');
await mkdir(directory, { recursive: true });
const engine = new DiarizationEngine({ diarizationDirectory: resolve('bin/diarization'),
  diarizationPython: 'C:/Python314/python.exe', diarizationChunkFrames: 64, diarizationLog: directory + '/native.log' });
const clips = await Promise.all(recordingReport.recordings.map(async item => {
  const handle = await open(item.file, 'r');
  try {
    const pcm = Buffer.alloc(20 * 32000); const { bytesRead } = await handle.read(pcm);
    if (bytesRead !== pcm.length) throw new Error('Need twenty seconds per source');
    return { ...item, pcm, sha256: createHash('sha256').update(pcm).digest('hex') };
  } finally { await handle.close(); }
}));
const result = { started_at: new Date().toISOString(), scope: 'Same real audio processed alone versus eight interleaved persistent speaker caches',
  passed: false, sources: clips.map(clip => ({ video_id: clip.video_id, sha256: clip.sha256 })) };
try {
  if (clips.length !== 8 || new Set(clips.map(clip => clip.sha256)).size !== 8) throw new Error('Expected eight distinct recorded sources');
  await engine.start(); result.model = engine.metadata;
  const standalone = [];
  for (const clip of clips) {
    const key = randomUUID(); await engine.request('open', key);
    await engine.request('push', key, clip.pcm.subarray(0, 320000));
    await engine.request('push', key, clip.pcm.subarray(320000));
    const reply = await engine.request('finish', key); standalone.push(reply.segments);
    await engine.request('close', key);
  }
  const keys = clips.map(() => randomUUID());
  for (const key of keys) await engine.request('open', key);
  for (let half = 0; half < 2; half++) for (let i = 0; i < clips.length; i++)
    await engine.request('push', keys[i], clips[i].pcm.subarray(half * 320000, (half + 1) * 320000));
  const interleaved = [];
  for (const key of keys) {
    interleaved.push((await engine.request('finish', key)).segments); await engine.request('close', key);
  }
  result.comparisons = clips.map((clip, index) => ({ video_id: clip.video_id, standalone: standalone[index],
    interleaved: interleaved[index], equal: JSON.stringify(standalone[index]) === JSON.stringify(interleaved[index]) }));
  result.mismatches = result.comparisons.filter(item => !item.equal).length;
  result.passed = result.mismatches === 0;
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  await engine.stop(); result.finished_at = new Date().toISOString();
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, mismatches: result.mismatches, error: result.error, directory }));
}
if (!result.passed) process.exitCode = 1;
