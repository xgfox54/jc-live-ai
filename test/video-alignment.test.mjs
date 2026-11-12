import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedOffsets, videoOffsets, videoShift, ALIGNMENT_METHOD, alignmentSource, VideoAlignment } from '../src/video-alignment.mjs';
import { councilReplay, downloadReplayAudio } from '../src/council.mjs';
import { buildMinutes } from '../src/minutes.mjs';
import { publicMinutes } from '../web/lib/model.mjs';

const REPLAY = 'https://vod.council.jeju.kr/vod/_definst_//2026/455/20261023_2_bon/playlist.m3u8';

const probe = (session, offset_s, status = 'matched') => ({ session, pcm_s: 15, offset_s, status });
test('only consistent, mostly matched sessions receive a video offset', () => {
  const result = { probes: [probe('a', 2165.075), probe('a', 2165.075), probe('a', 2165.08), { session: 'a', status: 'silent' },
    probe('b', 10), probe('b', 10),
    probe('c', 30), probe('c', 30.5), probe('c', 30),
    probe('d', 5), probe('d', 5), probe('d', 5), probe('d', 9, 'ambiguous'), probe('d', 9, 'ambiguous')] };
  const accepted = acceptedOffsets(result, { one: 'a', two: 'b', three: 'c', four: 'd' });
  assert.deepEqual(Object.keys(accepted), ['one']);
  assert.equal(accepted.one.offset_ms, 2165075); assert.equal(accepted.one.spread_ms, 5); assert.equal(accepted.one.probes, 4);
});

test('aligned sessions use the video clock in labels, gaps and public minutes; restarted epochs keep collection time', () => {
  const row = (id, session_id, start_ms, epoch = 0) => ({ segment_id: 's' + id, session_id, timeline_epoch: epoch, start_ms, end_ms: start_ms + 5000,
    corrected_text: '발언 ' + id, ai_corrected: true });
  const sessions = [{ session_id: 'one', state: 'stopped' }, { session_id: 'two', state: 'stopped' }];
  const rows = [row(1, 'one', 0), row(2, 'one', 60000), row(3, 'two', 0), row(4, 'two', 10000, 1)];
  const alignment = { phase: 'complete', method: ALIGNMENT_METHOD, video_id: 'pwvxi_rX3ao', sessions: { one: { offset_ms: 2165075 }, two: { offset_ms: 7574930 } } };
  assert.deepEqual([...videoOffsets(alignment, sessions, rows)], [['one', { offset_ms: 2165075 }]]);
  assert.equal(videoOffsets({ ...alignment, phase: 'failed' }, sessions, rows).size, 0);
  const value = buildMinutes({ id: 'a'.repeat(64), title: '시험', sources: [], stream_id: 'ch0' }, sessions, rows,
    [{ session_id: 'one', timeline_epoch: 0, start_ms: 30000, end_ms: 31000, reason: 'queue_overflow' }], { videoAlignment: alignment });
  assert.equal(value.transcript[0].start_ms, 2165075); assert.equal(value.transcript[0].video_time, true);
  assert.equal(value.transcript[2].start_ms, 0); assert.equal(value.transcript[2].video_time, undefined);
  assert.equal(value.gaps[0].start_ms, 2195075);
  assert.match(value.markdown, /영상 00:36:05~00:36:10/);
  assert.ok(value.warnings.some(text => text.startsWith('"영상"으로 표시한 시각')));
  const published = publicMinutes({ ...value, publication_policy: 'ai-corrected-v1' });
  assert.equal(published.transcript[0].video_time, true); assert.deepEqual(published.video_alignment, { video_id: 'pwvxi_rX3ao', sessions: [{ session_number: 1, offset_ms: 2165075 }] });
  assert.throws(() => publicMinutes({ ...value, publication_policy: 'ai-corrected-v1', video_alignment: { video_id: 'javascript:x', sessions: [] } }));
});

