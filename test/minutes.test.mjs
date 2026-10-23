import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMinutes, paragraphsOf, minutesLabel } from '../src/minutes.mjs';
import { parseCouncilArchive, ArchiveEnricher } from '../src/council-archive.mjs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { ReviewService } from '../src/review.mjs';
import { publicMinutes } from '../web/lib/model.mjs';
import { validateDigest } from '../src/meeting-digest.mjs';

test('meeting digest drops only items with unsupported numbers and rejects an unsupported overview', () => {
  const facts = [{ id: 'F0', group: 0, text: '예산 100원 검토', quote: '예산 100원을 검토합니다', segment_id: 's0' },
    { id: 'F1', group: 1, text: '자료 요청', quote: '자료를 요청합니다', segment_id: 's1' }];
  const answer = { overview: { text: '예산 검토와 자료 요청', refs: ['F0', 'F1'] },
    topics: [{ title: '예산', items: [{ text: '예산 100원 검토', refs: ['F0'] }, { text: '예산 999원 증액', refs: ['F0'] }] },
      { title: '자료 50건', items: [{ text: '자료 요청', refs: ['F1'] }] }],
    groups: [{ group: 0, title: '예산 7건' }, { group: 1, title: '자료' }] };
  const digest = validateDigest(answer, facts);
  assert.deepEqual(digest.topics.map(topic => [topic.title, topic.items.map(item => item.text)]), [['예산', ['예산 100원 검토']]]);
  assert.equal(digest.groups[0].title, ''); assert.equal(digest.dropped, 3); assert.equal(digest.overview.evidence[1].segment_id, 's1');
  assert.throws(() => validateDigest({ ...answer, overview: { text: '예산 5원', refs: ['F0'] } }, facts), /수치/);
  assert.throws(() => validateDigest({ ...answer, groups: [answer.groups[0]] }, facts), /묶음/);
});

const segment = (i, speaker, text, extra = {}) => ({ segment_id: 's' + i, session_id: 'one', timeline_epoch: 0, start_ms: i * 10000, end_ms: i * 10000 + 10000,
  raw_text: text, corrected_text: text, ai_corrected: true, version: 2, speaker_scope: 'scope', speaker_state: speaker ? 'assigned' : 'unknown', speaker_id: speaker, ...extra });
