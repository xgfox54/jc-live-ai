import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { ReviewService } from '../src/review.mjs';
import { SpeakerDecisions, personIdentity } from '../src/speaker-decisions.mjs';
import { acousticFeatures, acousticOverlay, voiceCandidates, ACOUSTIC_METHOD } from '../src/speaker-acoustics.mjs';
import { identityAnchors, candidatesFor, finalSourceGuard, REVIEW_METHOD } from '../src/final-speakers.mjs';
import { peopleCandidates } from '../src/people-reference.mjs';
import { buildMinutes } from '../src/minutes.mjs';

const vector = n => Array.from({ length: 256 }, (_, i) => +(i === n));
const feature = (id, n = 0) => ({ segment_id: id, session_id: 'one', version: 2, cluster: 'one:voice-0', voiced_s: 6, purity: 1, mixed: false, vector: vector(n) });
const row = (id, text = '질의와 답변입니다.') => ({ segment_id: id, session_id: 'one', version: 2, timeline_epoch: 0,
  start_ms: +id.slice(1) * 10000, end_ms: (+id.slice(1) + 1) * 10000, speaker_id: 1, speaker_state: 'assigned', corrected_text: text });

test('offline features distinguish more than eight voices without changing stored live labels', () => {
  // Given: ten voices and the same reused streaming number.
  const rows = Array.from({ length: 10 }, (_, i) => row('s' + i));
  const raw = { method: ACOUSTIC_METHOD, features: rows.map((r, i) => ({ ...feature(r.segment_id, i), cluster: 'voice-' + i })) };
  // When: the whole-meeting view is built.
  const features = acousticFeatures(raw, rows); const result = acousticOverlay(rows, features);
  // Then: ten distinct offline identities remain local to the recording; originals are unchanged.
  assert.equal(new Set(result.map(r => r.speaker_id)).size, 10);
  assert.equal(rows.every(r => r.speaker_id === 1), true);
  assert.throws(() => acousticFeatures({ ...raw, features: [{ ...raw.features[0], session_id: 'other' }] }, rows));
});

test('voice enrollment needs two independent matching examples and refuses a close second name or mixed speech', () => {
  // Given: two reference speakers, one unknown matching a reference and one mixed segment.
  const rows = Array.from({ length: 7 }, (_, i) => row('s' + i));
  const features = rows.map((r, i) => feature(r.segment_id, i >= 2 && i <= 3 ? 1 : 0)); features[5].mixed = true;
  const assignments = { s0: personIdentity({ name: '홍길동', role: 'member' }), s1: personIdentity({ name: '홍길동', role: 'member' }),
    s2: personIdentity({ name: '김가람', role: 'official' }), s3: personIdentity({ name: '김가람', role: 'official' }) };
  // When: unknown speech is compared with meeting-local examples.
  const result = voiceCandidates(rows, features, assignments);
  // Then: clean matching speech is named and mixed speech is held.
  assert.equal(result.s4.name, '홍길동'); assert.equal(result.s5, undefined);
  assert.equal(voiceCandidates(rows, features, { s0: assignments.s0 }).s4, undefined);
  features[2].vector = vector(0); features[3].vector = vector(0);
  assert.equal(voiceCandidates(rows, features, assignments).s4, undefined);
});

function fixture(t) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const record = registry.upsert({ title: '시험', page_url: 'local:speakers', kind: 'file', sources: [], scheduled_at: '2026-10-23T14:00:00+09:00' });
  registry.attach({ stream_id: 'ch0', broadcast_id: record.id }, { session_id: 'one' });
  store.saveSession({ stream_id: 'ch0', session_id: 'one', state: 'stopped', input_end_reason: 'eof' });
  for (let i = 0; i < 3; i++) {
    const r = store.segment({ ...row('s' + i), segment_id: undefined, stream_id: 'ch0', raw_text: '발언 ' + i });
    store.correct(r.segment_id, { version: 1, text: '발언 ' + i, origin: 'ai' });
  }
  const review = new ReviewService({ store, registry, correctionAI: { settings: () => ({ automatic: false }) } });
  const decisions = new SpeakerDecisions({ review, registry, store });
  t.after(async () => { await review.close(); store.close(); });
  const rows = registry.publishedSegments(record.id);
  review.save('speaker-acoustics:' + record.id, { signature: 'analysis', phase: 'complete', missing: [], features: rows.map(r => ({ ...feature(r.segment_id), version: r.version })) });
  const input = { version: 0, analysis_version: 'analysis', segment_id: rows[0].segment_id, segment_version: rows[0].version, name: '홍길동', role: 'member', mode: 'similar' };
  return { store, registry, review, decisions, rows, id: record.id, input };
}

