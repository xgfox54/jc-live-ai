// Applies AI correction to per-chunk recognition results, the way live correction runs, and rescores against official minutes.
// Usage: node scripts/accuracy/correct.mjs <set-dir> <run-result.json> <out.json> model=<id> style=plain|minutes [context=2] [glossary=<file>]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cer } from './metrics.mjs';
import { parseCorrections } from '../../src/ai-correction.mjs';
import { correctionPrompt } from '../../src/correction-prompt.mjs';
import { committees } from '../../public/committees.mjs';

const [set, input, output, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.map(item => item.split('=')));
const base = options.base ?? 'http://127.0.0.1:10100/v1'; const model = options.model; const style = options.style ?? 'minutes';
const contextSize = Number(options.context ?? 2);
const manifest = new Map(JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8')).map(item => [item.fidx, item]));
const run = JSON.parse(await readFile(input, 'utf8'));
const extra = options.glossary ? JSON.parse(await readFile(options.glossary, 'utf8')) : {};
const alternative = options.alt ? new Map(JSON.parse(await readFile(options.alt, 'utf8')).results.map(result => [result.fidx, result.chunks])) : null;

async function call(messages) {
  const started = Date.now();
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000), body: JSON.stringify({ model, stream: false, max_tokens: 2000, messages }) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + (await response.text()).slice(0, 200));
  const value = await response.json();
  return { text: value.choices[0].message.content, ms: Date.now() - started };
}
async function window(result) {
  const item = manifest.get(result.fidx);
  const committee = committees.find(c => item.title.replace(/\s+/g, '').includes(c.name));
  const glossary = [...(committee ? committee.members.map(m => m.name + ' ' + (m.role === '위원' ? '위원' : m.role)) : []),
    ...(extra[result.fidx] ?? extra.all ?? [])].join(', ');
  const corrected = []; const latencies = []; let failures = 0;
  const perChunk = [];
  for (const [index, text] of result.chunks.entries()) {
    const alt = alternative?.get(result.fidx)?.[index]?.trim() ?? '';
    if (!text.trim() && !alt) { perChunk.push(''); continue; }
    const context = corrected.slice(-contextSize);
    const next = options.next ? (result.chunks[index + 1] ?? '') : '';
    const messages = correctionPrompt({ style, committee: committee?.name ?? '', glossary, context, next, segments: [{ id: 'S0', text, ...(alt ? { alt } : {}) }] });
    let out = text;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const reply = await call(messages); latencies.push(reply.ms); out = parseCorrections(reply.text, [{ id: 'S0' }]).get('S0'); break; }
      catch (error) { failures++; if (attempt === 1) console.error(result.fidx, error.message); }
    }
    corrected.push(out); perChunk.push(out);
  }
  const score = cer(item.reference, corrected.join(' '));
  return { fidx: result.fidx, ...score, failures, latencies, corrected: corrected.join(' '), chunks: perChunk };
}
const results = await Promise.all(run.results.map(window));
let errors = 0; let chars = 0; const latencies = results.flatMap(r => r.latencies).sort((a, b) => a - b);
for (const r of results) { errors += r.substitutions + r.insertions + r.deletions; chars += r.reference_chars - r.excluded_deletions; console.log(r.fidx, r.accuracy.toFixed(4), 'failures', r.failures); }
const summary = { model, style, context: contextSize, source: input, accuracy: 1 - errors / chars, calls: latencies.length,
  latency_ms: { mean: Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length), p50: latencies[Math.floor(latencies.length / 2)],
    p95: latencies[Math.floor(latencies.length * 0.95)], max: latencies.at(-1) } };
await writeFile(output, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));

