import { finalSourceGuard, REVIEW_METHOD } from './final-speakers.mjs';
import { publicSpeech } from './silence-filter.mjs';
import { createHash } from 'node:crypto';

export class BroadcastRegistry {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS broadcasts(id TEXT PRIMARY KEY, document TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS broadcast_sessions(session_id TEXT PRIMARY KEY, broadcast_id TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS automation_settings(id TEXT PRIMARY KEY, document TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS minutes(broadcast_id TEXT PRIMARY KEY, document TEXT NOT NULL);');
    this.db.exec("CREATE INDEX IF NOT EXISTS broadcast_session_group ON broadcast_sessions(broadcast_id);"
      + "CREATE INDEX IF NOT EXISTS broadcast_gap_session ON events(json_extract(payload,'$.session_id')) WHERE kind='gap';");
  }
  list() { return this.db.prepare('SELECT document FROM broadcasts ORDER BY rowid DESC').all().map(row => JSON.parse(row.document)); }
  get(id) { const row = this.db.prepare('SELECT document FROM broadcasts WHERE id=?').get(id); return row ? JSON.parse(row.document) : null; }
  save(value) {
    this.db.prepare('INSERT INTO broadcasts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(value.id, JSON.stringify(value));
    this.store.emit('broadcast', value.id);
    return value;
  }
  upsert(candidate) {
    const matches = this.list().filter(item => (candidate.video_id && item.video_id === candidate.video_id)
      || item.sources.some(url => candidate.sources.includes(url))).sort((a, b) => a.first_seen_ms - b.first_seen_ms);
    const existing = matches[0];
    const official = matches.find(item => item.kind === 'council');
    const id = existing?.id ?? createHash('sha256').update(candidate.video_id ? 'youtube:' + candidate.video_id : candidate.page_url).digest('hex');
    const metadata = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== '' && value !== null && value !== undefined));
    return this.store.transaction(() => {
      for (const duplicate of matches.slice(1)) {
        this.db.prepare('UPDATE broadcast_sessions SET broadcast_id=? WHERE broadcast_id=?').run(id, duplicate.id);
        this.db.prepare('DELETE FROM broadcasts WHERE id=?').run(duplicate.id);
        this.db.prepare('DELETE FROM minutes WHERE broadcast_id=?').run(duplicate.id);
        for (const stream of this.store.streams().filter(stream => stream.broadcast_id === duplicate.id))
          this.store.saveStream({ ...stream, broadcast_id: id });
      }
      return this.save({ ...existing, ...metadata, id, first_seen_ms: existing?.first_seen_ms ?? Date.now(), updated_ms: Date.now(),
        sources: [...new Set([...matches.flatMap(item => item.sources), ...candidate.sources])],
        ...(official && candidate.kind === 'youtube' ? {
          kind: official.kind, page_url: official.page_url, title: official.title, agenda: official.agenda,
          committee: official.committee, meeting_round: official.meeting_round, meeting_type: official.meeting_type,
          resolved_kind: official.resolved_kind, media_url: official.media_url,
          scheduled_at: official.scheduled_at || candidate.scheduled_at } : {}),
        suspended: matches.some(item => item.suspended), completed: matches.some(item => item.completed) });
    });
  }
  settings() {
    const row = this.db.prepare("SELECT document FROM automation_settings WHERE id='discovery'").get();
    return row ? JSON.parse(row.document) : { enabled: true };
  }
  setEnabled(enabled) {
    this.db.prepare("INSERT INTO automation_settings VALUES('discovery',?) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
      .run(JSON.stringify({ enabled })); return this.settings();
  }
  suspend(id, value) { const record = this.get(id); if (record) this.save({ ...record, suspended: value }); }
  attach(stream, session) {
    let record = stream.broadcast_id && this.get(stream.broadcast_id);
    if (!record) record = this.upsert({ title: stream.name, page_url: stream.page_url || 'local:' + stream.stream_id,
      sources: stream.page_url ? [stream.page_url] : [], video_id: stream.video_id, kind: stream.kind, phase: 'live' });
    this.db.prepare('INSERT OR IGNORE INTO broadcast_sessions VALUES(?,?)').run(session.session_id, record.id);
    this.save({ ...record, stream_id: stream.stream_id, phase: 'live', capture_from_start: Boolean(stream.capture_from_start),
      beginning_fallback: Boolean(stream.beginning_fallback),
      capture_mode: stream.beginning_fallback ? 'live_edge_fallback' : stream.capture_from_start ? 'beginning_requested' : 'live_edge' });
    return record.id;
  }
  forSession(id) { return typeof id === 'string' ? this.db.prepare('SELECT broadcast_id FROM broadcast_sessions WHERE session_id=?').get(id)?.broadcast_id : undefined; }
  sessions(id) {
    return this.db.prepare('SELECT s.document FROM sessions s JOIN broadcast_sessions b ON b.session_id=s.id WHERE b.broadcast_id=? ORDER BY s.rowid')
      .all(id).map(row => JSON.parse(row.document));
  }
  segments(id) {
    return this.db.prepare('SELECT s.document,s.rowid AS sequence FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id WHERE b.broadcast_id=? ORDER BY s.rowid')
      .all(id).map(row => ({ ...JSON.parse(row.document), sequence: row.sequence }));
  }
  gaps(id) {
    return this.db.prepare("SELECT e.payload FROM events e JOIN broadcast_sessions b ON json_extract(e.payload,'$.session_id')=b.session_id WHERE b.broadcast_id=? AND e.kind='gap' ORDER BY e.id")
      .all(id).map(row => JSON.parse(row.payload));
  }
  saveMinutes(value) {
    this.db.prepare('INSERT INTO minutes VALUES(?,?) ON CONFLICT(broadcast_id) DO UPDATE SET document=excluded.document').run(value.id, JSON.stringify(value));
  }
  revision(id) {
    return this.db.prepare('SELECT count(*) AS total,coalesce(sum(s.version),0) AS version_sum FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id WHERE b.broadcast_id=?').get(id);
  }
  // Revision of the AI-corrected rows only: public summaries are built from these rows and go stale only when they change.
  publishedRevision(id) {
    return this.db.prepare("SELECT count(*) AS total,coalesce(sum(s.version),0) AS version_sum FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id "
      + "WHERE b.broadcast_id=? AND json_extract(s.document,'$.ai_corrected')=1 AND trim(coalesce(json_extract(s.document,'$.corrected_text'),''))<>''").get(id);
  }
  publishedSegments(id) { return this.segments(id).filter(row => row.ai_corrected === true && typeof row.corrected_text === 'string' && row.corrected_text.trim() && publicSpeech(row)); }
  reviewState(key) {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get()) return null;
    const row = this.db.prepare('SELECT document FROM review_state WHERE id=?').get(key); return row ? JSON.parse(row.document) : null;
  }
  participants(id) { return this.reviewState('participants:' + id)?.names ?? {}; }
  finalSpeakers(id) {
    const value = this.reviewState('final-speakers:' + id);
    return value && ['complete', 'partial'].includes(value.phase)
      && [REVIEW_METHOD, REVIEW_METHOD + '-revalidated'].includes(value.method)
      && value.source_guard === finalSourceGuard(this, id) ? value : null;
  }
  structuredCurrent(id, structured) {
    if (!structured) return false;
    if (structured.scope === 'published') return JSON.stringify(structured.revision) === JSON.stringify(this.publishedRevision(id));
    return structured.revision ? JSON.stringify(structured.revision) === JSON.stringify(this.revision(id))
      : structured.source_hash === createHash('sha256').update(JSON.stringify(this.segments(id).map(row => [row.segment_id, row.version]))).digest('hex');
  }
  summary(id) {
    const structured = this.reviewState('structured:' + id);
    if (!structured || structured.scope !== 'published' || !this.structuredCurrent(id, structured)) return null;
    const sources = new Map(structured.sources.map(part => [part.id, part]));
    const titles = new Map((structured.digest?.groups ?? []).map(group => [group.group, group.title]));
    const groups = [];
    structured.notes.forEach((note, group) => {
      const items = (note.summary ?? []).map(fact => {
        const source = sources.get(fact.source_id);
        return { text: fact.text, quote: fact.quote, source_id: fact.source_id, group, segment_id: source?.segment_id ?? null,
          session_id: source?.session_id ?? null, start_ms: Number.isFinite(source?.start_ms) ? source.start_ms : null };
      });
      if (items.length) groups.push({ group, title: titles.get(group) ?? '', items });
    });
    return { method: 'grounded_ai', model: structured.model, updated_ms: structured.updated_ms,
      items: groups.flatMap(group => group.items), groups, digest: structured.digest ?? null };
  }
  minutes(id) {
    const row = this.db.prepare('SELECT document FROM minutes WHERE broadcast_id=?').get(id);
    if (!row) return null;
    const value = JSON.parse(row.document);
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get()) return value;
    const read = key => { const row = this.db.prepare('SELECT document FROM review_state WHERE id=?').get(key + ':' + id); return row ? JSON.parse(row.document) : null; };
    const structured = read('structured'); const manual = read('manual');
    const current = this.structuredCurrent(id, structured);
    return { ...value, structured: structured ? { ...structured, stale: !current } : null, manual,
      method: manual?.markdown ? 'manual_review' : current ? 'grounded_ai' : value.method,
      updated_ms: Math.max(value.updated_ms, structured?.updated_ms ?? 0, manual?.updated_ms ?? 0, this.reviewState('final-speakers:' + id)?.updated_ms ?? 0),
      markdown: manual?.markdown || (current && !this.finalSpeakers(id) ? structured.markdown : value.markdown) };
  }
  minuteList() {
    const reviewExists = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get());
    return this.db.prepare("SELECT broadcast_id AS id,json_extract(document,'$.title') AS title,json_extract(document,'$.scheduled_at') AS scheduled_at,"
      + "json_extract(document,'$.status') AS status,json_extract(document,'$.updated_ms') AS updated_ms,json_extract(document,'$.segment_count') AS segment_count,"
      + "json_extract(document,'$.session_count') AS session_count FROM minutes ORDER BY rowid DESC").all().map(value => {
      if (reviewExists) {
        const updated = this.db.prepare("SELECT max(json_extract(document,'$.updated_ms')) AS time FROM review_state WHERE id IN (?,?)")
          .get('structured:' + value.id, 'manual:' + value.id).time;
        value.updated_ms = Math.max(value.updated_ms, updated ?? 0);
      }
      return { id: value.id, title: value.title, scheduled_at: value.scheduled_at, status: value.status,
        updated_ms: value.updated_ms, segment_count: value.segment_count, session_count: value.session_count };
    });
  }
}
