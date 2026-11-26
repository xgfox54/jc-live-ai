import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { BroadcastMonitor } from '../src/broadcast-monitor.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { soundLevel, WATCH_MS } from '../src/recess-watch.mjs';
import { buildMinutes } from '../src/minutes.mjs';

const tone = (amplitude, bytes = 64000) => { const pcm = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * amplitude), i); return pcm; };
test('the recess floor is quiet and speech-level audio is sound; a single click is not', () => {
  assert.equal(soundLevel(tone(3)).sound, false);
  assert.equal(soundLevel(tone(3000)).sound, true);
  const click = tone(3); tone(20000, 640).copy(click, 32000);
  assert.equal(soundLevel(click).sound, false); assert.ok(soundLevel(click).loudest_dbfs > -10);
});

const key = 'youtube:abcdefghijk';
const kst = text => Date.parse(text + '+09:00');
function fixture(t) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const record = registry.upsert({ title: '2차 교육위원회', page_url: 'https://www.youtube.com/watch?v=abcdefghijk', video_id: 'abcdefghijk',
    sources: ['https://www.youtube.com/watch?v=abcdefghijk'], kind: 'youtube', committee: '교육위원회', meeting_round: '제456회(2차)', scheduled_at: '2026-11-24 10:00' });
  const stream = { stream_id: 'ch8', kind: 'youtube', name: '교육위원회', approved: true, auto_start: true, auto_discovered: true,
    page_url: 'https://www.youtube.com/watch?v=abcdefghijk', video_id: 'abcdefghijk', broadcast_id: record.id };
  store.saveStream(stream);
  const engine = { ready: true, metadata: {}, stop: async () => {}, transcribe: async () => ({ spans: [{ text: '' }], inference_ms: 0 }) };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 4, silenceRms: 0, recordAudio: false });
  const runs = new Map(); const sources = [];
  const inputs = {
    isActive: id => runs.has(id),
    startYouTube(source) {
      sources.push(source);
      return new Promise(resolve => runs.set(source.stream_id, reason => { runs.delete(source.stream_id); scheduler.stop(source.stream_id, reason); resolve(); }));
    },
    async stop(id, reason) { runs.get(id)?.(reason); await immediate(); }
  };
  const levels = []; let now = kst('2026-11-24T22:10:00');
  const minutes = { attach: (item, state) => registry.attach(item, state) };
  const monitor = new BroadcastMonitor({ store, scheduler, config: {}, inputs, registry, minutes, now: () => now,
    probe: async current => ({ phase: 'live', key, source: current }), listen: async () => levels.shift() ?? { sound: false } });
  t.after(async () => { await monitor.close(); for (const id of runs.keys()) await inputs.stop(id); await scheduler.close(); store.close(); });
  const tick = async (ms = WATCH_MS) => { now += ms; await monitor.check(store.streams().find(item => item.stream_id === 'ch8')); await immediate(); };
  return { store, registry, record, scheduler, monitor, sources, levels, tick, stream: () => store.streams().find(item => item.stream_id === 'ch8'),
    at: text => { now = kst(text); }, now: () => now };
}

test('closing a collection in a recess completes the record, keeps the broadcast from being collected again and watches it', async t => {
  const f = fixture(t);
  await f.tick(0); assert.equal(f.sources.length, 1);
  const closed = await f.monitor.closeCollection(f.stream(), '12:04 정회 선포 뒤 22:10까지 속개 발언이 없어 이날 수집을 마감했습니다.');
  assert.equal(f.scheduler.channel('ch8').state, 'stopped'); assert.equal(f.scheduler.channel('ch8').input_end_reason, 'eof');
  assert.equal(closed.auto_completed_key, key); assert.equal(closed.recess_watch.key, key);
  const record = f.registry.get(f.record.id); assert.equal(record.completed, true); assert.match(record.close_note, /수집을 마감/);
  // The broadcast stays on air in silence: nothing is collected again.
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.sources.length, 1); assert.equal(f.monitor.states()[0].phase, 'watching');
  const value = buildMinutes({ ...f.registry.get(f.record.id), display_title: '교육위원회 제2차 회의' }, f.registry.sessions(f.record.id), [], []);
  assert.equal(value.title, '교육위원회 제2차 회의'); assert.ok(value.warnings.includes('12:04 정회 선포 뒤 22:10까지 속개 발언이 없어 이날 수집을 마감했습니다.'));
});

