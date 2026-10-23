// Exports the public (AI-corrected) text of a live8 run per stream in the judge/rescore result format.
// Usage: node scripts/latency/export.mjs <set-dir> <run-dir> <out.json> [final|first|view]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cer, referenceText } from '../accuracy/metrics.mjs';

const [set, dir, output, snapshot = 'final'] = process.argv.slice(2);
if (!['final', 'first', 'view'].includes(snapshot)) throw new Error('snapshot must be final, first or view');
const manifest = JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8'));
const run = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
const db = new DatabaseSync(join(dir, 'live.sqlite'), { readOnly: true });
const results = []; let errors = 0; let chars = 0; let fullErrors = 0; let fullChars = 0;
const started = Date.parse(run.summary.started);
for (const item of run.accuracy) {
  const meta = manifest.find(m => m.fidx === item.fidx);
  const rows = db.prepare('SELECT s.document FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id JOIN broadcasts r ON r.id=b.broadcast_id '
    + "WHERE json_extract(r.document,'$.title')=? ORDER BY s.start_ms").all(meta.title).map(row => JSON.parse(row.document));
  const full = referenceText(meta.minutes); const reference = full.slice(0, Math.floor(full.length * Math.min(1, item.fed_s / (meta.end_s - meta.start_s))));
  const corrected = rows.map(row => {
    const revisions = db.prepare('SELECT document FROM corrections WHERE segment_id=? ORDER BY version').all(row.segment_id).map(r => JSON.parse(r.document));
    if (snapshot === 'first') return revisions[0]?.text ?? '';
    if (snapshot === 'view') return revisions.filter(r => r.created_ms <= started + row.start_ms + 30000).at(-1)?.text ?? '';
    return row.ai_corrected ? row.corrected_text : '';
  }).join(' '); const hypothesis = rows.map(row => row.raw_text).join(' ');
  const score = cer(reference, corrected); errors += score.substitutions + score.insertions + score.deletions; chars += score.reference_chars - score.excluded_deletions;
  const exact = cer(reference, corrected, { trim: 0, edge: 0, run: Infinity });
  fullErrors += exact.substitutions + exact.insertions + exact.deletions + exact.excluded_insertions + exact.excluded_deletions;
  fullChars += exact.reference_chars;
  results.push({ fidx: item.fidx, reference, corrected, hypothesis, reference_estimated: item.fed_s < meta.end_s - meta.start_s - 1,
    unadjusted_accuracy: 1 - exact.cer_raw, ...score });
}
await writeFile(output, JSON.stringify({ summary: { source: dir, snapshot, accuracy: 1 - errors / chars,
  unadjusted_accuracy: 1 - fullErrors / fullChars, reference_chars: fullChars,
  scoring_note: 'Normalized official minutes; accuracy excludes selected differences. Unadjusted accuracy includes all edit operations. Partial reference endpoints are estimated by duration.' }, results }, null, 2));
db.close();
console.log(output, (1 - errors / chars).toFixed(4));

