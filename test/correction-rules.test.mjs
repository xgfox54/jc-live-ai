import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService, correctionIssue, ISSUE_RULES } from '../src/ai-correction.mjs';

test('a digit Whisper wrote inside a misheard word is not an amount when the candidate writes the word out', () => {
  for (const [raw, candidate] of [
    ['지금부터 제456회 제2특별아치도위의 제2차 장례회 문화안강체육위원회', '지금부터 제456회 제주특별자치도의회 제2차 정례회 문화관광체육위원회'],
    ['의사일정 제6항 제6시 문화관광체육국 업무제휴협약', '의사일정 제6항 제주시 문화관광체육국 업무제휴협약'],
    ['제주시 3도 1동 3도 2동을 지역으로는 정민구 의원입니다.', '제주시 삼도1동·삼도2동을 지역구로 둔 정민구 의원입니다.'],
    ['제주시 이도이동 갑을 지역구로 두고 있는 김기환 의원입니다.', '제주시 이도2동갑을 지역구로 두고 있는 김기환 의원입니다.'],
    ['사업으로 2월액이 발생하고 있는 상황에서', '사업으로 이월액이 발생하고 있는 상황에서'],
    ['발언대로 나오셔서 1문 1답 방식으로 질문해 주시기 바랍니다.', '발언대로 나오셔서 일문일답 방식으로 질문해 주시기 바랍니다.'],
  ]) assert.equal(correctionIssue(raw, candidate), null, raw);
  // A candidate that changes the digit, or a word the rules do not cover, still waits for the administrator.
  for (const [raw, candidate] of [
    ['의사일정 제6항 제6시 문화관광체육국', '의사일정 제6항 제7시 문화관광체육국'],
    ['제2특별위원회 위원장입니다.', '제주특별위원회 위원장입니다.'],
    ['제주시 3도 1동 주민입니다.', '제주시 삼도2동 주민입니다.'],
    ['2월에 집행했습니다.', '이월에 집행했습니다.'],
  ]) assert.equal(correctionIssue(raw, candidate), 'numbers', raw);
});

function fixture(t) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const scheduler = { states: () => [], channels: new Map() };
  const page_url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const record = registry.upsert({ page_url, sources: [page_url], title: '후보정 규칙 시험', kind: 'youtube' });
  registry.attach({ stream_id: 'ch1', broadcast_id: record.id }, { session_id: 'one' });
  store.saveSession({ stream_id: 'ch1', session_id: 'one', state: 'stopped' });
  // The first service creates the candidate tables; candidates are then stored as earlier rules left them.
  new CorrectionService({ store, registry, scheduler }).close();
  let count = 0;
  const candidate = (segment, value) => {
    const document = { id: 'c' + ++count, broadcast_id: record.id, segment_id: segment.segment_id, source_version: segment.version,
      source_text: segment.raw_text, status: 'pending', start_ms: 0, end_ms: 10000, created_ms: count, ...value };
    store.db.prepare('INSERT INTO ai_candidates VALUES(?,?,?,?,?,?)').run(document.id, record.id, segment.segment_id, document.source_version, 'context', JSON.stringify(document));
    return document;
  };
  const add = text => store.segment({ stream_id: 'ch1', session_id: 'one', start_ms: 0, end_ms: 10000, raw_text: text });
  const open = () => { const ai = new CorrectionService({ store, registry, scheduler }); t.after(() => ai.close()); return ai; };
  t.after(() => store.close());
  return { store, registry, id: record.id, candidate, add, open, read: id => JSON.parse(store.db.prepare('SELECT document FROM ai_candidates WHERE id=?').get(id).document),
    text: id => JSON.parse(store.db.prepare('SELECT document FROM segments WHERE id=?').get(id).document).corrected_text };
}

test('candidates held under earlier rules are checked again at start and published by the automatic pass', async t => {
  const f = fixture(t);
  const opening = f.add('지금부터 제456회 제2특별아치도위의 제2차 장례회');
  const held = f.candidate(opening, { text: '지금부터 제456회 제주특별자치도의회 제2차 정례회', issue: 'numbers' });
  const amount = f.add('예산은 100원입니다.');
  const changed = f.candidate(amount, { text: '예산은 200원입니다.', issue: 'numbers' });
  const ai = f.open();
  assert.equal(f.read(held.id).issue, null); assert.equal(f.read(held.id).issue_rules, ISSUE_RULES);
  assert.equal(f.read(changed.id).issue, 'numbers');
  assert.deepEqual(await ai.applySafe(f.id), { applied: 1, skipped: 1 });
  assert.equal(f.text(opening.segment_id), held.text); assert.equal(f.text(amount.segment_id), null);
});

test('a refinement of a public sentence is left for the administrator when the rules change', async t => {
  const f = fixture(t);
  const segment = f.add('1문 1답 방식으로 질문해 주시기 바랍니다.');
  const published = f.store.correct(segment.segment_id, { version: segment.version, text: '1문 1답 방식으로 질문해 주시기 바랍니다.', origin: 'ai' });
  const refine = f.candidate(published, { text: '일문일답 방식으로 질문해 주시기 바랍니다.', issue: 'numbers', refine: true });
  f.open();
  assert.equal(f.read(refine.id).issue, 'numbers'); assert.equal(f.read(refine.id).issue_rules, undefined);
});

test('the newest of several waiting candidates is applied and the others close as superseded', async t => {
  const f = fixture(t);
  const segment = f.add('돌봄 써비스 예산입니다.');
  const older = f.candidate(segment, { text: '돌봄 서비스 예산입니다', issue: null });
  const newer = f.candidate(segment, { text: '돌봄 서비스 예산입니다.', issue: null });
  const ai = f.open();
  await ai.applySafe(f.id);
  assert.equal(f.text(segment.segment_id), newer.text);
  assert.equal(f.read(newer.id).status, 'applied'); assert.equal(f.read(older.id).issue, 'superseded');
});

test('the administrator lists only candidates waiting for review and applies the checked ones together', async t => {
  const f = fixture(t);
  const one = f.add('재석 위원 10명입니다.'); const two = f.add('예산은 100원입니다.');
  const first = f.candidate(one, { text: '재석 위원 11명입니다.', issue: 'numbers' });
  const second = f.candidate(two, { text: '예산은 200원입니다.', issue: 'numbers' });
  const ai = f.open();
  const waiting = ai.list(f.id, Number.MAX_SAFE_INTEGER, true);
  assert.deepEqual(waiting.items.map(item => item.id), [second.id, first.id]); assert.equal(waiting.before, null);
  assert.throws(() => ai.applyChecked([]), { status: 400 });
  assert.deepEqual(ai.applyChecked([first.id, first.id, second.id]), { applied: 2, skipped: 0 });
  assert.equal(f.text(one.segment_id), first.text); assert.equal(ai.list(f.id, Number.MAX_SAFE_INTEGER, true).items.length, 0);
  assert.deepEqual(ai.applyChecked([first.id]), { applied: 0, skipped: 1 });
});
