import { DatabaseSync } from 'node:sqlite';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { dominantSpeaker } from '../src/final-speakers.mjs';
const db = new DatabaseSync('data/live.sqlite', { readOnly: true });
const registry = Object.create(BroadcastRegistry.prototype); registry.db = db;
const id = process.argv[2]; const rows = registry.publishedSegments(id); const state = registry.reviewState('final-speakers:' + id);
for (const center of process.argv.slice(3).map(Number)) {
  console.log('---');
  for (let i = Math.max(0, center - 2); i <= Math.min(rows.length - 1, center + 3); i++) {
    const row = rows[i]; const a = state.assignments[row.segment_id];
    console.log(i, row.session_id.slice(0,4), Math.round(row.start_ms/1000), 'L' + (dominantSpeaker(row) ?? '-'), row.speaker_state, a ? '[' + a.name + ']' : '[?]', row.corrected_text.slice(0, 120));
  }
}

