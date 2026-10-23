export class RecoveryQueue {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_recovery_jobs(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, document TEXT NOT NULL, pcm BLOB NOT NULL)`);
  }
  key(job) { return JSON.stringify([job.session_id, job.epoch, job.start_ms, job.end_ms]); }
  put(job) {
    const { pcm, ...metadata } = job;
    this.db.prepare('INSERT INTO live_recovery_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
      .run(this.key(job), job.session_id, JSON.stringify(metadata), pcm);
    return metadata;
  }
  load(job) {
    const row = this.db.prepare('SELECT pcm FROM live_recovery_jobs WHERE id=?').get(this.key(job));
    if (!row) throw new Error('Recovery audio missing');
    return { ...job, pcm: Buffer.from(row.pcm) };
  }
  complete(job) {
    if (!job.partial) this.db.prepare('DELETE FROM live_recovery_jobs WHERE id=?').run(this.key(job));
  }
  hasSegment(job) {
    return !!this.db.prepare(`SELECT 1 FROM segments WHERE session_id=? AND start_ms=?
      AND json_extract(document,'$.timeline_epoch')=? AND json_extract(document,'$.end_ms')=? LIMIT 1`)
      .get(job.session_id, job.start_ms, job.epoch, job.end_ms);
  }
  restore() {
    return this.db.prepare(`SELECT j.document, s.document AS session FROM live_recovery_jobs j
      JOIN sessions s ON s.id=j.session_id ORDER BY j.rowid`).all()
      .map(row => ({ job: JSON.parse(row.document), session: JSON.parse(row.session) }));
  }
}
