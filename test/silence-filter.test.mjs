import test from 'node:test';
import assert from 'node:assert/strict';
import { nonSpeech, collapseRepeats, publicSpeech } from '../src/silence-filter.mjs';
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
  } finally { await scheduler.close(); store.close(); }
});
