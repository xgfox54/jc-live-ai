import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError } from './validate.mjs';

export class Store extends EventEmitter {
  constructor(path, { readOnly = false } = {}) {
    super(); this.setMaxListeners(0); this.readOnly = readOnly; this.db = new DatabaseSync(path, { readOnly });
    if (readOnly) { this.db.exec('PRAGMA busy_timeout=5000'); return; }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, stream_id TEXT NOT NULL,
        version INTEGER NOT NULL, start_ms REAL NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS segment_session ON segments(session_id,start_ms);
      CREATE INDEX IF NOT EXISTS segment_delivery ON segments(session_id,json_extract(document,'$.ai_corrected'),start_ms);
      CREATE TABLE IF NOT EXISTS recognition_suppressed(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,
        start_ms REAL NOT NULL,end_ms REAL NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id TEXT NOT NULL,
        kind TEXT NOT NULL, created_ms INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, created_ms INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corrections(id INTEGER PRIMARY KEY, segment_id TEXT NOT NULL,
        version INTEGER NOT NULL, document TEXT NOT NULL);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS correction_origin ON corrections(segment_id,json_extract(document,'$.origin'));
      UPDATE segments SET document=json_set(document,'$.ai_corrected',json(CASE WHEN EXISTS
        (SELECT 1 FROM corrections c WHERE c.segment_id=segments.id AND json_extract(c.document,'$.origin')='ai')
        THEN 'true' ELSE 'false' END)) WHERE json_type(document,'$.ai_corrected') IS NULL;
      UPDATE events SET payload=json_set(payload,'$.ai_corrected',json('true')) WHERE kind='segment'
        AND json_type(payload,'$.ai_corrected') IS NULL AND EXISTS
        (SELECT 1 FROM corrections c WHERE c.segment_id=json_extract(events.payload,'$.segment_id')
          AND c.version<=json_extract(events.payload,'$.version') AND json_extract(c.document,'$.origin')='ai');`);
    this.db.exec("CREATE INDEX IF NOT EXISTS segment_published_stream ON segments(stream_id) WHERE json_extract(document,'$.ai_corrected')=1 "
      + "AND trim(coalesce(json_extract(document,'$.corrected_text'),''))<>'';");
    this.db.exec("CREATE INDEX IF NOT EXISTS segment_live_preview ON segments(stream_id,json_extract(document,'$.preview_updated_ms')) WHERE json_extract(document,'$.live_preview')=1");
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  writeEvent(kind, payload) {
    const created_ms = Date.now();
    const result = this.db.prepare('INSERT INTO events(stream_id,kind,created_ms,payload) VALUES(?,?,?,?)')
      .run(payload.stream_id, kind, created_ms, JSON.stringify(payload));
    return { event_id: Number(result.lastInsertRowid), kind, created_ms, payload };
  }
  event(kind, payload) {
    const event = this.transaction(() => this.writeEvent(kind, payload));
    this.emit('event', event); return event;
  }
  streams() { return this.db.prepare('SELECT document FROM streams ORDER BY id').all().map(r => JSON.parse(r.document)); }
  states() {
    return this.db.prepare('SELECT document FROM sessions WHERE rowid IN (SELECT MAX(rowid) FROM sessions GROUP BY stream_id)')
      .all().map(row => JSON.parse(row.document));
  }
  saveStream(stream) {
    this.db.prepare('INSERT INTO streams VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
      .run(stream.stream_id, JSON.stringify(stream));
    this.audit({ action: 'stream.register', stream_id: stream.stream_id });
  }
  audit(document) { this.db.prepare('INSERT INTO audit(created_ms,document) VALUES(?,?)').run(Date.now(), JSON.stringify(document)); }
  saveSession(session) {
    const event = this.transaction(() => {
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
        .run(session.session_id, session.stream_id, JSON.stringify(session));
      return this.writeEvent('session', session);
    });
    this.emit('event', event); return event;
  }
  recover() {
    for (const row of this.db.prepare('SELECT document FROM sessions').all()) {
      const session = JSON.parse(row.document);
      if (['running', 'draining', 'reconnecting', 'degraded'].includes(session.state)) {
        this.saveSession({ ...session, state: 'interrupted', ended_ms: Date.now() });
        this.event('gap', { stream_id: session.stream_id, session_id: session.session_id,
          reason: 'process_restart', extent: 'unknown', timeline_epoch: session.timeline_epoch });
        for (const row of this.db.prepare("SELECT document FROM segments WHERE session_id=? AND json_extract(document,'$.speaker_state')='pending'").all(session.session_id)) {
          const segment = JSON.parse(row.document);
          this.annotateSpeakers(segment.segment_id, { speaker_scope: segment.speaker_scope, speaker_id: null,
            speaker_state: 'unavailable', speaker_turns: [], speaker_method: 'nemotron-streaming' });
        }
      }
    }
  }
  segment(segment, checkpoint = () => {}) {
    const document = { ...segment, segment_id: randomUUID(), version: 1, corrected_text: null, ai_corrected: false, status: 'final', speaker_id: segment.speaker_id ?? null };
    const event = this.transaction(() => {
      this.db.prepare('INSERT INTO segments VALUES(?,?,?,?,?,?)').run(document.segment_id,
        document.session_id, document.stream_id, 1, document.start_ms, JSON.stringify(document));
      checkpoint();
      return this.writeEvent('segment', document);
    });
    this.emit('event', event); return document;
  }
  correct(id, change) {
    const event = this.transaction(() => {
      const row = this.db.prepare('SELECT document FROM segments WHERE id=?').get(id);
      if (!row) throw new HttpError(404, 'Segment not found');
      const segment = JSON.parse(row.document);
      if (segment.version !== change.version) throw new HttpError(409, 'Version conflict');
      const updated = { ...segment, corrected_text: change.text, ai_corrected: change.origin === 'ai' || segment.ai_corrected === true, version: segment.version + 1,
        ...(segment.live_preview ? { preview_updated_ms: Date.now() } : {}) };
      this.db.prepare('INSERT INTO corrections(segment_id,version,document) VALUES(?,?,?)')
        .run(id, updated.version, JSON.stringify({ ...change, created_ms: Date.now() }));
      this.db.prepare('UPDATE segments SET version=?,document=? WHERE id=?').run(updated.version, JSON.stringify(updated), id);
      this.audit({ action: 'segment.correct', segment_id: id, version: updated.version });
      return this.writeEvent('segment', updated);
    });
    this.emit('event', event); return event.payload;
  }
  annotateSpeakers(id, annotation) {
    const row = this.db.prepare('SELECT document FROM segments WHERE id=?').get(id);
    if (!row) return;
    const current = JSON.parse(row.document);
    if (current.speaker_method === 'manual' || current.speaker_scope !== annotation.speaker_scope) return;
    if (!['pending', 'assigned', 'multiple', 'unknown', 'unavailable'].includes(annotation.speaker_state)
      || (annotation.speaker_id !== null && (!Number.isInteger(annotation.speaker_id) || annotation.speaker_id < 1 || annotation.speaker_id > 8)))
      throw new HttpError(400, 'Invalid speaker annotation');
    const { speaker_scope, speaker_id, speaker_state, speaker_turns, speaker_method, speaker_timestamp_quality } = annotation;
    const updated = { ...current, speaker_scope, speaker_id, speaker_state, speaker_turns, speaker_method,
      speaker_timestamp_quality, speaker_ready_ms: Date.now(),
      speaker_latency_ms: Date.now() - (current.audio_received_ms ?? Date.now()) + current.end_ms - current.start_ms,
      version: current.version + 1 };
    const event = this.transaction(() => {
      this.db.prepare('UPDATE segments SET version=?,document=? WHERE id=?').run(updated.version, JSON.stringify(updated), id);
      return this.writeEvent('segment', updated);
    });
    this.emit('event', event); return updated;
  }
  speaker(id, version, speaker, method = 'manual') {
    if (speaker !== null && (!Number.isInteger(speaker) || speaker < 1 || speaker > 8)) throw new HttpError(400, '참여자 번호는 1~8입니다.');
    const event = this.transaction(() => {
      const row = this.db.prepare('SELECT document FROM segments WHERE id=?').get(id);
      if (!row) throw new HttpError(404, '문장을 찾지 못했습니다.');
      const segment = JSON.parse(row.document);
      if (segment.version !== version) throw new HttpError(409, '문장이 변경되었습니다. 다시 열어 주세요.');
      const value = { ...segment, speaker_id: speaker, speaker_method: method,
        speaker_state: speaker === null ? 'unknown' : 'assigned', speaker_turns: [], version: version + 1 };
      this.db.prepare('UPDATE segments SET version=?,document=? WHERE id=?').run(value.version, JSON.stringify(value), id);
      this.audit({ action: 'segment.speaker', segment_id: id, previous_speaker: segment.speaker_id, speaker_id: speaker, method });
      return this.writeEvent('segment', value);
    });
    this.emit('event', event); return event.payload;
  }
  cursor() { return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id; }
  events(after, limit = 2001) {
    return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
      .map(r => ({ event_id: r.id, kind: r.kind, created_ms: r.created_ms, payload: JSON.parse(r.payload) }));
  }
  segments(query) {
    const broadcastFilter = query.broadcast ? 'AND session_id IN (SELECT session_id FROM broadcast_sessions WHERE broadcast_id=?)' : '';
    const publishedFilter = query.published ? "AND json_extract(document,'$.ai_corrected')=1 AND trim(coalesce(json_extract(document,'$.corrected_text'),''))<>''" : '';
    const rawSearch = query.published ? "''" : "json_extract(document,'$.raw_text')";
    const rows = this.db.prepare(`SELECT rowid,document FROM segments WHERE stream_id=?
      AND rowid<? AND (?='' OR session_id=?) ${broadcastFilter} ${publishedFilter}
      AND (?='' OR instr(lower(${rawSearch}),lower(?))>0 OR instr(lower(coalesce(json_extract(document,'$.corrected_text'),'')),lower(?))>0)
      ORDER BY rowid DESC LIMIT ?`)
      .all(query.stream, query.before ?? Number.MAX_SAFE_INTEGER, query.session ?? '', query.session ?? '',
        ...(query.broadcast ? [query.broadcast] : []), query.q ?? '', query.q ?? '', query.q ?? '', query.limit ?? 100);
    return { items: rows.map(r => ({ ...JSON.parse(r.document), sequence: r.rowid })).reverse(), before: rows.at(-1)?.rowid ?? null };
  }
  liveSegments(stream, broadcast) {
    return this.db.prepare(`SELECT rowid,document FROM segments WHERE stream_id=? AND json_extract(document,'$.live_preview')=1
      ${broadcast ? 'AND session_id IN (SELECT session_id FROM broadcast_sessions WHERE broadcast_id=?)' : ''}
      ORDER BY json_extract(document,'$.preview_updated_ms') DESC,rowid DESC LIMIT 200`)
      .all(stream, ...(broadcast ? [broadcast] : [])).map(row => ({ ...JSON.parse(row.document), sequence: row.rowid }));
  }
  snapshot(ids, broadcasts = {}, published = false) {
    const pages = ids.map(stream => ({ stream, ...this.segments({ stream, broadcast: broadcasts[stream], published }) }));
    const gaps = ids.flatMap(stream => {
      const row = this.db.prepare("SELECT payload FROM events WHERE stream_id=? AND kind='gap' ORDER BY id DESC LIMIT 1").get(stream);
      return row ? [JSON.parse(row.payload)] : [];
    });
    return { event_id: this.cursor(), streams: this.streams().filter(s => ids.includes(s.stream_id)),
      segments: pages.flatMap(page => page.items), gaps,
      before: Object.fromEntries(pages.map(page => [page.stream, page.before])) };
  }
  close() { if (!this.readOnly) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
