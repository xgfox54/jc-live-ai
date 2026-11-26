import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handoffRequest } from '../cloudflare/handoff.mjs';
import { playlistResume, processedPosition, videoOffset, Handoff } from '../src/handoff.mjs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { viewerSegment } from '../src/viewer.mjs';

test('resume seeks ten seconds before completed audio, not wall clock or receipt', () => {
  const playlist = '#EXT-X-MEDIA-SEQUENCE:100\n' + '#EXTINF:5.0,\n'.repeat(100);
  assert.deepEqual(playlistResume(playlist, 700000), { index: -62, video_ms: 690000 });
  assert.throws(() => playlistResume(playlist, 100000), /outside/);
  assert.throws(() => playlistResume('invalid', 700000), /verify/);
  assert.equal(processedPosition({ timeline_epoch: 0, video_offset_ms: 600000, audio_processed_until: 30000, audio_received_until: 90000 }), 630000);
  assert.equal(processedPosition({ timeline_epoch: 0, video_offset_ms: null, audio_processed_until: 30000 }), null);
  assert.equal(processedPosition({ timeline_epoch: 1, video_offset_ms: 0, audio_processed_until: 30000 }), null);
  assert.equal(processedPosition({ timeline_epoch: 0, total_gap_s: 2, video_offset_ms: 0, audio_processed_until: 30000 }), null);
});

test('resampling rounding does not erase the source clock; actual discontinuity does', () => {
  assert.equal(videoOffset({ spans: [{ pcm_sample: 0, source_pts: 96733960 }, { pcm_sample: 89891, source_pts: 96823850 }] }), 96733960 / 16);
  assert.equal(videoOffset({ spans: [{ pcm_sample: 0, source_pts: 96733960 }, { pcm_sample: 89891, source_pts: 96823850 + 16000 }] }), null);
});

