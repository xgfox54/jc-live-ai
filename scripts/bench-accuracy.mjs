import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { WhisperEngine } from '../src/engine.mjs';

const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.local.json'));
const output = resolve(process.argv[3] ?? 'reports/accuracy'); mkdirSync(output, { recursive: true });
const normalize = value => value.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
      previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}
const reports = [];
for (const beam of config.benchmarkBeams ?? [2, 1]) {
  config.beam = beam; config.engineLog = output + '/engine-beam' + beam + '.log';
  const engine = new WhisperEngine(config); await engine.start();
  try {
    for (const chunk of [5, 10]) {
      const rows = []; const start = Date.now();
      for (let i = 1; i <= 8; i++) {
        const prefix = 'data/synthetic-speech/ch' + i;
        const reference = normalize(readFileSync(prefix + '.txt', 'utf8'));
        const pcm = readFileSync(prefix + '.pcm'); let hypothesis = '';
        for (let offset = 0; offset < pcm.length; offset += chunk * 32000) {
          const result = await engine.transcribe({ pcm: pcm.subarray(offset, offset + chunk * 32000), prompt: '' });
          hypothesis += result.spans.map(span => span.text).join('');
        }
        const errors = distance(reference, normalize(hypothesis));
        rows.push({ stream: 'ch' + i, audio_s: pcm.length / 32000, reference_chars: reference.length,
          edit_distance: errors, cer: errors / reference.length, hypothesis });
      }
      const wall = (Date.now() - start) / 1000;
      const report = { beam, chunk_seconds: chunk, model: basename(config.model),
        model_sha256: createHash('sha256').update(readFileSync(config.model)).digest('hex'), batch: 1, device: config.device,
        source: 'synthetic Korean TTS; scripted reference, not human-verified meeting audio',
        normalization: 'NFC; remove whitespace and punctuation; keep letters and digits',
        audio_s: rows.reduce((n, r) => n + r.audio_s, 0), wall_s: wall,
        cer: rows.reduce((n, r) => n + r.edit_distance, 0) / rows.reduce((n, r) => n + r.reference_chars, 0), rows };
      report.capacity_audio_s_per_wall_s = report.audio_s / wall; reports.push(report);
      writeFileSync(output + '/summary.json', JSON.stringify(reports, null, 2));
      console.log(JSON.stringify({ beam, chunk, C: report.capacity_audio_s_per_wall_s, cer: report.cer }));
    }
  } finally { await engine.stop(); }
}