test('replay audio download stays in the council replay directory and needs a finished playlist', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-replay-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = REPLAY.slice(0, REPLAY.lastIndexOf('/') + 1);
  const site = chunklist => ({ [REPLAY + '?wowzaaudioonly']: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunklist_w1_ao.m3u8\n',
    [base + 'chunklist_w1_ao.m3u8']: chunklist, [base + 'media_w1_ao_0.aac']: 'AAA', [base + 'media_w1_ao_1.aac']: 'BB' });
  const server = pages => { const requested = [];
    return { requested, fetchImpl: async url => { requested.push(String(url)); const body = pages[String(url)];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body); } }; };
  const finished = '#EXTM3U\n#EXTINF:12.043,\nmedia_w1_ao_0.aac\n#EXTINF:9.984,\nmedia_w1_ao_1.aac\n#EXT-X-ENDLIST\n';
  const file = join(directory, 'video.aac');
  assert.deepEqual(await downloadReplayAudio(REPLAY, file, server(site(finished))), { segments: 2, bytes: 5, seconds: 22.027 });
  assert.equal(readFileSync(file, 'utf8'), 'AAABB');
  for (const entry of ['https://evil.test/media_w1_ao_0.aac', '../media_w1_ao_0.aac', 'media_w1_ao_0.aac?x=1']) {
    const bad = server(site('#EXTM3U\n#EXTINF:10,\n' + entry + '\n#EXT-X-ENDLIST\n'));
    await assert.rejects(downloadReplayAudio(REPLAY, file, bad), /Unexpected replay playlist entry/);
    assert.ok(bad.requested.every(url => url.startsWith(base)));
  }
  await assert.rejects(downloadReplayAudio(REPLAY, file, server(site(finished.replace('#EXT-X-ENDLIST\n', '')))), /not complete/);
  for (const url of ['https://vod.council.jeju.kr/live/XHC011/playlist.m3u8', REPLAY.replace('https:', 'http:'), REPLAY + '?x=1',
    REPLAY.replace('vod.council.jeju.kr', 'vod.council.jeju.kr.evil.test')]) assert.throws(() => councilReplay(url));
  const page = 'https://www.council.jeju.kr/broadcast/broad.do?act=view&seq=10041';
  assert.deepEqual(alignmentSource({ replay_url: REPLAY, replay_page: page, video_id: 'pwvxi_rX3ao' }),
    { source: 'council_vod', media_url: REPLAY, page_url: page, video_id: null });
  assert.equal(alignmentSource({ replay_url: 'https://evil.test/playlist.m3u8', video_id: 'pwvxi_rX3ao' }).source, 'youtube');
});

test('replay alignment is published in its own field and only for council replay playlists', () => {
  const sessions = [{ session_id: 'one', state: 'stopped' }];
  const rows = [{ segment_id: 's1', session_id: 'one', timeline_epoch: 0, start_ms: 1000, end_ms: 6000, corrected_text: '발언', ai_corrected: true }];
  const alignment = { phase: 'complete', method: ALIGNMENT_METHOD, source: 'council_vod', media_url: REPLAY, video_id: null,
    page_url: 'https://www.council.jeju.kr/broadcast/broad.do?act=view&seq=10041', sessions: { one: { offset_ms: 60000 } } };
  const value = { ...buildMinutes({ id: 'b'.repeat(64), title: '시험', sources: [], stream_id: 'ch0' }, sessions, rows, [], { videoAlignment: alignment }),
    publication_policy: 'ai-corrected-v1' };
  assert.equal(value.video_alignment, null); assert.equal(value.transcript[0].start_ms, 61000);
  assert.deepEqual(publicMinutes(value).replay, { media_url: REPLAY, page_url: alignment.page_url, sessions: [{ session_number: 1, offset_ms: 60000 }] });
  for (const media_url of ['https://evil.test/vod/_definst_//2026/455/a/playlist.m3u8', 'javascript:alert(1)', REPLAY + '?token=1',
    'https://vod.council.jeju.kr/live/XHC011/playlist.m3u8']) assert.throws(() => publicMinutes({ ...value, replay: { ...value.replay, media_url } }));
});

