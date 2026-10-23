import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { BroadcastMonitor } from '../src/broadcast-monitor.mjs';
import { youtubePhase, hlsSnapshot, createLiveProbe } from '../src/live-probe.mjs';

const stream = { stream_id: 'ch1', kind: 'youtube', name: 'Automatic test', approved: true,
  page_url: 'https://www.youtube.com/watch?v=abcdefghijk', video_id: 'abcdefghijk', auto_start: true };
function fixture(t, probe) {
  const store = new Store(':memory:'); store.saveStream(stream);
  const config = { chunkSeconds: 5, queueChunks: 4, silenceRms: 0, recordAudio: false };
  const engine = { ready: true, metadata: {}, stop: async () => {},
    transcribe: async () => ({ spans: [{ text: 'automatic test transcript' }], inference_ms: 0 }) };
  const scheduler = new Scheduler(store, engine, config);
  const runs = new Map(); const sources = [];
  const inputs = {
    isActive: id => runs.has(id),
    startYouTube(source) {
      sources.push(source);
      return new Promise(resolve => runs.set(source.stream_id, reason => { runs.delete(source.stream_id); scheduler.stop(source.stream_id, reason); resolve(); }));
    },
    async stop(id, reason) { runs.get(id)?.(reason); await immediate(); }
  };
  let now = Date.now();
  const monitor = new BroadcastMonitor({ store, scheduler, config, inputs, probe, now: () => now });
  t.after(async () => { await monitor.close(); for (const id of runs.keys()) await inputs.stop(id); await scheduler.close(); store.close(); });
  return { store, scheduler, config, inputs, monitor, sources, advance: () => { now += 300000; } };
}
const result = phase => ({ phase, source: stream, key: 'youtube:abcdefghijk' });
test('automatic collector waits for live, records once, transcribes and drains after end', async t => {
  let phase = 'waiting'; const f = fixture(t, async () => result(phase));
  await f.monitor.tick(); assert.equal(f.sources.length, 0);
  phase = 'live'; f.advance(); await f.monitor.tick();
  assert.equal(f.sources.length, 1); assert.equal(f.sources[0].auto_record, true);
  f.advance(); await f.monitor.tick(); assert.equal(f.sources.length, 1);
  const c = f.scheduler.channel('ch1');
  f.scheduler.feed('ch1', { session_id: c.session_id, epoch: 0, seq: 0, pcm: Buffer.alloc(32000, 1) });
  phase = 'ended'; f.advance(); await f.monitor.tick(); await immediate();
  assert.equal(f.scheduler.channel('ch1').state, 'stopped');
  assert.equal(f.store.snapshot(['ch1']).segments[0].raw_text, 'automatic test transcript');
  phase = 'live'; f.advance(); await f.monitor.tick(); assert.equal(f.sources.length, 1);
});
test('ended live-edge fallback drains with EOF; beginning capture and recent audio keep receiving', async t => {
  let source = { ...stream, capture_from_start: true, beginning_fallback: true }; let phase = 'live';
  const f = fixture(t, async () => ({ phase, source, key: 'youtube:abcdefghijk' }));
  f.store.saveStream(source); await f.monitor.tick();
  const c = f.scheduler.channel('ch1'); c.last_receive_ms = Date.now();
  phase = 'ended'; await f.monitor.check(source);
  assert.equal(c.state, 'running');
  f.advance(); await f.monitor.check(source); await immediate();
  assert.equal(c.state, 'stopped'); assert.equal(c.input_end_reason, 'eof');
  source = { ...stream, capture_from_start: true, beginning_fallback: false };
  f.store.saveStream(source); phase = 'live'; f.advance(); await f.monitor.check(source);
  f.scheduler.channel('ch1').last_receive_ms = Date.now();
  phase = 'ended'; f.advance(); await f.monitor.check(source);
  assert.equal(f.scheduler.channel('ch1').state, 'running');
});
test('manual stop invalidates an in-flight live check and persists disabled state', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.monitor.tick();
  f.monitor.setEnabled(stream, false); finish(result('live')); await pending;
  assert.equal(f.sources.length, 0); assert.equal(f.store.streams()[0].auto_start, false);
  f.advance(); await f.monitor.tick(); assert.equal(f.sources.length, 0);
});
test('concurrent polling and a manual start cannot launch a duplicate collector', async t => {
  let finish; let calls = 0;
  const f = fixture(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = f.monitor.tick(); const duplicate = f.monitor.tick();
  f.monitor.begin(stream); finish(result('live')); await pending; await duplicate;
  assert.equal(calls, 1); assert.equal(f.sources.length, 1);
  assert.throws(() => f.monitor.begin(stream), /이미 수집/);
});
test('shutdown cancels checks and late results cannot start recording', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.monitor.tick(); const closing = f.monitor.close();
  finish(result('live')); await pending; await closing;
  assert.equal(f.sources.length, 0);
});
test('completed video remains suppressed after monitor recreation but can be explicitly rearmed', async t => {
  const f = fixture(t, async () => result('live'));
  await f.monitor.tick(); await f.inputs.stop('ch1'); await immediate();
  await f.monitor.close();
  const replacement = new BroadcastMonitor({ store: f.store, scheduler: f.scheduler, inputs: f.inputs, config: f.config,
    probe: async () => result('live') });
  t.after(() => replacement.close());
  await replacement.tick(); assert.equal(f.sources.length, 1);
  replacement.setEnabled(f.store.streams()[0], true);
  await replacement.tick(); assert.equal(f.sources.length, 2);
});
test('recording quota or write failure disables automatic retries', async t => {
  const f = fixture(t, async () => result('live'));
  await f.monitor.tick();
  f.scheduler.channel('ch1').recording_failed = true;
  f.scheduler.channel('ch1').error = 'Recording quota reached';
  await f.inputs.stop('ch1'); await immediate();
  assert.equal(f.store.streams()[0].auto_start, false);
  assert.equal(f.monitor.states()[0].phase, 'blocked');
  f.advance(); await f.monitor.tick(); assert.equal(f.sources.length, 1);
});
test('detector errors back off without starting; capture input never starts automatically', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; throw new Error('network test failure'); });
  await f.monitor.tick(); const first = f.monitor.states()[0];
  assert.equal(first.phase, 'retry'); assert.equal(first.next_check_ms - first.checked_ms, 30000);
  await f.monitor.tick(); assert.equal(calls, 1);
  f.advance(); await f.monitor.tick(); const second = f.monitor.states()[0];
  assert.equal(second.next_check_ms - second.checked_ms, 60000); assert.equal(f.sources.length, 0);
  f.store.saveStream({ ...stream, kind: 'capture' }); f.advance(); await f.monitor.tick();
  assert.equal(calls, 2); assert.throws(() => f.monitor.setEnabled({ ...stream, kind: 'capture' }, true));
});
test('a changed registration cannot start from an old detector response', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.monitor.tick();
  f.store.saveStream({ ...stream, page_url: 'https://www.youtube.com/watch?v=lmnopqrstuv' });
  finish(result('live')); await pending; assert.equal(f.sources.length, 0);
});
test('live classification excludes upcoming, VOD and unknown values', () => {
  assert.equal(youtubePhase('is_live'), 'live'); assert.equal(youtubePhase('is_upcoming'), 'waiting');
  assert.equal(youtubePhase('was_live'), 'ended'); assert.equal(youtubePhase('post_live'), 'ended');
  // NA (removed or private video) is offline; an unrecognized status still throws.
  assert.equal(youtubePhase('not_live'), 'offline'); assert.equal(youtubePhase(null), 'offline'); assert.throws(() => youtubePhase('something_new'));
  assert.equal(hlsSnapshot('#EXTM3U\n#EXT-X-ENDLIST').phase, 'ended');
  assert.equal(hlsSnapshot('#EXTM3U\n').phase, 'waiting');
  assert.equal(hlsSnapshot('#EXTM3U\n#EXTINF:5,\nchunk.ts').phase, 'sample');
});
test('official HLS requires advancing media, ignores comments and distinguishes end markers', async t => {
  let body = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5,\nchunk1.ts';
  t.mock.method(globalThis, 'fetch', async url => new Response(String(url).includes('schedule.do')
    ? '<source src="https://vod.council.jeju.kr/live/TEST/playlist.m3u8">' : body,
  { headers: { 'Content-Type': String(url).includes('schedule.do') ? 'text/html' : 'application/vnd.apple.mpegurl' } }));
  const probe = createLiveProbe({}); const signal = new AbortController().signal;
  const council = { ...stream, kind: 'council', page_url: 'https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=1' };
  assert.equal((await probe(council, signal)).phase, 'waiting');
  body += '\n#COMMENT'; assert.equal((await probe(council, signal)).phase, 'waiting');
  body = body.replace('chunk1.ts', 'chunk2.ts'); assert.equal((await probe(council, signal)).phase, 'live');
  body += '\n#EXT-X-ENDLIST'; assert.equal((await probe(council, signal)).phase, 'ended');
  body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://127.0.0.1/private.m3u8';
  await assert.rejects(probe(council, signal), /공식 생방송/);
});
test('connection failures retry with increasing delay and one collector at a time', async t => {
  const f = fixture(t, async () => result('live'));
  await f.monitor.tick(); f.scheduler.channel('ch1').error = 'Audio decoder failed';
  await f.inputs.stop('ch1'); await immediate();
  assert.equal(f.monitor.states()[0].failures, 1);
  f.advance(); await f.monitor.tick(); assert.equal(f.sources.length, 2);
  f.scheduler.channel('ch1').error = 'Audio decoder failed'; await f.inputs.stop('ch1'); await immediate();
  assert.equal(f.monitor.states()[0].failures, 2);
  assert.equal(f.monitor.states()[0].next_check_ms - f.monitor.states()[0].checked_ms, 60000);
});
