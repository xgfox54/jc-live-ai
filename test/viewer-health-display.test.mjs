import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptState, viewerHealthMessage, publicationConnectionMessage } from '../public/client-state.mjs';

test('viewer health uses fixed public copy for each status and never renders server errors', () => {
  const expected = [
    ['waiting', null, '방송 음성 수신을 기다립니다.'],
    ['silent', 'transcription', '음성을 수신하고 있습니다. 현재 감지된 발언이 없습니다.'],
    ['processing', 'transcription', '수신한 음성을 받아쓰고 있습니다.'],
    ['processing', 'correction', '받아쓰기 내용을 AI가 후보정하고 있습니다.'],
    ['correction_delayed', 'correction', 'AI 후보정이 지연되고 있습니다. 완료된 문장은 계속 표시합니다.'],
    ['delayed', 'ingestion', '방송 음성 수신이 지연되고 있습니다. 공식 영상에서 방송 상태를 확인해 주세요.'],
    ['delayed', 'transcription', '회의록 받아쓰기가 지연되고 있습니다. 완료된 문장은 계속 표시합니다.'],
    ['delayed', 'publication', '새 받아쓰기 자료의 게시가 지연되고 있습니다. 마지막 게시 자료를 표시합니다.'],
    ['ready', null, 'AI 후보정이 완료된 받아쓰기 내용을 표시합니다.'],
    ['stopped', null, '방송 기록 수집이 종료되었습니다.'],
    ['future-unknown-status', null, ''],
  ];
  for (const [status, stage, text] of expected)
    assert.equal(viewerHealthMessage({ status, stage, message: 'private backend error', error: 'private secret' }), text);
  assert.equal(viewerHealthMessage(undefined), '');
});

test('successful poll still reports stale published data and distinguishes missing time from network failure', () => {
  const delivery = { mode: 'poll', published_ms: 1_000_000 };
  const publication = { stale_after_ms: 90_000 };
  assert.match(publicationConnectionMessage(delivery, publication, true, 1_090_001), /^새 자료 게시가 지연/);
  assert.match(publicationConnectionMessage(delivery, publication, true, 1_090_000), /^최근 갱신 /);
  assert.match(publicationConnectionMessage(delivery, undefined, true, 1_120_001), /^새 자료 게시가 지연/);
  assert.equal(publicationConnectionMessage(delivery, publication, false), '새 자료 수신이 지연되고 있습니다');
  for (const published_ms of [undefined, null, NaN, Infinity, 0])
    assert.equal(publicationConnectionMessage({ published_ms }, publication, true), '게시 시각을 확인할 수 없습니다');
});

test('health refresh replaces health only and preserves transcript browsing state', () => {
  const state = new TranscriptState();
  state.reset({ event_id: 5, segments: [{ segment_id: 'old-page', stream_id: 'ch1', version: 1 }],
    states: [{ stream_id: 'ch1', state: 'running' }], health: [{ stream_id: 'ch1', status: 'ready' }] });
  const segment = state.segments.get('old-page');
  state.updateHealth({ health: [{ stream_id: 'ch1', status: 'correction_delayed' }, { stream_id: 'ch2', status: 'silent' }] });
  assert.equal(state.health.get('ch1').status, 'correction_delayed');
  assert.equal(state.health.get('ch2').status, 'silent');
  assert.equal(state.segments.get('old-page'), segment);
  assert.equal(state.cursor, 5);
  assert.equal(state.status.get('ch1').state, 'running');
  state.updateHealth({});
  assert.equal(state.health.size, 0);
});

test('ended ingestion is explicit while a few corrections remain pending', () => {
  assert.equal(viewerHealthMessage({ status: 'correction_delayed', stages: { ingestion: 'stopped', transcription: 'stopped' } }),
    '방송 기록 수집이 종료되었습니다. 일부 문장은 AI 후보정을 기다리고 있습니다.');
});
