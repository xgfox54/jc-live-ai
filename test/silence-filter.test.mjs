import test from 'node:test';
import assert from 'node:assert/strict';
import { nonSpeech, collapseRepeats, publicSpeech, stripInvented, publicText } from '../src/silence-filter.mjs';
import { hallucination } from '../src/ai-correction.mjs';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';

const voiced = ms => ({ speaker_state: 'assigned', speaker_turns: [{ speaker_id: 1, start_ms: 0, end_ms: ms }] });
const silent = { speaker_state: 'unknown', speaker_turns: [] };

test('repeated courtesy phrases are silence artifacts; a spoken single thank-you is kept', () => {
  assert.equal(nonSpeech('감사합니다 감사합니다 감사합니다 감사합니다', silent), true);
  assert.equal(nonSpeech('감사합니다. 감사합니다.', voiced(8000)), false);
  assert.equal(nonSpeech('네, 네, 네.', silent), true);
  assert.equal(nonSpeech('감사합니다.', silent), true);
  assert.equal(nonSpeech('감사합니다.', voiced(2500)), false);
  assert.equal(nonSpeech('감사합니다.', null), false);
  assert.equal(nonSpeech('질의해 주셔서 감사합니다.', silent), false);
  assert.equal(nonSpeech('그.', voiced(8000)), false); assert.equal(nonSpeech('음… 어.', silent), true);
  assert.equal(nonSpeech('네.', voiced(2500)), false); assert.equal(nonSpeech('그 부분은 검토하겠습니다.', silent), false);
  assert.equal(collapseRepeats('이상입니다. 감사합니다. 감사합니다. 감사합니다. 감사합니다.'), '이상입니다. 감사합니다.');
  assert.equal(collapseRepeats('감사합니다. 감사합니다.'), '감사합니다. 감사합니다.');
  assert.equal(hallucination('감사합니다 감사합니다 감사합니다', silent), true); assert.equal(hallucination('감사합니다.'), false);
  assert.equal(nonSpeech('시청해주셔서 감사합니다.', voiced(8000)), false);
  assert.equal(nonSpeech('시청해 주셔서 감사합니다. 시청해 주셔서 감사합니다.', silent), true);
  assert.equal(nonSpeech('MBC 뉴스 김성현입니다.', silent), true); assert.equal(nonSpeech('구독과 좋아요 부탁드립니다.', silent), true);
  assert.equal(nonSpeech('오늘 회의를 시청해 주셔서 감사합니다. 다음 안건으로 넘어가겠습니다.', null), false);
  assert.equal(publicSpeech({ corrected_text: '감사합니다. 감사합니다. 감사합니다.', speaker_state: 'unknown', speaker_turns: [] }), false);
  assert.equal(publicSpeech({ corrected_text: '안건을 상정합니다.', speaker_state: 'unknown', speaker_turns: [] }), true);
  // A recess loop: three or more courtesy phrases alone, while the speaker check is pending or even reports voice.
  assert.equal(nonSpeech('감사합니다. 감사합니다. 감사합니다. 감사합니다. 감사합니다.', { speaker_state: 'pending', speaker_turns: [] }), true);
  assert.equal(nonSpeech('감사합니다. 감사합니다. 감사합니다.', voiced(8000)), true);
  assert.equal(publicSpeech({ corrected_text: '감사합니다. 감사합니다. 감사합니다. 감사합니다.', speaker_state: 'unknown' }), false);
});

