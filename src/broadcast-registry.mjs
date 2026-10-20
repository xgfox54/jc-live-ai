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
    return this.db.prepare('SELECT s.document FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id WHERE b.broadcast_id=? ORDER BY s.rowid')
      .all(id).map(row => JSON.parse(row.document));
  }
  gaps(id) {
    return this.db.prepare("SELECT e.payload FROM events e JOIN broadcast_sessions b ON json_extract(e.payload,'$.session_id')=b.session_id WHERE b.broadcast_id=? AND e.kind='gap' ORDER BY e.id")
      .all(id).map(row => JSON.parse(row.payload));
  }
  saveMinutes(value) {
    this.db.prepare('INSERT INTO minutes VALUES(?,?) ON CONFLICT(broadcast_id) DO UPDATE SET document=excluded.document').run(value.id, JSON.stringify(value));
  }
  minutes(id) { const row = this.db.prepare('SELECT document FROM minutes WHERE broadcast_id=?').get(id); return row ? JSON.parse(row.document) : null; }
  minuteList() {
    return this.db.prepare('SELECT document FROM minutes ORDER BY rowid DESC').all().map(row => {
      const value = JSON.parse(row.document);
      return { id: value.id, title: value.title, scheduled_at: value.scheduled_at, status: value.status,
        updated_ms: value.updated_ms, segment_count: value.segment_count, session_count: value.session_count };
    });
  }
}
