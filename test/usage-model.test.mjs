import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyUsage, idleSimulation, usageReport, cacheSensitivity, freeLimits } from '../scripts/usage-model.mjs';

test('300 viewers polling every five seconds for 176 hours make 38,016,000 browser requests', () => {
  const report = monthlyUsage();
  assert.equal(report.active_hours, 176);
  assert.equal(report.viewer.browser_requests, 38_016_000);
  assert.equal(report.viewer.poll_cycles, 126_720);
  assert.equal(report.browser_only_max_viewers_at_budget, 6);
  assert.equal(report.viewer.function_invocations_without_cache_credit, 38_016_000);
});

test('merged snapshots are independent of channel count while archives scale per channel', () => {
  const one = monthlyUsage({ channels: 1, viewers: 0 }); const eight = monthlyUsage({ channels: 8, viewers: 0 });
  assert.equal(one.publisher.merged_snapshot_live_writes, 63_360);
  assert.equal(eight.publisher.merged_snapshot_live_writes, one.publisher.merged_snapshot_live_writes);
  assert.equal(eight.publisher.archive_writes, 16_896);
  assert.equal(eight.publisher.index_snapshot_writes, 2_112);
  assert.equal(eight.publisher.logical_writes, 82_369);
  assert.equal(eight.viewer.browser_requests, 0);
  assert.equal(eight.total.function_invocations, 82_369);
  assert.equal(eight.publisher.baseline_periodic_snapshot_only, 10_560);
  assert.equal(eight.publisher.baseline_event_plus_periodic_snapshot_upper, 73_920);
  assert.equal(eight.publisher.snapshot_event_staggered_upper, 506_880);
});

test('unchanged idle simulation excludes startup and reports recurring writes only', () => {
  assert.equal(idleSimulation().baseline_recurring_writes, 1_440);
  assert.equal(idleSimulation().baseline_monthly_recurring_writes, 43_200);
  assert.equal(idleSimulation().content_unchanged_monthly_recurring_writes, 0);
  assert.match(idleSimulation().kind, /not_publisher_execution/);
});

test('304 fraction only reduces body bytes and never removes storage reads or requests', () => {
  const full = monthlyUsage({ not_modified_fraction: 0 }); const unchanged = monthlyUsage({ not_modified_fraction: 1 });
  assert.equal(unchanged.viewer.response_body_bytes, 0);
  assert.equal(unchanged.total.blob_read_requests, full.total.blob_read_requests);
  assert.equal(unchanged.total.cdn_requests, full.total.cdn_requests);
  assert.equal(unchanged.total.blob_transfer_body_bytes, full.total.blob_transfer_body_bytes);
});

test('multipart and retries contribute conservative operations with one sync read per attempt', () => {
  const plain = monthlyUsage({ viewers: 0 });
  const repeated = monthlyUsage({ viewers: 0, retry_fraction: 0.1, multipart: true, multipart_parts: 3 });
  const attempts = plain.publisher.logical_writes + Math.ceil(plain.publisher.logical_writes * 0.1);
  assert.equal(repeated.publisher.advanced_operations_upper, attempts * 5);
  assert.equal(repeated.publisher.sync_blob_reads, attempts);
  assert.equal(repeated.total.cdn_requests, attempts * 2);
  assert.equal(plain.publisher.multipart_operations_per_attempt, 1);
});

test('80 percent headroom and active hours to quota use supplied existing usage', () => {
  const r = monthlyUsage({ viewers: 0, used: { advanced_operations: 400 } });
  const q = r.quotas.advanced_operations;
  assert.equal(q.included, 2000); assert.equal(q.within_budget, false);
  assert.equal(q.active_hours_to_budget, 1200 / (82_369 / 176));
  assert.equal(q.active_hours_to_limit, 1600 / (82_369 / 176));
  assert.equal(freeLimits.simple_operations, 10_000);
  assert.equal(freeLimits.blob_transfer_bytes, 10_000_000_000);
});

test('sensitivity retains instance and key assumptions without overwriting conservative totals', () => {
  const rows = cacheSensitivity();
  assert.equal(rows.length, 111);
  assert.equal(rows[0].ideal_200_cdn_function_invocations, 126_720);
  assert.equal(rows.at(-1).selection_cache_keys, 37);
  assert.equal(rows.at(-1).post_blob_reads_if_all_same_path_overlap_per_instance, 2_027_520);
  assert.equal(rows.at(-1).unshared_function_and_blob_reads, 38_016_000);
  assert.equal(usageReport().scenarios.length, 12);
  assert.equal(cacheSensitivity({ viewers: 0 })[0].ideal_200_cdn_function_invocations, 0);
  assert.equal(usageReport({ hours_per_day: 1, days: 1 }).cache_sensitivity[0].browser_requests, 216_000);
});

test('invalid assumptions fail instead of silently generating plausible totals', () => {
  for (const input of [{ channels: 9 }, { viewers: -1 }, { poll_seconds: 0 }, { event_seconds: NaN },
    { not_modified_fraction: 2 }, { multipart: 'yes' }, { hours_per_day: 25 }, { unknown: 1 },
    { used: { advanced_operations: -1 } }, { used: { unknown: 1 } }]) assert.throws(() => monthlyUsage(input));
  assert.throws(() => idleSimulation({ periodic_seconds: 0 }));
  assert.throws(() => cacheSensitivity({ viewers: -1 }));
});
