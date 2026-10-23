// Runs the production worker over an accuracy set and scores it against official minutes.
// Usage: node scripts/accuracy/run.mjs <set-dir> <result.json> [model=models/x.bin] [beam=2] [chunk=fixed10|vad] [prompt=none|prev] [windows=n]
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { cer } from './metrics.mjs';
import { Segmenter } from '../../src/segmenter.mjs';
import { committees } from '../../public/committees.mjs';
import { recognitionPrompt } from '../../src/recognition-prompt.mjs';

const [set, output, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.map(item => item.split('=')));
const model = options.model ?? 'models/ggml-small-q5_1.bin'; const beam = options.beam ?? '2';
const chunk = options.chunk ?? 'fixed10'; const promptMode = options.prompt ?? 'none';
const pick = options.pick ? new Set(options.pick.split(',').map(Number)) : null;
const manifest = JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8')).filter(item => !pick || pick.has(item.fidx)).slice(0, Number(options.windows ?? 99));
const speakerGlossary = options.speakers ? JSON.parse(await readFile(options.speakers, 'utf8')) : {};

const decodeEntries = Object.entries(options).filter(([key]) => key.startsWith('d.')).map(([key, value]) => [key.slice(2), JSON.parse(value)]);
const decode = decodeEntries.length ? Object.fromEntries(decodeEntries) : undefined;
const worker = options.worker ?? (decode || options.actx ? 'bin/jc-live-worker-next.exe' : 'bin/jc-live-worker.exe');
const child = spawn(worker, [model, beam, 'gpu'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const ready = JSON.parse((await lines.next()).value);
async function transcribe(pcm, prompt) {
  const audioCtx = options.actx === 'auto' ? { audio_ctx: Math.min(1500, Math.ceil(pcm.length / 32000 * 50) + 64) } : {};
  const merged = decode || options.actx ? { ...decode, ...audioCtx } : null;
  child.stdin.write(JSON.stringify({ id: 'x', pcm: pcm.toString('base64'), prompt, ...(merged ? { decode: merged } : {}) }) + '\n');
  const reply = JSON.parse((await lines.next()).value);
  if (reply.error) throw new Error(reply.error);
  return reply;
}
function* fixed(audio, seconds) { for (let o = 0; o < audio.length; o += seconds * 32000) yield audio.subarray(o, Math.min(audio.length, o + seconds * 32000)); }
function* vad(audio) {
  const [minS, maxS] = (options.seg ?? '4,10').split(',').map(Number);
  const segmenter = new Segmenter({ minS, maxS });
  for (let o = 0; o < audio.length; o += 32000) for (const piece of segmenter.push(audio.subarray(o, o + 32000))) yield piece.pcm;
  for (const piece of segmenter.flush()) yield piece.pcm;
}
const results = []; let totals = { errors: 0, chars: 0, raw_errors: 0, raw_chars: 0 }; const timings = [];
for (const item of manifest) {
  const audio = await readFile(join(set, item.pcm)); const texts = []; let previous = '';
  const committee = committees.find(c => item.title.replace(/\s+/g, '').includes(c.name));
  const pieces = chunk === 'vad' ? vad(audio) : fixed(audio, Number(chunk.replace('fixed', '')) || 10);
  for (const pcm of pieces) {
    if (pcm.length < 3200) continue;
    const prompt = promptMode === 'none' ? '' : recognitionPrompt({ committee, previous: promptMode === 'glossary' ? '' : previous,
      glossary: promptMode !== 'prev', speakers: (speakerGlossary[item.fidx] ?? []).filter(label => !/ 위원$/.test(label)) });
    const reply = await transcribe(Buffer.from(pcm), prompt);
    const text = reply.spans.map(span => span.text).join('').trim(); texts.push(text); if (text) previous = text;
    timings.push({ audio_s: pcm.length / 32000, inference_ms: reply.inference_ms });
  }
  const hypothesis = texts.join(' '); const score = cer(item.reference, hypothesis);
  totals.errors += score.substitutions + score.insertions + score.deletions;
  totals.chars += score.reference_chars - score.excluded_deletions;
  totals.raw_errors += score.cer_raw * score.reference_chars; totals.raw_chars += score.reference_chars;
  results.push({ fidx: item.fidx, title: item.title, ...score, hypothesis, chunks: texts });
  console.log(JSON.stringify({ fidx: item.fidx, accuracy: score.accuracy.toFixed(4), cer_raw: score.cer_raw.toFixed(4), excluded_ins: score.excluded_insertions }));
}
child.stdin.end();
const inference = timings.map(t => t.inference_ms).sort((a, b) => a - b);
const summary = { model, beam, chunk, prompt: promptMode, decode: decode ?? null, actx: options.actx ?? null, worker, engine: ready, windows: results.length,
  accuracy: 1 - totals.errors / totals.chars, cer: totals.errors / totals.chars, cer_raw: totals.raw_errors / totals.raw_chars,
  chunks: timings.length, mean_chunk_s: timings.reduce((s, t) => s + t.audio_s, 0) / timings.length,
  inference_ms: { mean: inference.reduce((s, v) => s + v, 0) / inference.length, p95: inference[Math.floor(inference.length * 0.95)], max: inference.at(-1) },
  rtf: inference.reduce((s, v) => s + v, 0) / 1000 / timings.reduce((s, t) => s + t.audio_s, 0) };
await writeFile(output, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));

