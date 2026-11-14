import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { Retention } from '../src/retention.mjs';

const DAY = 86_400_000;
test('data past the 21-day retention is removed; minutes inputs, recent and collecting data stay', async t => {
  // Given a meeting that ended 25 days ago, one that ended 2 days ago and one still collecting
  const dir = mkdtempSync(join(tmpdir(), 'jc-retention-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { recordings: join(dir, 'rec'), backupDirectory: join(dir, 'backups') };
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store); t.after(() => store.close());
  store.db.exec('CREATE TABLE review_state(id TEXT PRIMARY KEY,document TEXT NOT NULL);'
    + 'CREATE TABLE ai_candidates(id TEXT PRIMARY KEY, broadcast_id TEXT NOT NULL, segment_id TEXT NOT NULL, source_version INTEGER NOT NULL, context TEXT NOT NULL, document TEXT NOT NULL);');
  const now = Date.now(); const ago = days => now - days * DAY;
  const meeting = (n, stream, session, state, ended) => {
    const page_url = 'https://www.youtube.com/watch?v=' + String(n).padStart(11, '0');
    const record = registry.upsert({ video_id: String(n).padStart(11, '0'), page_url, title: '회의 ' + n, sources: [page_url], kind: 'youtube' });
    registry.attach({ stream_id: stream, broadcast_id: record.id, page_url }, { session_id: session });
    store.saveSession({ session_id: session, stream_id: stream, state, started_ms: ago(30), ended_ms: ended, queue_length: 0 });
    mkdirSync(join(config.recordings, stream, session), { recursive: true }); writeFileSync(join(config.recordings, stream, session, 'audio.pcm'), Buffer.alloc(64));
    return registry.get(record.id);
  };
  const old = meeting(1, 'ch1', 'old', 'stopped', ago(25)); const recent = meeting(2, 'ch2', 'recent', 'stopped', ago(2));
  meeting(3, 'ch3', 'collecting', 'running', null);
  registry.save({ ...registry.get(old.id), suspended: true, updated_ms: ago(25) });
  const event = (kind, created) => store.db.prepare('INSERT INTO events(stream_id,kind,created_ms,payload) VALUES(?,?,?,?)')
    .run('ch1', kind, created, JSON.stringify({ stream_id: 'ch1', session_id: 'old' }));
  event('segment', ago(25)); event('gap', ago(25)); event('segment', ago(1));
  const corrected = store.segment({ session_id: 'old', stream_id: 'ch1', start_ms: 0, end_ms: 5000, raw_text: '보정된 발언' });
  store.correct(corrected.segment_id, { version: 1, text: '보정된 발언입니다.', origin: 'ai' });
  const waiting = store.segment({ session_id: 'old', stream_id: 'ch1', start_ms: 5000, end_ms: 10000, raw_text: '보류된 발언' });
  const candidate = (id, segment, version, status, created) => store.db.prepare('INSERT INTO ai_candidates VALUES(?,?,?,?,?,?)')
    .run(id, old.id, segment, version, 'context', JSON.stringify({ id, status, created_ms: created }));
  candidate('applied-old', corrected.segment_id, 1, 'applied', ago(25));
  candidate('held-old', waiting.segment_id, waiting.version, 'rejected', ago(25));
  candidate('stale-old', waiting.segment_id, waiting.version - 1, 'pending', ago(25));
  candidate('applied-new', corrected.segment_id, 1, 'applied', ago(1));
  const state = (id, updated) => store.db.prepare('INSERT INTO review_state VALUES(?,?)').run(id, JSON.stringify({ updated_ms: updated }));
  state('final-speakers-history:' + old.id + ':1', ago(25)); state('final-speakers-history:' + recent.id + ':1', ago(1));
  state('speaker-acoustics:' + old.id, ago(25)); state('speaker-acoustics:' + recent.id, ago(1)); state('final-speakers:' + old.id, ago(25));
  mkdirSync(join(config.backupDirectory, 'before-repair'), { recursive: true });
  for (const [name, days] of [['old-1.sqlite', 25], ['old-2.sqlite', 24], ['newest.sqlite', 23]]) {
    writeFileSync(join(config.backupDirectory, name), 'backup'); utimesSync(join(config.backupDirectory, name), ago(days) / 1000, ago(days) / 1000);
  }
  utimesSync(join(config.backupDirectory, 'before-repair'), ago(30) / 1000, ago(30) / 1000);
  // When the daily run passes
  const result = await new Retention({ store, registry, config, now: () => now }).run();
  // Then only the expired data is gone
  assert.deepEqual(store.db.prepare('SELECT kind FROM events WHERE created_ms < ?').all(ago(21)).map(row => row.kind), ['gap']);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='segment' AND created_ms=?").get(ago(1)).n, 1);
  assert.deepEqual(store.db.prepare('SELECT id FROM ai_candidates ORDER BY id').all().map(row => row.id), ['applied-new', 'held-old']);
  assert.deepEqual(store.db.prepare('SELECT id FROM review_state ORDER BY id').all().map(row => row.id.split(':').slice(0, 2).join(':')).sort(),
    ['final-speakers-history:' + recent.id, 'final-speakers:' + old.id, 'speaker-acoustics:' + recent.id].sort());
  assert.equal(existsSync(join(config.recordings, 'ch1', 'old')), false);
  assert.equal(existsSync(join(config.recordings, 'ch2', 'recent')), true); assert.equal(existsSync(join(config.recordings, 'ch3', 'collecting')), true);
  assert.equal(existsSync(join(config.backupDirectory, 'newest.sqlite')), true);
  assert.equal(existsSync(join(config.backupDirectory, 'old-1.sqlite')) || existsSync(join(config.backupDirectory, 'before-repair')), false);
  assert.equal(registry.get(old.id).phase, 'ended'); assert.equal(registry.get(recent.id).phase, 'live');
  assert.equal(store.segments({ stream: 'ch1' }).items.length, 2);
  assert.deepEqual([result.events, result.candidates, result.review_history, result.voice_features, result.recordings, result.backups, result.phases], [1, 2, 1, 1, 1, 3, 1]);
});
