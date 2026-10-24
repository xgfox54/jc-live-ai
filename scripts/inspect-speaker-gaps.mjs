import { DatabaseSync } from 'node:sqlite';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { dominantSpeaker } from '../src/final-speakers.mjs';
const db = new DatabaseSync('data/live.sqlite', { readOnly: true });
const registry = Object.create(BroadcastRegistry.prototype); registry.db = db;
const id = process.argv[2];
const rows = registry.publishedSegments(id);
const state = registry.reviewState('final-speakers:' + id);
const PRESIDING = /(?:개의하겠습니다|개회하겠습니다|산회를 선포|정회를 선포|선포합니다|일괄 상정합니다|상정합니다|질의(?:하여|해)\s*주시기\s*바랍니다|의견이 모아졌습니다|가결되었음을)/;
const VOTE = /(?:재석|찬성|반대|기권).{0,10}(?:명|분)/;
const ADDRESS = /(?:존경하는|도민 여러분|의원 여러분|동료 의원)/;
const ANSWER = /(?:답변드리겠습니다|말씀드리겠습니다|검토하겠습니다|노력하겠습니다)/;
let stats = { total: rows.length, assigned: 0, unresolved: 0 }; const cat = {}; const states = {}; const names = {};
const byScope = new Map();
for (const row of rows) {
  const a = state.assignments[row.segment_id];
  const sp = dominantSpeaker(row); const key = row.session_id.slice(0,8) + ':' + (sp ?? '-');
  if (a) { stats.assigned++; names[a.name] = (names[a.name] ?? 0) + 1; const m = byScope.get(key) ?? {}; m[a.name] = (m[a.name] ?? 0) + 1; byScope.set(key, m); continue; }
  stats.unresolved++;
  states[row.speaker_state] = (states[row.speaker_state] ?? 0) + 1;
  const t = row.corrected_text; const c = PRESIDING.test(t) ? 'presiding' : VOTE.test(t) ? 'vote' : ADDRESS.test(t) ? 'address' : ANSWER.test(t) ? 'answer' : t.length < 15 ? 'short' : 'other';
  cat[c] = (cat[c] ?? 0) + 1;
  const m = byScope.get(key) ?? {}; m['?'] = (m['?'] ?? 0) + 1; byScope.set(key, m);
}
console.log(JSON.stringify({ stats, method: state.method, unresolved_by_kind: cat, unresolved_speaker_state: states, names }, null, 1));
console.log('scope:label -> names/unresolved (top 25)');
for (const [k, v] of [...byScope.entries()].sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y) - Object.values(a[1]).reduce((x, y) => x + y)).slice(0, 25)) console.log(k, JSON.stringify(v));
const sessions = [...new Set(rows.map(r => r.session_id))]; console.log('sessions', sessions.map(s => s.slice(0,8) + ':' + rows.filter(r => r.session_id === s).length).join(' '));

