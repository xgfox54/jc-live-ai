import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError } from './validate.mjs';

export class Store extends EventEmitter {
  constructor(path) {
    super(); this.setMaxListeners(0); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, stream_id TEXT NOT NULL,
        version INTEGER NOT NULL, start_ms REAL NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS segment_session ON segments(session_id,start_ms);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id TEXT NOT NULL,
        kind TEXT NOT NULL, created_ms INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, created_ms INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corrections(id INTEGER PRIMARY KEY, segment_id TEXT NOT NULL,
        version INTEGER NOT NULL, document TEXT NOT NULL);`);
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
      }
    }
  }
  segment(segment) {
    const document = { ...segment, segment_id: randomUUID(), version: 1, corrected_text: null, status: 'final', speaker_id: null };
    const event = this.transaction(() => {
      this.db.prepare('INSERT INTO segments VALUES(?,?,?,?,?,?)').run(document.segment_id,
        document.session_id, document.stream_id, 1, document.start_ms, JSON.stringify(document));
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
      const updated = { ...segment, corrected_text: change.text, version: segment.version + 1 };
      this.db.prepare('INSERT INTO corrections(segment_id,version,document) VALUES(?,?,?)')
        .run(id, updated.version, JSON.stringify({ ...change, created_ms: Date.now() }));
      this.db.prepare('UPDATE segments SET version=?,document=? WHERE id=?').run(updated.version, JSON.stringify(updated), id);
      this.audit({ action: 'segment.correct', segment_id: id, version: updated.version });
      return this.writeEvent('segment', updated);
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
    const rows = this.db.prepare(`SELECT rowid,document FROM segments WHERE stream_id=?
      AND rowid<? AND (?='' OR session_id=?) ${broadcastFilter} ORDER BY rowid DESC LIMIT ?`)
      .all(query.stream, query.before ?? Number.MAX_SAFE_INTEGER, query.session ?? '', query.session ?? '',
        ...(query.broadcast ? [query.broadcast] : []), query.limit ?? 100);
    return { items: rows.map(r => JSON.parse(r.document)).reverse(), before: rows.at(-1)?.rowid ?? null };
  }
  snapshot(ids, broadcasts = {}) {
    const pages = ids.map(stream => ({ stream, ...this.segments({ stream, broadcast: broadcasts[stream] }) }));
    const gaps = ids.flatMap(stream => {
      const row = this.db.prepare("SELECT payload FROM events WHERE stream_id=? AND kind='gap' ORDER BY id DESC LIMIT 1").get(stream);
      return row ? [JSON.parse(row.payload)] : [];
    });
    return { event_id: this.cursor(), streams: this.streams().filter(s => ids.includes(s.stream_id)),
      segments: pages.flatMap(page => page.items), gaps,
      before: Object.fromEntries(pages.map(page => [page.stream, page.before])) };
  }
  close() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
