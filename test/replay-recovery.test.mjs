import test from 'node:test';
import assert from 'node:assert/strict';
import { missingRanges, coveredRanges } from '../src/replay-recovery.mjs';

test('missing replay parts leave out covered time and parts under 20 seconds', () => {
  assert.deepEqual(missingRanges(600_000, [[0, 100_000], [110_000, 300_000], [290_000, 400_000]]), [[400_000, 600_000]]);
  assert.deepEqual(missingRanges(600_000, []), [[0, 600_000]]);
  assert.deepEqual(missingRanges(600_000, [[-5_000, 700_000]]), []);
});

test('aligned sessions map their collection time onto the replay clock', () => {
  const alignment = { phase: 'complete', sessions: {
    a: { offset_ms: 3_600_000 },
    b: { offset_ms: 0, ranges: [{ from_ms: 0, to_ms: 60_000, offset_ms: 7_200_000 }, { from_ms: 90_000, to_ms: null, offset_ms: 7_230_000 }] } } };
  const sessions = [{ session_id: 'a' }, { session_id: 'b' }, { session_id: 'c' }];
  const covered = coveredRanges(alignment, sessions, session => ({ a: 1_200_000, b: 300_000 })[session.session_id]);
  assert.deepEqual(covered, [[3_600_000, 4_800_000], [7_200_000, 7_260_000], [7_320_000, 7_530_000]]);
  assert.deepEqual(coveredRanges({ phase: 'running', sessions: alignment.sessions }, sessions, () => 1), []);
});
