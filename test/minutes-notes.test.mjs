import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMinutes } from '../src/minutes.mjs';
import { budgetYears, budgetYear } from '../src/budget-year.mjs';

const record = { id: 'a'.repeat(64), title: '시험 회의', sources: [], stream_id: 'ch2' };
const row = (index, text, extra = {}) => ({ segment_id: 's' + index, session_id: 'one', timeline_epoch: 0, start_ms: index * 10000, end_ms: index * 10000 + 9000,
  corrected_text: text, ai_corrected: true, ...extra });
const ended = 1_800_000_000_000;
const session = { session_id: 'one', state: 'stopped', ended_ms: ended, last_receive_ms: ended - 30_000 };
const timeNote = value => value.warnings[1];

test('the time note says whether sentences were matched to the official video or keep the YouTube live position', () => {
  const live = [row(0, '개의하겠습니다.', { video_offset_ms: 3_600_000 }), row(1, '질의하겠습니다.', { video_offset_ms: 3_600_000 })];
  assert.match(timeNote(buildMinutes(record, [session], live, [])), /^시각은 유튜브 생중계 영상의 재생 위치입니다\. 공식 다시보기 영상과는 아직 대조하지 않아/);
  const alignment = { phase: 'complete', method: 'audio-match-v1', sessions: { one: { offset_ms: 60_000 } } };
  assert.match(timeNote(buildMinutes(record, [session], live, [], { videoAlignment: alignment })), /녹음 음성과 공식 영상 음성을 대조해 세션별로 맞췄습니다/);
  const value = buildMinutes(record, [session], live, [], { videoAlignment: alignment });
  assert.equal(value.transcript[0].start_ms, 60_000); assert.equal(value.transcript[0].video_time, true);
  assert.match(timeNote(buildMinutes(record, [session], [row(0, '개의하겠습니다.')], [])), /^시각은 수집 세션과 입력 구간별 경과 시간입니다/);
  const mixed = [row(0, '개의하겠습니다.', { video_offset_ms: 3_600_000 }), row(1, '질의하겠습니다.')];
  assert.match(timeNote(buildMinutes(record, [session], mixed, [])), /대조하지 않은 구간은 유튜브 생중계 위치라 .*"영상" 표시가 없는 시각은 수집 세션별 경과 시간입니다/);
});

test('a collection stop when the broadcast ends after adjournment is not counted as a gap; a stop in a recess is', () => {
  const adjourned = [row(0, '질의를 마치겠습니다.'), row(1, '이상으로 회의를 모두 마치도록 하겠습니다. 산회를 선포합니다.')];
  const gaps = [{ session_id: 'one', reason: 'collector_failed', extent: 'unknown', created_ms: ended - 2000 },
    { session_id: 'one', reason: 'beginning_collection_failed', extent: 'unknown', created_ms: ended - 2000 }];
  const value = buildMinutes(record, [session], adjourned, gaps);
  assert.deepEqual(value.gaps, []);
  assert.ok(value.warnings.includes('산회 선포 뒤 방송이 끝나면서 생긴 수집 종료 기록 2건은 누락·중단 기록에서 제외했습니다.'));
  assert.ok(!value.warnings.some(text => text.startsWith('음성·전사 누락')));
  const recess = buildMinutes(record, [session], [row(0, '계수조정을 위해 정회를 선포합니다.')], gaps);
  assert.equal(recess.gaps.length, 2); assert.ok(recess.warnings.some(text => text.startsWith('음성·전사 누락 또는 입력 중단 기록 2건')));
  // A gap with a range, or one recorded long before the session ended, is a gap in the meeting.
  const early = buildMinutes(record, [session], adjourned, [{ ...gaps[0], created_ms: ended - 3_600_000 }, { ...gaps[1], start_ms: 0, end_ms: 5000 }]);
  assert.equal(early.gaps.length, 2);
});

test('names kept from an earlier review are explained in the minutes', () => {
  const rows = [row(0, '이경심입니다.'), row(1, '안건을 설명합니다.')];
  const identity = { name: '이경심', role: 'member', title: '위원', key: 'person-' + '1'.repeat(24) + ':1' };
  const value = buildMinutes(record, [session], rows, [], { finalSpeakers: { phase: 'partial', kept: true, assigned: 1, unresolved: 1, updated_ms: 1,
    assignments: { s0: identity, s1: null } } });
  assert.equal(value.transcript[0].speaker_name, '이경심'); assert.equal(value.transcript[1].speaker_name, null);
  assert.match(value.markdown, /재검토 뒤 새로 공개되거나 바뀐 문장은 다시 검토할 때까지 발언자 미확인으로 둡니다/);
  assert.deepEqual(value.final_speakers, { phase: 'partial', assigned: 1, unresolved: 1, updated_ms: 1 });
});

test('a budget year heard ten years early is written as the year under review only next to a budget document', () => {
  const agenda = '1. 2027년도 제주특별자치도 예산안\n2. 2027년도 제주특별자치도 기금운용계획안';
  assert.equal(budgetYear(agenda), 2027); assert.equal(budgetYear('제주특별자치도 조례 일부개정조례안'), null);
  const rows = [
    '경제활력국 소관 2017년도 예산안 및 기금운용계획안과 동의안 1건', '2017년도 공유재산관리계획안 서귀포관광극장 문화공간 조성사업은',
    '그러면 의사일정 제1항 2017년에', '제주특별자치도 예산안부터 의사일정 제4항까지',
    '제주시와 서귀포시의 2017년도', '예산안 및 기금운용계획안에 대해 심사하게 됩니다.',
    '재활용 도움센터가 언제부터 되죠? 2017년부터', '되고 있습니다. 2027년도 예산안 심사입니다.',
    '2017년 계획에는 160명에 지원할 건데 1억 4400만 원으로 예산을', '2017년도부터 운영했습니다. 2027년도 예산안도',
  ].map((text, index) => row(index, text));
  const fixed = budgetYears(rows, agenda).map(item => item.corrected_text);
  assert.deepEqual(fixed.map(text => /2017/.test(text)), [false, false, false, false, false, false, true, false, true, true]);
  assert.equal(fixed[0], '경제활력국 소관 2027년도 예산안 및 기금운용계획안과 동의안 1건');
  assert.equal(budgetYears(rows, '조례안 심사'), rows);
  assert.equal(budgetYears([row(0, '2017년도'), { ...row(1, '예산안'), session_id: 'two' }], agenda)[0].corrected_text, '2017년도');
});
