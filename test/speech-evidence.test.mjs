import test from 'node:test';
import assert from 'node:assert/strict';
import { nonSpeech } from '../src/silence-filter.mjs';
import { digitalSilence, nearSilence, speechActivity } from '../src/speech-activity.mjs';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';

test('brief real speech and repeated thanks survive the silence filter', () => {
  const spoken = { speaker_state: 'assigned', speaker_turns: [{ start_ms: 0, end_ms: 700 }] };
  for (const text of ['네.', '감사합니다. 감사합니다.', '그.', '시청해 주셔서 감사합니다.'])
    assert.equal(nonSpeech(text, spoken), false, text);
});
test('missing, pending and failed diarization are not evidence of silence', () => {
  for (const state of [null, { speaker_state: 'pending' }, { speaker_state: 'unavailable' }])
    assert.equal(nonSpeech('감사합니다. 감사합니다.', state), false);
});

// One 20 ms tone at the given level inside a second of digital silence.
const burst = (dbfs, at = 0) => {
  const pcm = Buffer.alloc(32000); const amplitude = 32768 * 10 ** (dbfs / 20) * Math.SQRT2;
  for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i / 4)), at + i * 2);
  return pcm;
};
test('acoustic silence bypasses recognition while quiet speech and detector failure remain eligible', async () => {
  const store = new Store(':memory:'); let called = 0;
  const engine = { ready: true, metadata: {}, transcribe: async () => { called++; return { spans: [{ text: '감사합니다.' }], inference_ms: 1 }; }, stop: async () => {} };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 8, speechGate: true });
  const activities = [{ state: 'silence', method: 'silero-vad' }, { state: 'speech', method: 'silero-vad' }, { state: 'unknown', method: 'silero-unavailable' }];
  scheduler.vad = { process: async () => activities.shift(), stop: async () => {} };
  // Quiet room tone above the -65 dBFS near-silence floor, so the detector result decides.
  const pcm = Buffer.alloc(32000); for (let n = 0; n < pcm.length; n += 2) pcm.writeInt16LE(n % 4 ? 400 : -400, n);
  try {
    const state = scheduler.start({ stream_id: 'ch0' });
    for (let seq = 0; seq < 15; seq++) scheduler.feed('ch0', { session_id: state.session_id, epoch: 0, seq, pcm });
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, 2);
    assert.equal(scheduler.metrics.silence, 1);
    assert.deepEqual(store.segments({ stream: 'ch0' }).items.map(r => r.raw_text), ['감사합니다.', '감사합니다.']);
  } finally { await scheduler.close(); store.close(); }
});

test('pre-inference gate skips digital and near silence but not quiet speech or an uncertain tail', async () => {
  const faint = Buffer.alloc(32000); faint.writeInt16LE(12, 0);
  assert.equal(digitalSilence(faint), false);
  assert.deepEqual(speechActivity(faint, { speaker_state: 'unavailable' }, { start_ms: 0, end_ms: 1000 }), { state: 'silence', method: 'near-silence' });
  // Recess noise floors in council recordings stayed below -65 dBFS; recognized speech peaked at -61.7 dBFS or louder.
  assert.equal(nearSilence(burst(-70)), true); assert.equal(nearSilence(burst(-62)), false);
  const pcm = burst(-62);
  assert.equal(speechActivity(pcm, { speaker_state: 'unavailable' }, { start_ms: 0, end_ms: 1000 }).state, 'unknown');
  const tail = burst(-40, 31360);
  assert.equal(speechActivity(tail, { speaker_state: 'pending', speaker_turns: [], processed_until_ms: 1000 },
    { start_ms: 0, end_ms: 1000 }).state, 'unknown');
  const store = new Store(':memory:'); let called = 0;
  const engine = { ready: true, metadata: {}, transcribe: async () => { called++; return { spans: [{ text: '네.' }], inference_ms: 1 }; }, stop: async () => {} };
  const scheduler = new Scheduler(store, engine, { chunkSeconds: 5, queueChunks: 8, silenceRms: 0, speechGate: true });
  try {
    const state = scheduler.start({ stream_id: 'ch0' });
    for (let seq = 0; seq < 5; seq++) scheduler.feed('ch0', { session_id: state.session_id, epoch: 0, seq, pcm: Buffer.alloc(32000) });
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, 0); assert.equal(store.segments({ stream: 'ch0' }).items.length, 0);
    scheduler.diarizer = { engine: { ready: true }, process: async () => ({ speaker_state: 'assigned', speaker_turns: [{ start_ms: 5000, end_ms: 5700 }] }), close: async () => {}, finish: async () => {} };
    // A recess noise floor is skipped even when the speaker check reports a voice.
    for (let seq = 5; seq < 10; seq++) scheduler.feed('ch0', { session_id: state.session_id, epoch: 0, seq, pcm: faint });
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, 0); assert.equal(scheduler.metrics.near_silence, 1);
    for (let seq = 10; seq < 15; seq++) scheduler.feed('ch0', { session_id: state.session_id, epoch: 0, seq, pcm });
    while (scheduler.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, 1); assert.equal(store.segments({ stream: 'ch0' }).items[0].raw_text, '네.');
  } finally { await scheduler.close(); store.close(); }
});
