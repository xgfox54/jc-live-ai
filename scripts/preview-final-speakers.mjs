import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { identityAnchors, candidatesFor, dominantSpeaker, presidingOfficers } from '../src/final-speakers.mjs';
import { peopleCandidates } from '../src/people-reference.mjs';
// Read-only preview of rule-based speaker candidates for one meeting; no model request and no database write.
const db = new DatabaseSync(process.argv[3] ?? 'data/live.sqlite', { readOnly: true });
const registry = Object.create(BroadcastRegistry.prototype); registry.db = db;
const id = process.argv[2]; const record = registry.get(id); const rows = registry.publishedSegments(id);
const directory = { meetings: JSON.parse(readFileSync('data/speaker-labels.json', 'utf8')) };
const people = peopleCandidates(record, directory);
const officers = presidingOfficers(rows, people);
const anchors = identityAnchors(rows, people, record);
const previous = registry.reviewState('final-speakers:' + id);
let covered = 0; const kinds = {}; const samples = {}; const conflicts = [];
for (let i = 0; i < rows.length; i++) {
  const list = candidatesFor(i, rows, anchors); if (!list.length) continue; covered++;
  const prior = previous?.assignments?.[rows[i].segment_id];
  if (prior && !list.some(c => c.name === prior.name)) conflicts.push({ i, prior: prior.name, now: list.map(c => c.name) });
  for (const c of list) { const k = c.kind + (anchors.find(a => a.id === c.evidence_id && a.name === c.name)?.index === i ? '' : '-linked'); kinds[k] = (kinds[k] ?? 0) + 1;
    (samples[k] ??= []).push(i + ' L' + (dominantSpeaker(rows[i]) ?? '-') + ' [' + c.name + '] ' + rows[i].corrected_text.slice(0, 70)); }
}
console.log(JSON.stringify({ meeting: record.title, rows: rows.length, officers: [...officers].map(([s, p]) => s.slice(0, 8) + ':' + p.name + '(' + p.office + ')'),
  previous_assigned: previous?.assigned, candidate_groups: covered, by_kind: kinds, lost_previous_names: conflicts.length }, null, 1));
for (const [k, list] of Object.entries(samples)) { console.log('== ' + k); for (const line of list.filter((_, n) => n % Math.max(1, Math.floor(list.length / 6)) === 0).slice(0, 6)) console.log('  ' + line); }
for (const c of conflicts.slice(0, 5)) console.log('lost', JSON.stringify(c));

