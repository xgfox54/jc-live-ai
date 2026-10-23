import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { publicSpeech } from '../src/silence-filter.mjs';

const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
const db = new DatabaseSync(config.database, { readOnly: true });
const settings = JSON.parse(db.prepare("SELECT document FROM ai_settings WHERE id='global'").get()?.document ?? '{}');
const rows = db.prepare("SELECT s.document,b.broadcast_id FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id WHERE s.stream_id='ch0' AND json_extract(s.document,'$.ai_corrected')=0").all();
const pending = rows.map(row => {
  const segment = JSON.parse(row.document);
  const candidates = db.prepare('SELECT document FROM ai_candidates WHERE segment_id=? ORDER BY rowid DESC LIMIT 8').all(segment.segment_id).map(row => JSON.parse(row.document));
  return { broadcast_id: row.broadcast_id, segment_id: segment.segment_id, session_id: segment.session_id,
    raw_text: segment.raw_text, version: segment.version, start_ms: segment.start_ms, publicSpeech: publicSpeech(segment),
    candidates: candidates.map(({status,issue,source_version}) => ({status,issue,source_version})) };
});
console.log(JSON.stringify({ settings: { provider: settings.provider, host: settings.base ? new URL(settings.base).hostname : null,
  model: settings.model, refine_model: settings.refine_model, automatic: settings.automatic },
  jobs: db.prepare('SELECT document FROM ai_jobs').all().map(row => JSON.parse(row.document)).map(({id,phase,processed,error,ended_ms}) => ({id,phase,processed,error,ended_ms})),
  hidden_pending: pending.filter(row => !row.publicSpeech).length, pending: pending.filter(row => row.publicSpeech) }, null, 2));
db.close();
