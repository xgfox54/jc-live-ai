import test from 'node:test';
import assert from 'node:assert/strict';
import { councilPage, parseCouncilPlayer } from '../src/council.mjs';

test('council resolution accepts only official detail pages and strips unrelated query data', () => {
  assert.equal(councilPage('https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=7010&extra=1'),
    'https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=7010');
  for (const url of ['https://www.council.jeju.kr/broadcast/index.do', 'https://localhost/broadcast/schedule.do?act=view&seq=1',
    'https://www.council.jeju.kr/broadcast/schedule.do?act=view&seq=../1']) assert.throws(() => councilPage(url));
});
test('council parser separates public HLS and YouTube and ignores inactive page scripts', () => {
  const hls = '<source src="https://vod.council.jeju.kr/live/XHC011/playlist.m3u8"/><script>myPlayer.src("http://vod.council.jeju.kr:1935/live/XHC012/playlist.m3u8");</script>';
  assert.equal(parseCouncilPlayer(hls).resolved_kind, 'hls');
  const replay = '<source src="https://vod.council.jeju.kr/vod/_definst_//2026/455/20261021_2_gyo/playlist.m3u8" type="application/x-mpegURL" />';
  assert.equal(parseCouncilPlayer(replay).media_url, 'https://vod.council.jeju.kr/vod/_definst_//2026/455/20261021_2_gyo/playlist.m3u8');
  assert.throws(() => parseCouncilPlayer('<source src="https://vod.council.jeju.kr/vod/_definst_/../secret/playlist.m3u8">'));
  const youtube = '<iframe src="https://www.youtube.com/embed/k349Q6iyR_0?si=test"></iframe>';
  assert.equal(parseCouncilPlayer(youtube).video_id, 'k349Q6iyR_0');
  assert.throws(() => parseCouncilPlayer(hls + youtube), /one supported/);
});
test('council parser rejects arbitrary media hosts, credentials, ports and VOD paths', () => {
  for (const source of ['http://vod.council.jeju.kr/live/X/playlist.m3u8', 'https://127.0.0.1/live/X/playlist.m3u8',
    'https://vod.council.jeju.kr:8443/live/X/playlist.m3u8', 'https://user@vod.council.jeju.kr/live/X/playlist.m3u8',
    'https://vod.council.jeju.kr/private/file.mp4']) assert.throws(() => parseCouncilPlayer('<source src="' + source + '">'));
});