test('sound in two samples in a row resumes the same record on the same day, read back from the last silent sample', async t => {
  const f = fixture(t);
  await f.tick(0); await f.monitor.closeCollection(f.stream(), '12:04 정회 선포 뒤 22:10까지 속개 발언이 없어 이날 수집을 마감했습니다.');
  await f.tick(); const quiet = f.now();
  f.levels.push({ sound: true }); await f.tick(); assert.equal(f.sources.length, 1);
  f.levels.push({ sound: true }); await f.tick();
  assert.equal(f.sources.length, 2); assert.equal(f.sources[1].resume_after_ms, quiet); assert.equal(f.sources[1].beginning_fallback, true);
  assert.equal(f.stream().broadcast_id, f.record.id); assert.equal(f.stream().recess_watch, null); assert.equal(f.registry.get(f.record.id).completed, false);
  assert.equal(f.registry.sessions(f.record.id).length, 2);
  assert.equal(f.registry.get(f.record.id).close_note, '12:04 정회 선포 뒤 22:10까지 속개 발언이 없어 이날 수집을 마감했습니다. 22:19부터 방송 소리가 다시 들려 수집을 이어 갔습니다.');
});

test('a resumption on the next day goes to a part record; both days get part titles and discovery does not merge them', async t => {
  const f = fixture(t);
  f.registry.save({ ...f.registry.get(f.record.id), display_title: '교육위원회 제2차 회의' });
  await f.tick(0); await f.monitor.closeCollection(f.stream());
  f.at('2026-11-25T09:50:00');
  f.levels.push({ sound: true }, { sound: true }); await f.tick(); await f.tick();
  assert.equal(f.sources.length, 2);
  const part = f.registry.get(f.stream().broadcast_id);
  assert.notEqual(part.id, f.record.id); assert.equal(part.continuation_of, f.record.id); assert.equal(part.part_date, '2026-11-25');
  assert.equal(part.display_title, '교육위원회 제2차 회의 (2/2)'); assert.equal(part.scheduled_at, '2026-11-25 09:56');
  assert.equal(f.registry.get(f.record.id).display_title, '교육위원회 제2차 회의 (1/2)'); assert.equal(f.registry.get(f.record.id).completed, true);
  assert.equal(f.registry.sessions(part.id).length, 1); assert.equal(f.registry.sessions(f.record.id).length, 1);
  // Discovery keeps updating the first day's record by its video without touching the part.
  f.registry.upsert({ title: '2차 교육위원회', page_url: 'https://www.youtube.com/watch?v=abcdefghijk', video_id: 'abcdefghijk',
    sources: ['https://www.youtube.com/watch?v=abcdefghijk'], kind: 'youtube' });
  assert.ok(f.registry.get(part.id)); assert.equal(f.registry.get(f.record.id).display_title, '교육위원회 제2차 회의 (1/2)');
});

test('the watch ends when the broadcast ends, and a failed sample changes nothing', async t => {
  const f = fixture(t);
  await f.tick(0); await f.monitor.closeCollection(f.stream());
  f.monitor.listen = async () => { throw new Error('sample failed'); };
  await f.tick(); await f.tick(); assert.equal(f.sources.length, 1); assert.ok(f.stream().recess_watch);
  f.monitor.probe = async current => ({ phase: 'ended', key, source: current });
  await f.tick(); assert.equal(f.stream().recess_watch, null);
});