test('phrases Whisper invents over music are hidden or cut out; real sentences with the same words stay', () => {
  for (const text of ['아멘 아멘 아멘', '찬송가 5장.', '찬송가', '한글자막 by 한효정', '(박수)', '다음 영상에서 만나요!',
    'MBC 뉴스 김지경입니다.', '감사합니다. 감사합니다. 감사합니다. 아멘.', '아멘 아멘 한글자막 by 한효정', '자막제공자'])
    assert.equal(nonSpeech(text, voiced(8000)), true, text);
  for (const text of ['찬송가 소음 민원이 있습니다.', '청각장애인을 위한 자막 제공 예산입니다.', '연합뉴스 변지철 기자입니다.', '박수를 쳐 주시기 바랍니다.'])
    assert.equal(nonSpeech(text, voiced(8000)), false, text);
  assert.equal(stripInvented('다음은 애국가를 부르겠습니다. 찬송가 2장'), '다음은 애국가를 부르겠습니다.');
  assert.equal(stripInvented('의사일정 제1항을 상정합니다. MBC 뉴스 김성현입니다.'), '의사일정 제1항을 상정합니다.');
  assert.equal(stripInvented('투표를 다 하셨습니까? 아멘'), '투표를 다 하셨습니까?');
  // Public text writes 제주 4.3 as 4.3 and leaves other numbers alone.
  assert.equal(publicText('사삼 교육팀과 제주사삼, 4·3 역사'), '4.3 교육팀과 제주4.3, 4.3 역사');
  assert.equal(publicText('검사삼 단계, 14·3 구역, 4·30 기준, 4.3km'), '검사삼 단계, 14·3 구역, 4·30 기준, 4.3km');
  // A correction written from invented phrases ("아멘" corrected to "(애국가 제창)") stays hidden.
  assert.equal(publicSpeech({ raw_text: '아멘 아멘 아멘 아멘 아멘', corrected_text: '(애국가 제창)', speaker_state: 'unknown', speaker_turns: [] }), false);
});

test('scheduler stores nothing for a silent chunk recognized as repeated thank-you', async () => {
  const store = new Store(':memory:'); let reply = '감사합니다 감사합니다 감사합니다 감사합니다';
  const engine = { ready: true, metadata: {}, transcribe: async () => ({ spans: [{ text: reply }], inference_ms: 1 }), stop: async () => {} };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 8, silenceRms: 0 });
  scheduler.diarizer = { engine: { ready: true }, process: async () => silent, finish: async () => {}, close: async () => {} };
  try {
    const state = scheduler.start({ stream_id: 'ch2' });
    const feed = async seq => { scheduler.feed('ch2', { session_id: state.session_id, epoch: 0, seq, pcm: Buffer.alloc(32000) }); };
    for (let seq = 0; seq < 5; seq++) await feed(seq);
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.segments({ stream: 'ch2' }).items.length, 0); assert.equal(scheduler.metrics.silence_artifacts, 1);
    reply = '다음 안건을 상정합니다. 감사합니다. 감사합니다. 감사합니다.';
    scheduler.diarizer.process = async () => voiced(3000);
    for (let seq = 5; seq < 10; seq++) await feed(seq);
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.segments({ stream: 'ch2' }).items[0].raw_text, reply);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM recognition_suppressed').get().n, 1);
    // During a recess the speaker check is still pending when Whisper loops the courtesy phrase over room noise.
    reply = '감사합니다. 감사합니다. 감사합니다. 감사합니다. 감사합니다.';
    scheduler.diarizer.process = async () => ({ speaker_state: 'pending', speaker_turns: [] });
    for (let seq = 10; seq < 15; seq++) await feed(seq);
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.segments({ stream: 'ch2' }).items.length, 1); assert.equal(scheduler.metrics.silence_artifacts, 2);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM recognition_suppressed').get().n, 2);
  } finally { await scheduler.close(); store.close(); }
});

test('scheduler cuts an invented sign-off from real speech and keeps the recognized text', async () => {
  const store = new Store(':memory:'); const recognized = '다음 안건을 상정합니다. MBC 뉴스 김성현입니다.';
  const engine = { ready: true, metadata: {}, transcribe: async () => ({ spans: [{ text: recognized }], inference_ms: 1 }), stop: async () => {} };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 8, silenceRms: 0 });
  scheduler.diarizer = { engine: { ready: true }, process: async () => voiced(3000), finish: async () => {}, close: async () => {} };
  try {
    const state = scheduler.start({ stream_id: 'ch2' });
    for (let seq = 0; seq < 5; seq++) scheduler.feed('ch2', { session_id: state.session_id, epoch: 0, seq, pcm: Buffer.alloc(32000) });
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    const [row] = store.segments({ stream: 'ch2' }).items;
    assert.equal(row.raw_text, '다음 안건을 상정합니다.'); assert.equal(row.recognized_text, recognized);
  } finally { await scheduler.close(); store.close(); }
});
