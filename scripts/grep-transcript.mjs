import { DatabaseSync } from 'node:sqlite';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { dominantSpeaker } from '../src/final-speakers.mjs';
const db = new DatabaseSync('data/live.sqlite', { readOnly: true });
const registry = Object.create(BroadcastRegistry.prototype); registry.db = db;
const id = process.argv[2]; const pattern = new RegExp(process.argv[3]); const limit = Number(process.argv[4] ?? 40);
const rows = registry.publishedSegments(id); const state = registry.reviewState('final-speakers:' + id);
let n = 0;
for (const [i, row] of rows.entries()) {
  if (!pattern.test(row.corrected_text)) continue;
  if (n++ >= limit) break;
  const a = state.assignments[row.segment_id];
  console.log(i, row.session_id.slice(0,4), Math.round(row.start_ms/1000), 'L' + (dominantSpeaker(row) ?? '-'), a ? '[' + a.name + ']' : '[?]', row.corrected_text.slice(0, 150));
}
console.log('matches', rows.filter(r => pattern.test(r.corrected_text)).length);