test('minutes merge consecutive sentences of one participant into paragraphs with committee labels and names', () => {
  const sessions = [{ session_id: 'one', state: 'stopped', started_ms: Date.parse('2026-10-21T01:00:00Z') }];
  const segments = [segment(0, 1, '개의하겠습니다.'), segment(1, 1, '안건을 상정합니다.'), segment(2, 2, '질의하겠습니다.'), segment(3, 2, '답변 바랍니다.'),
    segment(4, null, '정리 중입니다.'), segment(5, 1, '감사합니다.')];
  const record = { id: 'f'.repeat(64), title: '행정자치위원회', sources: [], stream_id: 'ch2' };
  const items = [{ text: '회의 개의와 안건 상정', quote: '개의하겠습니다.', source_id: 's0p0', segment_id: 's0', session_id: 'one', start_ms: 0, group: 0 }];
  const digest = { overview: { text: '개의 후 안건을 상정하고 질의를 진행한 회의', evidence: [{ segment_id: 's0', quote: '개의하겠습니다.' }] },
    topics: [{ title: '안건 상정', items: [{ text: '안건을 상정함', evidence: [{ segment_id: 's1', quote: '안건을 상정합니다.' }] }] }], groups: [{ group: 0, title: '개의와 안건 상정' }] };
  const value = buildMinutes(record, sessions, segments, [], { participants: { 'scope:1': '하성용 위원장' },
    summary: { method: 'grounded_ai', model: 'm', updated_ms: 1, items, groups: [{ group: 0, title: '개의와 안건 상정', items }], digest } });
  assert.equal(value.committee, '행정자치위원회'); assert.equal(value.scheduled_at, '2026-10-21 10:00 (수집 시작 시각)');
  assert.deepEqual(value.paragraphs.map(item => item.text), ['개의하겠습니다. 안건을 상정합니다.', '질의하겠습니다. 답변 바랍니다.', '정리 중입니다.', '감사합니다.']);
  assert.deepEqual(value.participants.map(item => [item.label, item.paragraph_count, item.named]), [['하성용 위원장', 2, true], ['발언자 미확인', 1, false]]);
  assert.equal(minutesLabel(value.paragraphs[0], value.committee, { 'scope:1': '하성용 위원장' }), '[행정자치위원회 / 구간 0 / 00:00:00~00:00:20 / 하성용 위원장]');
  assert.match(value.markdown, /## 1장 회의록\n\n### 회의 한줄 요약\n\n개의 후 안건을 상정하고 질의를 진행한 회의\n\n### 주요 논의 사항\n\n#### 안건 상정\n\n- 안건을 상정함\n  근거: 안건을 상정합니다\./);
  assert.match(value.markdown, /### 발언자\n\n[^\n]+\n\n- 하성용 위원장 · 발언 2건 · 약 1분/);
  assert.match(value.markdown, /## 핵심 내용 요약\n\n### 00:00:00 · 개의와 안건 상정\n\n- 회의 개의와 안건 상정\n  근거: 개의하겠습니다\./);
  assert.match(value.markdown, /## 전체 회의 받아쓰기 기록\n\n\*\*\[행정자치위원회/);
  assert.doesNotMatch(value.markdown, /의결 관련 발언 발췌|후속 조치 관련 발언 발췌|## 발언 내용 정리|## 주요 논의 요약/);
  assert.equal(value.timeline[0].session_number, 1); assert.equal(value.digest.topics[0].items[0].evidence[0].segment_id, 's1');
  assert.match(value.markdown, /\*\*\[행정자치위원회 \/ 구간 0 \/ 00:00:00~00:00:20 \/ 하성용 위원장\]\*\*  \n개의하겠습니다\. 안건을 상정합니다\./);
  const published = publicMinutes({ ...value, publication_policy: 'ai-corrected-v1' });
  assert.equal(published.participants[0].label, '하성용 위원장'); assert.equal(published.summary.items.length, 1); assert.equal(published.paragraphs.length, 4);
  assert.equal(published.digest.overview.evidence[0].segment_id, 's0'); assert.equal(published.timeline[0].title, '개의와 안건 상정');
  assert.deepEqual(published.paragraphs[0].segment_ids, ['s0', 's1']);
  const bare = buildMinutes(record, sessions, segments, [], { summary: null });
  assert.equal(bare.digest, null); assert.deepEqual(bare.timeline, []); assert.match(bare.markdown, /## 1장 회의록\n\n요약할 발언이 아직 없습니다\./);
  const pending = i => ({ ...segment(i, 1, 'x'), text: 'x', speaker_state: 'pending', session_number: 1, epoch: 0 });
  assert.equal(paragraphsOf([pending(0), pending(1)]).length, 2);
});
test('participant names validate keys and feed the next minutes build', () => {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const review = new ReviewService({ store, registry, correctionAI: { settings: () => ({ automatic: false }), config: {} } });
  try {
    const record = registry.upsert({ title: '시험', page_url: 'https://www.youtube.com/watch?v=abcdefghijk', sources: [], kind: 'youtube' });
    registry.attach({ stream_id: 'ch2', broadcast_id: record.id }, { session_id: 'one' }); store.saveSession({ stream_id: 'ch2', session_id: 'one', state: 'stopped' });
    store.segment({ stream_id: 'ch2', session_id: 'one', start_ms: 0, end_ms: 1000, raw_text: '발언', speaker_scope: 'scope', speaker_state: 'assigned', speaker_id: 3 });
    assert.deepEqual(review.participants(record.id).speakers.map(item => item.key), ['scope:3']);
    assert.ok(review.participants(record.id).members.some(name => /위원장$/.test(name)));
    assert.throws(() => review.setParticipants(record.id, { 'scope:9': 'x' }), error => error.status === 400);
    review.setParticipants(record.id, { 'scope:3': ' 이남근 부위원장 ' });
    assert.deepEqual(registry.participants(record.id), { 'scope:3': '이남근 부위원장' });
  } finally { review.close(); store.close(); }
});
test('council archive parser and enricher fill meeting information for recordings without an official page', async () => {
  const row = (seq, date, order, title) => '<tr><td>1</td><td>13대</td><td>' + date + '</td><td>455회  </td><td>임시회</td><td>' + order + '</td><td>' + title + '</td>'
    + '<td><a href="/broadcast/broad.do;jsessionid=abc?act=view&amp;seq=' + seq + '">방송보기</a></td><td></td></tr>';
  const list = '<table>' + row(10035, '2026-10-21', '2차', '행정자치위원회') + row(10034, '2026-10-20', '1차', '행정자치위원회') + row(10036, '2026-10-21', '1차', '보건복지안전위원회') + '</table>';
  assert.deepEqual(parseCouncilArchive(list).map(item => [item.date, item.order, item.title, item.page_url]).slice(0, 1),
    [['2026-10-21', '2차', '행정자치위원회', 'https://www.council.jeju.kr/broadcast/broad.do?act=view&seq=10035']]);
  const detail = '<ul><li><b>일시 : </b>2026-10-21 10:00</li><li><b>회차 : </b>제455회(2차)</li><li><b>회의 : </b>임시회</li><li><b>소관 : </b>행정자치위원회</li>'
    + '<li><b>심의안건</b><br><div>1. 조례안</div></li></ul>';
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  try {
    const record = registry.upsert({ title: '행정자치위원회', page_url: 'https://www.youtube.com/watch?v=iEFwkmDzfzc', sources: ['https://www.youtube.com/watch?v=iEFwkmDzfzc'], video_id: 'iEFwkmDzfzc', kind: 'youtube' });
    registry.attach({ stream_id: 'ch2', broadcast_id: record.id }, { session_id: 'one' });
    store.saveSession({ stream_id: 'ch2', session_id: 'one', state: 'stopped', started_ms: Date.parse('2026-10-21T01:00:01Z') });
    const requested = [];
    const enricher = new ArchiveEnricher({ registry, fetchHtml: async url => { requested.push(url); return url.includes('seq=') ? detail : list; } });
    assert.deepEqual(await enricher.run(), [record.id]);
    assert.deepEqual(requested, ['https://www.council.jeju.kr/broadcast/broad.do', 'https://www.council.jeju.kr/broadcast/broad.do?act=view&seq=10035']);
    const filled = registry.get(record.id);
    assert.equal(filled.meeting_round, '제455회(2차)'); assert.equal(filled.scheduled_at, '2026-10-21 10:00'); assert.equal(filled.agenda, '1. 조례안');
    assert.ok(filled.sources.includes('https://www.council.jeju.kr/broadcast/broad.do?act=view&seq=10035'));
    assert.deepEqual(await enricher.run(), []);
  } finally { store.close(); }
});