// Patterns measured on Session 455: a recording that began 85 minutes before a replay covering only the meeting,
// and a recording that skipped about 20 seconds of the broadcast.
test('a recording may start before the replay or skip a stretch; only speech inside a matched range moves to the video clock', () => {
  const at = (session, pcm_s, offset_s, status = 'matched') => ({ session, pcm_s, offset_s, status });
  const result = { video_seconds: 2164, probe_seconds: 30, probes: [
    ...[15, 315, 615].map(pcm_s => ({ session: 'early', pcm_s, status: 'silent' })), at('early', 5115, -4090.58, 'ambiguous'),
    ...[5415, 5715, 6015, 6315, 6615, 6915].map(pcm_s => at('early', pcm_s, -5120.16)),
    ...[15, 315, 615, 915].map(pcm_s => at('skip', pcm_s, 338.62)), ...[1215, 1515, 1815].map(pcm_s => at('skip', pcm_s, 358.7))] };
  const accepted = acceptedOffsets(result, { one: 'early', two: 'skip' });
  assert.equal(accepted.one.offset_ms, -5120160); assert.equal(accepted.one.ranges, undefined); assert.equal(accepted.one.matched, 6);
  assert.deepEqual(accepted.two.ranges, [{ from_ms: null, to_ms: 945000, offset_ms: 338620 }, { from_ms: 1215000, to_ms: null, offset_ms: 358700 }]);
  assert.equal(videoShift(accepted.one, 5200000, 5205000), -5120160);
  assert.equal(videoShift(accepted.one, 100000, 105000), null, 'before the replay starts');
  assert.equal(videoShift(accepted.one, 7300000, 7305000), null, 'after the replay ends');
  const sessions = [{ session_id: 'two', state: 'stopped' }];
  const rows = [0, 1000000, 1300000].map((start_ms, index) => ({ segment_id: 's' + index, session_id: 'two', timeline_epoch: 0, start_ms,
    end_ms: start_ms + 5000, corrected_text: '발언 ' + index, ai_corrected: true }));
  const value = buildMinutes({ id: 'd'.repeat(64), title: '시험', sources: [], stream_id: 'ch0' }, sessions, rows, [],
    { videoAlignment: { phase: 'complete', method: ALIGNMENT_METHOD, media_url: REPLAY, sessions: { two: accepted.two } } });
  assert.deepEqual(value.transcript.map(item => [item.start_ms, item.video_time ?? false]), [[338620, true], [1000000, false], [1658700, true]]);
  assert.ok(value.warnings.some(text => text.startsWith('"영상"으로 표시한 시각')));
  const early = buildMinutes({ id: 'e'.repeat(64), title: '시험', sources: [], stream_id: 'ch8' }, [{ session_id: 'one', state: 'stopped' }],
    [{ segment_id: 'e1', session_id: 'one', timeline_epoch: 0, start_ms: 5200000, end_ms: 5205000, corrected_text: '개의', ai_corrected: true }], [],
    { videoAlignment: { phase: 'complete', method: ALIGNMENT_METHOD, media_url: REPLAY, sessions: { one: accepted.one } } });
  assert.deepEqual(publicMinutes({ ...early, publication_policy: 'ai-corrected-v1' }).replay.sessions, [{ session_number: 1, offset_ms: -5120160 }]);
  assert.equal(early.transcript[0].start_ms, 79840);
});

test('a failed new measurement keeps the completed result and an interrupted one restores it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jc-align-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'rec', 'ch0', 'one'), { recursive: true }); writeFileSync(join(directory, 'rec', 'ch0', 'one', 'audio.pcm'), Buffer.alloc(32));
  const id = 'c'.repeat(64); const record = { id, video_id: 'pwvxi_rX3ao', sources: [] }; const states = new Map(); const emitted = [];
  const review = { get: key => states.get(key) ?? null, save: (key, value) => { states.set(key, value); return value; }, record: () => record, store: {} };
  const registry = { list: () => [record], sessions: () => [{ session_id: 'one', stream_id: 'ch0' }] };
  const previous = { phase: 'complete', method: ALIGNMENT_METHOD, video_id: 'pwvxi_rX3ao', sessions: { one: { offset_ms: 5 } }, updated_ms: 1 };
  states.set('video-alignment:' + id, previous);
  const config = { recordings: join(directory, 'rec'), alignmentDirectory: join(directory, 'work'), ytdlp: join(directory, 'missing-yt-dlp.exe') };
  const alignment = new VideoAlignment({ registry, review, store: { emit: (kind, value) => emitted.push(value) }, config });
  t.after(() => alignment.close());
  assert.equal(alignment.start(id).replaces, previous); await alignment.pending;
  const kept = states.get('video-alignment:' + id);
  assert.equal(kept.phase, 'complete'); assert.deepEqual(kept.sessions, previous.sessions); assert.ok(kept.rerun_failed_ms > 0); assert.deepEqual(emitted, [id]);
  states.set('video-alignment:' + id, { phase: 'running', replaces: previous });
  await new VideoAlignment({ registry, review, store: { emit() {} }, config }).close();
  assert.equal(states.get('video-alignment:' + id), previous);
});

