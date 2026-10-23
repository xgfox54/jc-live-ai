import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WhisperEngine } from '../src/engine.mjs';

// Compares decode settings on identical real speech segments with one shared GPU worker.
// Candidates rotate per segment so external GPU load affects every candidate alike.
const [manifestPath = 'reports/live-diarization-20261021/live-eight-600s/result.json', outputPath, perSourceText = '6',
  secondsText = '6', namesText = ''] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: bench-decode.mjs <manifest> <new output dir> [segments per source] [segment seconds] [candidate names]');
const output = resolve(outputPath);
if (existsSync(output)) throw new Error('Use a new output directory');
mkdirSync(output, { recursive: true });
const base = JSON.parse(readFileSync('config.local.json'));
const config = { worker: resolve(base.worker), model: resolve(base.model), device: base.device, beam: base.beam,
  decode: base.decode, engineLog: output + '/engine.log', inferenceTimeoutMs: 120000 };
const prior = JSON.parse(readFileSync(manifestPath));
const perSource = Number(perSourceText);
const seconds = Number(secondsText);
if (!Number.isInteger(seconds) || seconds < 2 || seconds > 30) throw new Error('Invalid segment seconds');
const segments = [];
for (const source of prior.sources.slice(0, 8)) {
  const recording = prior.recordings.find(item => item.video_id === source.video_id);
  const pcm = readFileSync(recording.file);
  for (let k = 0; k < perSource; k++) {
    const start = (30 + k * 60) * 32000;
    if (start + seconds * 32000 > pcm.length) break;
    const piece = pcm.subarray(start, start + seconds * 32000);
    let sum = 0; for (let i = 0; i < piece.length; i += 2) { const v = piece.readInt16LE(i) / 32768; sum += v * v; }
    if (Math.sqrt(sum / (piece.length / 2)) < 0.005) continue;
    segments.push({ id: source.name + '#' + k, pcm: piece });
  }
}
export const contextFor = samples => Math.min(1500, Math.ceil((Math.ceil(samples / 16000 * 50) + 128) / 64) * 64);
const ctx = contextFor(seconds * 16000);
const all = [
  { name: 'beam2-full', decode: { beam: 2 } },
  { name: 'greedy-full', decode: { beam: 1 } },
  { name: 'beam2-ctx' + ctx, decode: { beam: 2, audio_ctx: ctx } },
  { name: 'greedy-ctx' + ctx, decode: { beam: 1, audio_ctx: ctx } },
];
const names = namesText ? namesText.split(',') : all.map(c => c.name);
const candidates = all.filter(c => names.includes(c.name));
if (candidates[0]?.name !== 'beam2-full') throw new Error('beam2-full must be the first candidate (reference)');
const normalize = text => text.replace(/[\s.,!?·…"'()\[\]-]/g, '');
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
const repeated = text => /(.{2,12})\1{3,}/u.test(normalize(text));
const engine = new WhisperEngine(config);
const rows = [];
try {
  await engine.start();
  for (const name of candidates.map(c => c.name)) { // warmup each decode path once
    engine.config.decode = { ...base.decode, ...candidates.find(c => c.name === name).decode };
    await engine.transcribe({ pcm: segments[0].pcm, prompt: '' });
  }
  for (const [index, segment] of segments.entries()) {
    const order = candidates.map((_, i) => candidates[(i + index) % candidates.length]);
    const result = { id: segment.id };
    for (const candidate of order) {
      engine.config.decode = { ...base.decode, ...candidate.decode };
      const reply = await engine.transcribe({ pcm: segment.pcm, prompt: '' });
      result[candidate.name] = { ms: reply.inference_ms, text: reply.spans.map(s => s.text).join(' ').trim() };
    }
    rows.push(result);
    process.stdout.write(JSON.stringify({ done: rows.length, total: segments.length }) + '\n');
  }
} finally { await engine.stop(); }
const reference = candidates[0].name;
const summary = candidates.map(candidate => {
  const total = rows.reduce((sum, row) => sum + row[candidate.name].ms, 0);
  let edits = 0, chars = 0;
  for (const row of rows) {
    const ref = normalize(row[reference].text); const hyp = normalize(row[candidate.name].text);
    edits += distance(ref, hyp); chars += ref.length;
  }
  return { name: candidate.name, decode: candidate.decode, segments: rows.length, audio_s: rows.length * seconds,
    inference_s: total / 1000, audio_per_inference_second: rows.length * seconds / (total / 1000),
    char_difference_vs_reference: chars ? edits / chars : null,
    empty: rows.filter(row => !normalize(row[candidate.name].text)).length,
    repetition: rows.filter(row => repeated(row[candidate.name].text)).length };
});
writeFileSync(output + '/rows.json', JSON.stringify(rows, null, 2));
writeFileSync(output + '/summary.json', JSON.stringify({ at: new Date().toISOString(), reference, model: base.model,
  segment_seconds: seconds, note: 'Character difference is measured against the current beam2-full output, not human-reviewed truth.', summary }, null, 2));
console.log(JSON.stringify(summary, null, 1));