test('two processors share durable progress and transcript; stale writes cannot rewind', async () => {
  const sql = new DatabaseSync(':memory:');
  const wrap = (query, bindings = []) => ({ bind: (...args) => wrap(query, args),
    first: async () => sql.prepare(query).get(...bindings) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...bindings) }),
    run: async () => sql.prepare(query).run(...bindings) });
  const env = { JC_LAPTOP_SECRET: 'a'.repeat(64), DB: { prepare: wrap, batch: async queries => Promise.all(queries.map(q => q.run())) } };
  const video = 'abcdefghijk', broadcast = 'b'.repeat(64);
  const send = async (data, key = env.JC_LAPTOP_SECRET, id = video) => handoffRequest(new Request('https://example.test/api/handoff?video=' + id,
    { method: data ? 'POST' : 'GET', headers: { 'X-JC-Handoff-Key': key }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  assert.equal((await send(null, 'bad')).status, 403);
  const cp = ms => ({ type: 'checkpoint', video_id: video, broadcast_id: broadcast, video_ms: ms });
  await send(cp(700000)); await send(cp(600000));
  assert.equal((await (await send()).json()).checkpoint.video_ms, 700000);
  assert.equal((await (await send(null, env.JC_LAPTOP_SECRET, 'other_video')).json()).checkpoint, null);
  const session = { session_id: 'session-1', stream_id: 'ch0', video_id: video, timeline_epoch: 0, video_offset_ms: 600000, audio_processed_until: 100000 };
  const segment = { segment_id: 'segment-1', session_id: session.session_id, stream_id: 'ch0', version: 1, start_ms: 20000, end_ms: 30000, raw_text: '회의를 시작합니다.' };
  await send({ type: 'rows', rows: [{ session, segment, broadcast_id: broadcast }] });
  const store = new Store(':memory:'), registry = new BroadcastRegistry(store);
  const receiver = new Handoff({ store, registry, scheduler: {}, config: {} });
  receiver.settings = {};
  receiver.request = async () => (await send()).json();
  const stream = { video_id: video, broadcast_id: broadcast, stream_id: 'ch0' };
  assert.equal(await receiver.resume(stream), 700000);
  assert.equal(await receiver.resume(stream), 700000);
  assert.equal(registry.segments(broadcast).length, 1);
  assert.equal(registry.segments(broadcast)[0].raw_text, segment.raw_text);
  store.db.close(); sql.close();
});

test('segments recorded after a handover are shown on the video clock', () => {
  const row = { stream_id: 'ch0', session_id: 's1', timeline_epoch: 0, segment_id: 'x', start_ms: 20000, end_ms: 30000,
    corrected_text: '회의를 속개하겠습니다.', ai_corrected: true, version: 2, video_offset_ms: 600000, speech_activity: { state: 'speech' } };
  assert.deepEqual([viewerSegment(row).start_ms, viewerSegment(row).end_ms], [620000, 630000]);
  assert.deepEqual([viewerSegment({ ...row, video_offset_ms: null }).start_ms], [20000]);
});

test('handoff sends an unchanged position once and retries a failed send', async () => {
  const stream = { stream_id: 'ch0', video_id: 'abcdefghijk', broadcast_id: 'b'.repeat(64) };
  const session = { session_id: 's1', stream_id: 'ch0', video_id: stream.video_id, state: 'stopped',
    timeline_epoch: 0, total_gap_s: 0, video_offset_ms: 600000, audio_processed_until: 30000 };
  const handoff = new Handoff({ config: {}, scheduler: { states: () => [session] },
    store: { streams: () => [stream], db: { prepare: () => ({ get: () => ({ last: 0 }) }) } },
    registry: { forSession: () => stream.broadcast_id, sessions: () => [], segments: () => [] } });
  handoff.settings = { processor: 'desktop' };
  const sent = []; let offline = true;
  handoff.request = async (_, data) => { if (offline) throw new Error('Offline'); sent.push(data.video_ms); return { ok: true }; };
  await assert.rejects(handoff.publish(), /Offline/);
  offline = false;
  await handoff.publish(); await handoff.publish();
  session.audio_processed_until = 45000;
  await handoff.publish(); await handoff.publish();
  assert.deepEqual(sent, [630000, 645000]);
});

test('one handoff request stores sentences and the position together', async () => {
  const sql = new DatabaseSync(':memory:');
  const wrap = (query, bindings = []) => ({ bind: (...args) => wrap(query, args),
    first: async () => sql.prepare(query).get(...bindings) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...bindings) }),
    run: async () => sql.prepare(query).run(...bindings) });
  const env = { JC_SYNC_SECRET: 'a'.repeat(64), DB: { prepare: wrap, batch: async queries => Promise.all(queries.map(q => q.run())) } };
  const video = 'abcdefghijk', broadcast = 'b'.repeat(64);
  const send = data => handoffRequest(new Request('https://example.test/api/handoff?video=' + video,
    { method: data ? 'POST' : 'GET', headers: { 'X-JC-Handoff-Key': env.JC_SYNC_SECRET }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  const session = { session_id: 'session-1', stream_id: 'ch0', video_id: video };
  const row = id => ({ session, segment: { segment_id: id, session_id: session.session_id, stream_id: 'ch0', version: 1 }, broadcast_id: broadcast });
  const position = (ms, id = video) => ({ video_id: id, broadcast_id: broadcast, video_ms: ms, processor: 'desktop' });
  try {
    // When sentences arrive with a position, both are stored and the answer names the position
    const answer = await send({ type: 'rows', rows: [row('segment-1')], checkpoint: position(700000) });
    assert.equal((await answer.json()).checkpoint.video_ms, 700000);
    const saved = await (await send()).json();
    assert.equal(saved.checkpoint.video_ms, 700000); assert.equal(saved.checkpoint.processor, 'desktop'); assert.equal(saved.rows.length, 1);
    // A position that is not valid (another video) is left out: the sentences are stored and the answer names no position
    assert.equal((await (await send({ type: 'rows', rows: [row('segment-2')], checkpoint: position(800000, 'other_video') })).json()).checkpoint, undefined);
    assert.equal((await (await send()).json()).checkpoint.video_ms, 700000);
    // An earlier position sent with sentences does not move the shared position back
    await send({ type: 'rows', rows: [row('segment-3')], checkpoint: position(600000) });
    const later = await (await send()).json();
    assert.equal(later.checkpoint.video_ms, 700000); assert.equal(later.rows.length, 3);
    // Sentences alone are answered without a position, as before
    assert.equal((await (await send({ type: 'rows', rows: [] })).json()).checkpoint, undefined);
  } finally { sql.close(); }
});
