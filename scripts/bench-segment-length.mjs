import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WhisperEngine } from '../src/engine.mjs';

// Same 30-second speech windows, split into different segment lengths and decoded alternately on one worker,
// so changing external GPU load affects every candidate in the same window.
const [manifestPath, outputPath, windowsText = '3', namesText = 'beam2@6,beam2@8,beam2@10,greedy@10'] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('Usage: bench-segment-length.mjs <manifest> <new output dir> [windows per source] [beam2@6,...]');
const output = resolve(outputPath);
if (existsSync(output)) throw new Error('Use a new output directory');
mkdirSync(output, { recursive: true });
const base = JSON.parse(readFileSync('config.local.json'));
const config = { worker: resolve(base.worker), model: resolve(base.model), device: base.device, beam: base.beam,
  decode: base.decode, engineLog: output + '/engine.log', inferenceTimeoutMs: 120000 };
const candidates = namesText.split(',').map(name => {
  const [mode, rest] = name.split('@'); const [seconds, attention] = rest.split('+');
  if (!['beam2', 'greedy'].includes(mode) || !Number.isInteger(Number(seconds))) throw new Error('Invalid candidate ' + name);
  if (attention !== undefined && attention !== 'flash') throw new Error('Invalid candidate ' + name);
  return { name, seconds: Number(seconds), flash: attention === 'flash', decode: { beam: mode === 'greedy' ? 1 : 2 } };
});
const prior = JSON.parse(readFileSync(manifestPath));
const windows = [];
for (const source of prior.sources.slice(0, 8)) {
  const recording = prior.recordings.find(item => item.video_id === source.video_id);
  const pcm = readFileSync(recording.file);
  for (let k = 0; k < Number(windowsText); k++) {
    const start = (30 + k * 120) * 32000;
    if (start + 30 * 32000 <= pcm.length) windows.push({ id: source.name + '#' + k, pcm: pcm.subarray(start, start + 30 * 32000) });
  }
}
const normalize = text => text.replace(/[\s.,!?·…"'()\[\]-]/g, '');
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const current = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current; }
  }
  return row[b.length];
}
const engines = new Map([...new Set(candidates.map(c => c.flash))].map(flash =>
  [flash, new WhisperEngine({ ...config, flashAttention: flash, engineLog: output + '/engine' + (flash ? '-flash' : '') + '.log' })]));
const rows = [];
try {
  const ready = [];
  for (const engine of engines.values()) ready.push(await engine.start());
  writeFileSync(output + '/engines.json', JSON.stringify(ready, null, 2));
  for (const [index, window] of windows.entries()) {
    const row = { id: window.id };
    for (const candidate of candidates.map((_, i) => candidates[(i + index) % candidates.length])) {
      const engine = engines.get(candidate.flash);
      engine.config.decode = { ...base.decode, ...candidate.decode };
      const texts = []; let ms = 0; let calls = 0;
      for (let offset = 0; offset < 30; offset += candidate.seconds) {
        const end = Math.min(30, offset + candidate.seconds);
        const reply = await engine.transcribe({ pcm: window.pcm.subarray(offset * 32000, end * 32000), prompt: '' });
        ms += reply.inference_ms; calls++; texts.push(reply.spans.map(s => s.text).join(' ').trim());
      }
      row[candidate.name] = { ms, calls, text: texts.join(' ') };
    }
    rows.push(row); process.stdout.write(JSON.stringify({ done: rows.length, total: windows.length }) + '\n');
  }
} finally { for (const engine of engines.values()) await engine.stop(); }
const reference = candidates[0].name;
const summary = candidates.map(candidate => {
  const total = rows.reduce((sum, row) => sum + row[candidate.name].ms, 0);
  let edits = 0, chars = 0;
  for (const row of rows) { const ref = normalize(row[reference].text); edits += distance(ref, normalize(row[candidate.name].text)); chars += ref.length; }
  const perWindow = rows.map(row => row[candidate.name].ms / 30000).sort((a, b) => a - b);
  return { name: candidate.name, decode: candidate.decode, segment_seconds: candidate.seconds, audio_s: rows.length * 30,
    inference_s: total / 1000, audio_per_inference_second: rows.length * 30 / (total / 1000),
    worst_window_audio_per_second: 1 / perWindow.at(-1),
    char_difference_vs_reference: edits / chars, wins_vs_reference: rows.filter(row => row[candidate.name].ms < row[reference].ms).length };
});
writeFileSync(output + '/rows.json', JSON.stringify(rows, null, 2));
writeFileSync(output + '/summary.json', JSON.stringify({ at: new Date().toISOString(), reference, windows: rows.length,
  note: 'Character difference is against the reference candidate output, not human-reviewed truth.', summary }, null, 2));
console.log(JSON.stringify(summary, null, 1));

