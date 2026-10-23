import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { identityAnchors, validateAssignments, finalSourceGuard, finalSourceHash, REVIEW_METHOD } from '../src/final-speakers.mjs';
import { peopleCandidates } from '../src/people-reference.mjs';

// Explicit database path required. Dry run is read-only; --apply only removes unsupported names.
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
if (!args.includes('--database') || !args.includes('--report')) throw new Error('Required: --database <path> --report <path> [--apply]');
const db = new DatabaseSync(option('--database'), { readOnly: !args.includes('--apply') });
const registry = Object.create(BroadcastRegistry.prototype); registry.db = db;
const directory = { meetings: JSON.parse(readFileSync('reports/accuracy/speaker-labels.json', 'utf8')) };
const reports = []; const changes = [];
try {
  db.exec('BEGIN');
  for (const record of registry.list()) {
    const previous = registry.reviewState('final-speakers:' + record.id);
    if (!previous || !['complete', 'partial'].includes(previous.phase) || previous.method === REVIEW_METHOD) continue;
    if (previous.method === REVIEW_METHOD + '-revalidated' && previous.source_guard === finalSourceGuard(registry, record.id)) continue;
    const rows = registry.publishedSegments(record.id);
    const people = peopleCandidates(record, directory);
    const anchors = identityAnchors(rows, people, record);
    const assignments = {}; const rejected = [];
    for (const row of rows) {
      const prior = previous.assignments[row.segment_id];
      assignments[row.segment_id] = prior ? validateAssignments({ assignments: [{ id: row.segment_id, ...prior }] }, [row], rows, people, anchors)[row.segment_id] : null;
      if (prior && !assignments[row.segment_id]) rejected.push({ id: row.segment_id, name: prior.name, evidence_id: prior.evidence_id });
    }
    const assigned = Object.values(assignments).filter(Boolean).length;
    const value = { ...previous, method: REVIEW_METHOD + '-revalidated', previous_method: previous.method,
      phase: assigned === rows.length ? 'complete' : 'partial', assignments, people, assigned, unresolved: rows.length - assigned,
      source_guard: finalSourceGuard(registry, record.id), source_hash: finalSourceHash(registry, record.id), updated_ms: Date.now(),
      revalidation: 'Existing names only; current evidence rules; no model request.' };
    changes.push({ id: 'final-speakers:' + record.id, value, rejected: rejected.length });
    reports.push({ id: record.id, title: record.title, previous_assigned: previous.assigned, assigned, unresolved: value.unresolved, rejected });
  }
  if (args.includes('--apply')) for (const change of changes) {
    db.prepare('UPDATE review_state SET document=? WHERE id=?').run(JSON.stringify(change.value), change.id);
    db.prepare('INSERT INTO audit(created_ms,document) VALUES(?,?)').run(Date.now(), JSON.stringify({
      action: 'speakers.evidence-revalidation', broadcast_id: change.id.slice('final-speakers:'.length),
      previous_method: change.value.previous_method, method: change.value.method, rejected: change.rejected,
      assigned: change.value.assigned, unresolved: change.value.unresolved }));
  }
  db.exec('COMMIT');
  writeFileSync(option('--report'), JSON.stringify({ applied: args.includes('--apply'), database: option('--database'), reports }, null, 2));
  console.log(JSON.stringify({ applied: args.includes('--apply'), meetings: reports.length, rejected: reports.reduce((n,r) => n + r.rejected.length, 0) }));
} finally { db.close(); }
