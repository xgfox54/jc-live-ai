import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptState, viewerHealthMessage, publicationConnectionMessage, deliveryMetricsText, meetingStateText, meetingPause, newestMeetingsFirst,
  engineFromStatus, showEngineStatus } from '../public/client-state.mjs';

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

test('processing time and meeting state use measured values and the newest public sentence only', () => {
  const now = 10_000_000; const live = { status: 'silent', stages: { ingestion: 'ready' }, last_speech_ms: now - 150_000, backlog_ms: 4000 };
  assert.equal(deliveryMetricsText({ latency: { draft: { avg_ms: 14_400, max_ms: 61_000 }, corrected: null } }),
    '발언 후 표시까지 걸린 시간(최근 10분) · 1차 받아쓰기 평균 14초, 최대 1분 1초');
  assert.equal(deliveryMetricsText({ latency: null }), '');
  assert.equal(meetingStateText(live, 'recess', now), '정회가 선포된 뒤 새 발언이 없습니다.');
  assert.equal(meetingStateText(live, 'adjourned', now), '산회가 선포되었습니다.');
  assert.equal(meetingStateText(live, null, now), '마지막 발언은 2분 30초 전에 받았습니다. 새 발언을 기다립니다.');
  assert.equal(meetingStateText({ ...live, backlog_ms: 185_000 }, 'recess', now),
    '받아쓰기가 방송보다 약 3분 5초 늦습니다. 받은 순서대로 처리하고 있습니다.');
  assert.equal(meetingStateText({ ...live, status: 'stopped' }, 'recess', now), '');
  assert.equal(meetingStateText({ ...live, last_speech_ms: now - 30_000 }, null, now), '');
});

test('a 정회·산회 declaration pauses the meeting until other speech arrives', () => {
  const said = (text, at, extra = {}) => ({ text, audio_received_ms: at, ai_corrected: true, ...extra });
  // 2026-11-05 12:32: the declaration stayed the newest sentence while room sound was decoded until 14:30.
  assert.equal(meetingPause([said('원활한 회의 진행을 위해서 10분 쉬겠습니다.', 0), said('4시 30분까지 정회를 선포합니다. 감사합니다.', 10_000)]), 'recess');
  // 2026-10-23: a remark five seconds later and courtesy replies keep the adjournment.
  assert.equal(meetingPause([said('산회를 선포합니다. 감사합니다.', 0), said('수고하셨습니다. 시간 너무 길어.', 5_000),
    said('감사합니다. 감사합니다. 감사합니다.', 12_000), { text: '감사합니다.', audio_received_ms: 600_000, display_state: 'draft' }]), 'adjourned');
  // 2026-11-05 16:09: speech two and a half hours later resumes the meeting, already as a first draft.
  assert.equal(meetingPause([said('정회를 선포합니다.', 0), { text: '의석을 정돈해 주시기 바랍니다.', audio_received_ms: 8_834_000, display_state: 'draft' }]), null);
  // Removed drafts and rows awaiting correction are not public speech; six newer sentences end the pause whatever their timing.
  assert.equal(meetingPause([said('정회를 선포합니다.', 0), { text: '', display_state: 'removed', audio_received_ms: 900_000 },
    { text: '미보정 문장', audio_received_ms: 900_000, ai_corrected: false }]), 'recess');
  assert.equal(meetingPause([said('정회를 선포합니다.', 0), ...Array.from({ length: 6 }, (_, i) => said('질의를 이어 가겠습니다 ' + i, 1000 + i))]), null);
  assert.equal(meetingPause([said('정회 시간을 알려 드리겠습니다.', 0)]), null); assert.equal(meetingPause([]), null);
});

test('minutes list shows the newest meeting first and undated entries last', () => {
  const items = [{ id: 'a', scheduled_at: '2026-10-21 10:00' }, { id: 'b', scheduled_at: '2026-11-04 15:04 (수집 시작 시각)' }, { id: 'c', scheduled_at: '' },
    { id: 'd', scheduled_at: '2026-10-21 15:00' }, { id: 'e', scheduled_at: '2026-11-05 10:00' }, { id: 'f', scheduled_at: '2026-10-21 10:00' }, { id: 'g' }];
  assert.deepEqual(newestMeetingsFirst(items).map(item => item.id), ['e', 'b', 'd', 'a', 'f', 'c', 'g']);
  assert.deepEqual(items.map(item => item.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('engine indicator shows 정상 or 일시중단 and hides values it does not know', () => {
  const label = { textContent: '' }; const element = { hidden: true, dataset: {}, title: '', querySelector: () => label };
  showEngineStatus(element, 'running');
  assert.deepEqual([element.hidden, label.textContent, element.dataset.engine], [false, '정상', 'running']);
  showEngineStatus(element, engineFromStatus(503));
  assert.deepEqual([element.hidden, label.textContent, element.dataset.engine], [false, '일시중단', 'stopped']);
  for (const status of [502, 504]) assert.equal(engineFromStatus(status), 'stopped');
  for (const status of [200, 304, 404, 429, 500]) assert.equal(engineFromStatus(status), null);
  for (const value of [undefined, null, 'toString', 'paused']) { showEngineStatus(element, value); assert.equal(element.hidden, true); }
});