test('administrator confirms selected similar speech, splits a wrong group and reverses changes without editing source', async t => {
  // Given: an offline group whose streaming number is not trustworthy.
  const f = fixture(t); const original = f.registry.segments(f.id);
  const selected = { ...f.input, mode: 'selected', segment_ids: [f.rows[1].segment_id] };
  const preview = f.decisions.preview(f.id, selected);
  // When: only the checked subset is confirmed.
  f.decisions.apply(f.id, { ...selected, confirmation: preview.confirmation });
  // Then: unchecked speech remains unresolved and raw storage is untouched.
  assert.equal(f.registry.finalSpeakers(f.id).assigned, 2);
  assert.equal(f.registry.finalSpeakers(f.id).assignments[f.rows[2].segment_id], undefined);
  assert.deepEqual(f.registry.segments(f.id), original);
  const one = { ...f.input, version: 1, mode: 'one', name: '김가람', segment_id: f.rows[1].segment_id };
  f.decisions.apply(f.id, { ...one, confirmation: f.decisions.preview(f.id, one).confirmation });
  assert.equal(f.registry.finalSpeakers(f.id).assignments[f.rows[1].segment_id].name, '김가람');
  f.decisions.undo(f.id, { version: 2 });
  assert.equal(f.registry.finalSpeakers(f.id).assignments[f.rows[1].segment_id].name, '홍길동');
  assert.equal(f.decisions.current(f.id).version, 3);
});

test('confirmation rejects stale edits, foreign meeting segments, changed analysis and unpreviewed requests', t => {
  // Given: a reviewable meeting and valid preview data.
  const f = fixture(t);
  // When/Then: crossing each confirmation boundary is rejected before any write.
  assert.throws(() => f.decisions.apply(f.id, f.input), { status: 409 });
  assert.throws(() => f.decisions.preview(f.id, { ...f.input, version: 4 }), { status: 409 });
  assert.throws(() => f.decisions.preview(f.id, { ...f.input, analysis_version: 'stale' }), { status: 409 });
  assert.throws(() => f.decisions.preview(f.id, { ...f.input, segment_id: 'foreign' }), { status: 404 });
  const preview = f.decisions.preview(f.id, f.input);
  const expected_segments = preview.items.map(({ segment_id, version }) => ({ segment_id, version }));
  f.store.correct(f.rows[1].segment_id, { version: f.rows[1].version, text: '변경한 내용', origin: 'manual' });
  assert.throws(() => f.decisions.preview(f.id, { ...f.input, mode: 'selected', segment_ids: expected_segments.map(r => r.segment_id), expected_segments }), { status: 409 });
  assert.throws(() => f.decisions.apply(f.id, { ...f.input, confirmation: preview.confirmation }), { status: 409 });
  assert.equal(f.decisions.current(f.id).version, 0);
});

test('dated attendance overrides historical titles, excludes future and unrelated officials, and stores provenance', t => {
  // Given: the exact meeting, a later appointment and another committee on the same day.
  const f = fixture(t);
  const directory = { meetings: [
    { fidx: 1, date: '2026-10-23', title: '2026-10-23 본회의', labels: ['복지가족국장 홍길동', '과장 김가람'] },
    { fidx: 2, date: '2026-10-24', title: '본회의', labels: ['복지가족국장 미래인'] },
    { fidx: 3, date: '2026-10-23', title: '교육위원회', labels: ['교육장 다른인'] },
  ] };
  // When: candidates are resolved for the plenary on October 23.
  const people = peopleCandidates({ committee: '본회의', scheduled_at: '2026-10-23', stream_id: 'ch0' }, directory);
  // Then: only the exact meeting's people have attendance evidence.
  assert.equal(people.find(p => p.name === '홍길동').attendance, true);
  assert.equal(people.find(p => p.name === '김가람').attendance, true);
  assert.equal(people.some(p => p.name === '미래인'), false);
  assert.equal(people.some(p => p.name === '다른인'), false);
  assert.throws(() => f.decisions.roster(f.id, { version: 0, people: [{ name: '홍길동', role: 'official', title: '국장', as_of: '2026-10-24', source: '확인 문서' }] }), { status: 400 });
});

test('explicit answer requests connect the next official, while ordinary mentions and unchanged voice do not', () => {
  // Given: a dated official and a clear change from questioner to answerer.
  const people = [{ name: '홍길동', role: 'official', title: '복지가족국장', attendance: true }];
  const rows = [row('s0', '복지가족국장님 답변해 주시기 바랍니다.'), { ...row('s1', '답변드리겠습니다.'), speaker_id: 2 }];
  // When: conversational evidence is derived.
  const anchors = identityAnchors(rows, people);
  // Then: the reply is eligible, and the questioner is not named as the official.
  assert.equal(candidatesFor(0, rows, anchors).length, 0);
  assert.equal(candidatesFor(1, rows, anchors)[0].name, '홍길동');
  rows[1].speaker_id = 1; assert.equal(identityAnchors(rows, people).some(a => a.kind === 'reply'), false);
});

test('manual rejection removes a final name from public minutes and stale source edits invalidate manual claims', t => {
  // Given: a segment confirmed by an administrator.
  const f = fixture(t); const input = { ...f.input, mode: 'one' };
  f.decisions.apply(f.id, { ...input, confirmation: f.decisions.preview(f.id, input).confirmation });
  // When: the same segment is explicitly set to unknown.
  const clear = { ...input, version: 1, name: null };
  f.decisions.apply(f.id, { ...clear, confirmation: f.decisions.preview(f.id, clear).confirmation });
  // Then: no name is published, and editing the source invalidates the decision as well.
  const value = buildMinutes(f.registry.get(f.id), f.registry.sessions(f.id), f.rows, [], { finalSpeakers: f.registry.finalSpeakers(f.id) });
  assert.equal(value.transcript[0].speaker_name, null);
  f.store.correct(f.rows[0].segment_id, { version: f.rows[0].version, text: '수정', origin: 'manual' });
  assert.equal(f.registry.finalSpeakers(f.id), null);
});
