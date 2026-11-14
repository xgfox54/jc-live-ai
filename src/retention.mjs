import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { CHANNEL_IDS } from '../public/committees.mjs';

const DAY = 86_400_000;
const ACTIVE = ['running', 'draining', 'degraded', 'reconnecting'];
const pause = () => new Promise(resolve => setImmediate(resolve));
const size = path => {
  const stat = statSync(path);
  return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + size(resolve(path, name)), 0) : stat.size;
};
// Operating data older than the retention period (config.retentionDays, 21 days by default) is removed once a day:
// event log rows other than gap records, AI correction candidates that no longer decide anything, earlier speaker review
// versions, voice features and recordings of sessions that ended before the cutoff, and backup files (the newest backup
// always stays). Kept at any age: transcripts, corrections, minutes, summaries, final speaker results, gap records (the
// minutes and the speaker review source check read them) and everything of a session still collecting.
export class Retention {
  constructor({ store, registry, config = {}, now = Date.now }) {
    Object.assign(this, { store, registry, config, now }); this.db = store.db; this.last = null; this.pending = null;
    this.days = config.retentionDays ?? 21;
    if (!Number.isInteger(this.days) || this.days < 7 || this.days > 365) throw new Error('Invalid retention days');
  }
  start() {
    if (this.timer || this.closed) return;
    this.first = setTimeout(() => this.run().catch(() => {}), 120_000); this.first.unref();
    this.timer = setInterval(() => this.run().catch(() => {}), DAY); this.timer.unref();
  }
  view() { return { days: this.days, last: this.last }; }
  run() {
    if (this.closed) return Promise.resolve(null);
    this.pending ??= this.purge().catch(error => {
      this.last = { ran_ms: this.now(), error: error.message };
      process.stderr.write(JSON.stringify({ level: 'error', event: 'retention.failure', error: error.message }) + '\n');
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async purge() {
    const now = this.now(); const cutoff = now - this.days * DAY;
    const sessions = this.db.prepare('SELECT s.document, b.broadcast_id FROM sessions s LEFT JOIN broadcast_sessions b ON b.session_id=s.id').all()
      .map(row => ({ ...JSON.parse(row.document), broadcast_id: row.broadcast_id }));
    const endedAt = session => session.ended_ms ?? session.last_receive_ms ?? session.started_ms ?? 0;
    const old = sessions.filter(session => !ACTIVE.includes(session.state) && endedAt(session) < cutoff);
    const result = { ran_ms: now, cutoff_ms: cutoff, events: 0, candidates: 0, review_history: 0, voice_features: 0,
      recordings: 0, recording_bytes: 0, backups: 0, backup_bytes: 0, phases: 0 };
    // Events are appended in time order, so the rows to remove lie below one event id.
    const last = this.db.prepare('SELECT max(id) AS id FROM events WHERE created_ms < ?').get(cutoff).id ?? 0;
    for (let changes = 1; changes;) {
      changes = this.db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE id <= ? AND created_ms < ? AND kind <> 'gap' LIMIT 5000)")
        .run(last, cutoff).changes;
      result.events += changes; await pause();
    }
    // A candidate still decides something only while it holds the current version of an uncorrected sentence: it stops a
    // second correction of that sentence or waits for an administrator.
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_candidates'").get()) {
      const ids = this.db.prepare("SELECT c.rowid AS id FROM ai_candidates c LEFT JOIN segments s ON s.id=c.segment_id "
        + "WHERE json_extract(c.document,'$.created_ms') < ? AND (s.id IS NULL OR s.version<>c.source_version "
        + "OR json_extract(c.document,'$.status')='applied' OR json_extract(s.document,'$.corrected_text') IS NOT NULL)").all(cutoff).map(row => row.id);
      for (let index = 0; index < ids.length; index += 500) {
        const part = ids.slice(index, index + 500);
        result.candidates += this.db.prepare('DELETE FROM ai_candidates WHERE rowid IN (' + part.map(() => '?').join(',') + ')').run(...part).changes;
        await pause();
      }
    }
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get()) {
      result.review_history = this.db.prepare("DELETE FROM review_state WHERE id LIKE 'final-speakers-history:%' AND json_extract(document,'$.updated_ms') < ?")
        .run(cutoff).changes;
      const broadcasts = new Set(old.map(session => session.broadcast_id).filter(Boolean));
      for (const id of broadcasts) {
        if (sessions.some(session => session.broadcast_id === id && !old.includes(session))) continue;
        result.voice_features += this.db.prepare('DELETE FROM review_state WHERE id=?').run('speaker-acoustics:' + id).changes;
      }
    }
    const recordings = resolve(this.config.recordings ?? 'data/recordings');
    for (const session of old) {
      if (!CHANNEL_IDS.includes(session.stream_id) || !/^[A-Za-z0-9_-]{1,80}$/.test(session.session_id ?? '')) continue;
      const directory = resolve(recordings, session.stream_id, session.session_id);
      if (!directory.startsWith(recordings + sep) || !existsSync(directory)) continue;
      result.recording_bytes += size(directory); rmSync(directory, { recursive: true, force: true }); result.recordings++;
    }
    const backups = resolve(this.config.backupDirectory ?? 'data/backups');
    if (existsSync(backups)) {
      const entries = readdirSync(backups, { withFileTypes: true }).map(entry => ({ entry, path: resolve(backups, entry.name), time: statSync(resolve(backups, entry.name)).mtimeMs }));
      const newest = entries.filter(item => item.entry.isFile()).sort((a, b) => b.time - a.time)[0];
      for (const item of entries) {
        if (item === newest || item.time >= cutoff) continue;
        result.backup_bytes += size(item.path); rmSync(item.path, { recursive: true, force: true }); result.backups++;
      }
    }
    // A broadcast that is no longer collected keeps the phase of its last check; one day after its last audio, a suspended,
    // completed or test record that still says live is closed.
    for (const record of this.registry.list()) {
      if (record.phase !== 'live' || !(record.suspended || record.completed || record.test_run)) continue;
      const own = sessions.filter(session => session.broadcast_id === record.id);
      if (own.some(session => ACTIVE.includes(session.state))) continue;
      if (now - Math.max(record.updated_ms ?? 0, ...own.map(endedAt)) < DAY) continue;
      this.registry.save({ ...record, phase: 'ended' }); result.phases++;
    }
    this.store.audit?.({ action: 'retention.run', ...result });
    this.last = result; return result;
  }
  async close() { this.closed = true; clearTimeout(this.first); clearInterval(this.timer); await this.pending?.catch(() => {}); }
}
