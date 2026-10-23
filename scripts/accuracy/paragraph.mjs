// Paragraph pass: re-corrects groups of consecutive corrected sentences with settled neighbours, and rescores.
// Usage: node scripts/accuracy/paragraph.mjs <set-dir> <corrected-result.json> <raw-result.json> <out.json> model=<id> [group=3] [alt=<file>]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cer } from './metrics.mjs';
import { parseCorrections } from '../../src/ai-correction.mjs';
import { paragraphPrompt } from '../../src/correction-prompt.mjs';
import { committees } from '../../public/committees.mjs';

const [set, input, rawInput, output, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.map(item => item.split('=')));
const base = options.base ?? 'http://127.0.0.1:10100/v1'; const model = options.model; const group = Number(options.group ?? 3);
if (!model || !Number.isInteger(group) || group < 1 || group > 10) throw new Error('Provide a model and a group size from 1 to 10');
const manifest = new Map(JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8')).map(item => [item.fidx, item]));
const corrected = JSON.parse(await readFile(input, 'utf8')); const raw = new Map(JSON.parse(await readFile(rawInput, 'utf8')).results.map(r => [r.fidx, r.chunks]));
const alternative = options.alt ? new Map(JSON.parse(await readFile(options.alt, 'utf8')).results.map(r => [r.fidx, r.chunks])) : null;
const extra = options.glossary ? JSON.parse(await readFile(options.glossary, 'utf8')) : {};
async function call(messages) {
  const started = Date.now();
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000), body: JSON.stringify({ model, stream: false, max_tokens: 3000, messages }) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return { text: (await response.json()).choices[0].message.content, ms: Date.now() - started };
}
async function window(result) {
  const item = manifest.get(result.fidx);
  const committee = committees.find(c => item.title.replace(/\s+/g, '').includes(c.name));
  const glossary = [...(committee ? committee.members.map(m => m.name + ' ' + (m.role === '위원' ? '위원' : m.role)) : []), ...(extra[result.fidx] ?? [])].join(', ');
  const current = [...result.chunks]; const rawChunks = raw.get(result.fidx); const altChunks = alternative?.get(result.fidx) ?? [];
  const latencies = []; let failures = 0;
  for (let start = 0; start < current.length; start += group) {
    const segments = [];
    for (let k = start; k < Math.min(current.length, start + group); k++) {
      if (!current[k].trim()) continue;
      segments.push({ id: 'S' + k, text: current[k], raw: rawChunks[k] ?? '', ...(altChunks[k] ? { alt: altChunks[k] } : {}) });
    }
    if (!segments.length) continue;
    const context = current.slice(Math.max(0, start - 2), start).filter(Boolean); const next = current.slice(start + group, start + group + 1).filter(Boolean).join(' ');
    const messages = paragraphPrompt({ committee: committee?.name ?? '', glossary, context, next, segments });
    try { const reply = await call(messages); latencies.push(reply.ms); for (const [id, text] of parseCorrections(reply.text, segments)) current[Number(id.slice(1))] = text; }
    catch (error) { failures++; }
  }
  const score = cer(item.reference, current.join(' '));
  return { fidx: result.fidx, ...score, failures, latencies, corrected: current.join(' '), chunks: current };
}
const inputs = corrected.results;
for (const r of inputs) {
  if (!manifest.has(r.fidx) || !Array.isArray(r.chunks) || !r.chunks.every(text => typeof text === 'string')
    || raw.get(r.fidx)?.length !== r.chunks.length
    || (alternative && alternative.get(r.fidx)?.length !== r.chunks.length))
    throw new Error('Aligned chunks are required for meeting ' + r.fidx);
}
const results = await Promise.all(inputs.map(window));
let errors = 0; let chars = 0; const latencies = results.flatMap(r => r.latencies).sort((a, b) => a - b);
for (const r of results) { errors += r.substitutions + r.insertions + r.deletions; chars += r.reference_chars - r.excluded_deletions; console.log(r.fidx, r.accuracy.toFixed(4), 'failures', r.failures); }
const summary = { model, group, source: input, accuracy: 1 - errors / chars, calls: latencies.length,
  latency_ms: { mean: Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length), p95: latencies[Math.floor(latencies.length * 0.95)], max: latencies.at(-1) } };
await writeFile(output, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));
