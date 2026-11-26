import test from 'node:test';
import assert from 'node:assert/strict';
import { missingRanges, speechClusters, clusterOffset } from '../src/replay-recovery.mjs';

test('missing replay parts leave out covered time and parts under 20 seconds', () => {
  assert.deepEqual(missingRanges(600_000, [[0, 100_000], [110_000, 300_000], [290_000, 400_000]]), [[400_000, 600_000]]);
  assert.deepEqual(missingRanges(600_000, []), [[0, 600_000]]);
  assert.deepEqual(missingRanges(600_000, [[-5_000, 700_000]]), []);
});

test('speech after an hour of recess forms its own stretch', () => {
  const rows = [{ start_ms: 3_600_000, end_ms: 3_608_000 }, { start_ms: 10_000, end_ms: 18_000 }, { start_ms: 3_650_000, end_ms: 3_700_000 }, { start_ms: 20_000, end_ms: 25_000 }];
  assert.deepEqual(speechClusters(rows), [{ from_ms: 10_000, to_ms: 25_000 }, { from_ms: 3_600_000, to_ms: 3_700_000 }]);
});

test('a stretch is placed only by agreeing matches that make up half of its voiced probes', () => {
  const matched = offset_s => ({ status: 'matched', offset_s });
  assert.equal(clusterOffset([matched(12.04)]), 12040);
  assert.equal(clusterOffset([matched(12.04), matched(12.1), { status: 'silent' }]), 12100);
  assert.equal(clusterOffset([matched(12.04), matched(40)]), null);
  assert.equal(clusterOffset([matched(12.04), { status: 'ambiguous' }, { status: 'ambiguous' }]), null);
  assert.equal(clusterOffset([{ status: 'silent' }]), null);
});
