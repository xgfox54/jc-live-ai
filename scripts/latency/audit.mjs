// Audits a completed paced-file run without changing its database or original results.
// Usage: node scripts/latency/audit.mjs <run-dir> <out.json>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [directory, output] = process.argv.slice(2);
const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
const begin = Date.parse(result.summary.started);
const db = new DatabaseSync(join(directory, 'live.sqlite'), { readOnly: true });
const rows = db.prepare('SELECT document FROM segments').all().map(row => JSON.parse(row.document));
const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? { n: sorted.length, mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p95: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), p99: Math.round(sorted[Math.ceil(sorted.length * .99) - 1]),
    max: Math.round(sorted.at(-1)), over15s: sorted.filter(value => value > 15000).length } : null;
};
const firstDelays = [], processing = [], correction = [], held = [], late = [];
let before15 = 0, before30 = 0;
const scopeBySession = new Map();
for (const row of rows) {
  const origin = begin + row.start_ms;
  const revisions = db.prepare('SELECT document FROM corrections WHERE segment_id=? ORDER BY version').all(row.segment_id).map(r => JSON.parse(r.document));
  processing.push(row.ready_ms - origin);
  if (row.speaker_scope) {
    if (!scopeBySession.has(row.session_id)) scopeBySession.set(row.session_id, new Set());
    scopeBySession.get(row.session_id).add(row.speaker_scope);
  }
  if (!revisions.length) {
    const candidates = db.prepare('SELECT document FROM ai_candidates WHERE segment_id=?').all(row.segment_id).map(r => JSON.parse(r.document));
    held.push({ stream_id: row.stream_id, start_ms: row.start_ms, end_ms: row.end_ms,
      issues: [...new Set(candidates.map(c => c.issue ?? c.status))] });
    continue;
  }
  const ms = revisions[0].created_ms - origin;
  firstDelays.push(ms); correction.push(revisions[0].created_ms - row.ready_ms);
  if (ms <= 15000) before15++;
  if (ms <= 30000) before30++;
  if (ms > 15000) late.push({ stream_id: row.stream_id, start_ms: row.start_ms, end_ms: row.end_ms,
    first_delay_ms: Math.round(ms), raw_delay_ms: Math.round(row.ready_ms - origin), correction_ms: revisions[0].created_ms - row.ready_ms });
}
const scopeList = [...scopeBySession.values()].flatMap(value => [...value]);
const audit = { source: directory, latency_basis: 'paced source sample start; old unpaced packet tests may differ by up to one packet',
  segments: rows.length, published: firstDelays.length, unpublished: held.length, published_by_15s: before15, published_by_30s: before30,
  first_public_ms: stats(firstDelays), recognition_ready_ms: stats(processing), correction_after_ready_ms: stats(correction),
  corrupted_alt_segments: rows.filter(row => row.alt_text?.includes('\uFFFD')).length,
  speaker_sessions: scopeBySession.size, speaker_scopes: new Set(scopeList).size,
  speaker_scopes_shared_across_sessions: scopeList.length - new Set(scopeList).size,
  held, late };
db.close();
await writeFile(output, JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit));
