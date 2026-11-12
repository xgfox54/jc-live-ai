import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sources = {
  checked_on: '2026-10-25',
  blob: 'https://vercel.com/docs/vercel-blob/usage-and-pricing',
  cdn: 'https://vercel.com/docs/manage-cdn-usage',
};
export const freeLimits = { advanced_operations: 2000, simple_operations: 10000,
  blob_transfer_bytes: 10_000_000_000, cdn_requests: 1_000_000, storage_average_bytes: 1_000_000_000 };
export const defaults = { channels: 8, viewers: 300, hours_per_day: 8, days: 22, poll_seconds: 5,
  event_seconds: 10, min_snapshot_seconds: 1, archive_seconds: 300, periodic_seconds: 60,
  initial_snapshots: 1, extra_final_writes: 0, retry_fraction: 0, multipart: false, multipart_parts: 1,
  snapshot_blob_bytes: 10_000, archive_blob_bytes: 100_000, response_body_bytes: 20_000,
  not_modified_fraction: 0.5, additional_cdn_requests: 0, retained_average_bytes: 0,
  budget_fraction: 0.8, used: {} };

function settings(input) {
  for (const key of Object.keys(input)) if (!(key in defaults)) throw new Error('Unknown setting: ' + key);
  const s = { ...defaults, ...input };
  for (const [key, value] of Object.entries(s)) {
    if (key === 'used' || key === 'multipart') continue;
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid setting: ' + key);
  }
  for (const key of ['channels', 'viewers', 'days', 'initial_snapshots', 'extra_final_writes', 'multipart_parts'])
    if (!Number.isSafeInteger(s[key])) throw new Error('Integer required: ' + key);
  for (const key of ['hours_per_day', 'days', 'poll_seconds', 'event_seconds', 'min_snapshot_seconds', 'archive_seconds', 'periodic_seconds', 'multipart_parts'])
    if (s[key] <= 0) throw new Error('Positive value required: ' + key);
  if (s.channels < 1 || s.channels > 8 || s.hours_per_day > 24 || typeof s.multipart !== 'boolean'
    || s.not_modified_fraction > 1 || s.budget_fraction <= 0 || s.budget_fraction > 1)
    throw new Error('Settings outside supported range');
  if (!s.used || typeof s.used !== 'object' || Array.isArray(s.used)) throw new Error('Invalid used quota');
  for (const [key, value] of Object.entries(s.used))
    if (!(key in freeLimits) || !Number.isFinite(value) || value < 0) throw new Error('Invalid used quota: ' + key);
  return s;
}

export function idleSimulation({ hours = 24, days = 30, periodic_seconds = 60 } = {}) {
  if (![hours, days, periodic_seconds].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid idle interval');
  let baseline = 0;
  for (let second = periodic_seconds; second <= hours * 3600; second += periodic_seconds) baseline++;
  return { kind: 'arithmetic_simulation_not_publisher_execution', hours, days,
    baseline_recurring_writes: baseline, content_unchanged_recurring_writes: 0,
    baseline_monthly_recurring_writes: baseline * days, content_unchanged_monthly_recurring_writes: 0,
    initial_publication_excluded: true, excludes_health_state_changes: true };
}

function budget(use, s, activeHours) {
  return Object.fromEntries(Object.entries(use).map(([key, projected]) => {
    const included = freeLimits[key]; const used = s.used[key] ?? 0;
    const remaining = Math.max(0, included - used); const target = included * s.budget_fraction;
    const budgetRemaining = Math.max(0, target - used); const rate = projected / activeHours;
    return [key, { included, used, projected, budget_fraction: s.budget_fraction,
      within_budget: used + projected <= target, fraction_of_limit: (used + projected) / included,
      active_hours_to_budget: rate ? budgetRemaining / rate : null,
      active_hours_to_limit: rate ? remaining / rate : null,
      timing_basis: 'uniform_active_hour_rate_estimate; null means no modeled consumption' }];
  }));
}

export function monthlyUsage(input = {}) {
  const s = settings(input); const activeHours = s.hours_per_day * s.days; const seconds = activeHours * 3600;
  const polls = Math.ceil(seconds / s.poll_seconds); const browserRequests = s.viewers * polls;
  const mergedEvents = Math.ceil(seconds / Math.max(s.event_seconds, s.min_snapshot_seconds));
  const staggeredEvents = Math.min(Math.ceil(seconds * s.channels / s.event_seconds), Math.ceil(seconds / s.min_snapshot_seconds));
  const archiveBatches = Math.ceil(seconds / s.archive_seconds); const archiveWrites = archiveBatches * s.channels;
  const indexSnapshots = archiveBatches;
  const snapshotWrites = s.initial_snapshots + mergedEvents + indexSnapshots;
  const logicalWrites = snapshotWrites + archiveWrites + s.extra_final_writes;
  const retries = Math.ceil(logicalWrites * s.retry_fraction); const attempts = logicalWrites + retries;
  const multipartFactor = s.multipart ? 2 + s.multipart_parts : 1;
  const advanced = attempts * multipartFactor;
  const syncReads = attempts; const viewerReads = browserRequests;
  const rawWriteBytes = snapshotWrites * s.snapshot_blob_bytes + archiveWrites * s.archive_blob_bytes
    + s.extra_final_writes * s.archive_blob_bytes;
  const syncReadBytes = rawWriteBytes + retries * Math.max(s.snapshot_blob_bytes, s.archive_blob_bytes);
  const blobTransfer = viewerReads * s.snapshot_blob_bytes + syncReadBytes;
  const blobRequests = viewerReads + syncReads;
  const cdnRequests = browserRequests + attempts + blobRequests + s.additional_cdn_requests;
  const use = { advanced_operations: advanced, simple_operations: viewerReads + syncReads,
    blob_transfer_bytes: blobTransfer, cdn_requests: cdnRequests };
  return { kind: 'supplied_assumption_projection_not_billing', assumptions: s, active_hours: activeHours,
    viewer: { poll_cycles: polls, browser_requests: browserRequests, viewer_cdn_requests: browserRequests,
      function_invocations_without_cache_credit: browserRequests, blob_reads_without_overlap_credit: viewerReads,
      response_body_bytes: browserRequests * (1 - s.not_modified_fraction) * s.response_body_bytes,
      not_modified_responses: browserRequests * s.not_modified_fraction },
    publisher: { merged_snapshot_live_writes: mergedEvents, archive_writes: archiveWrites, index_snapshot_writes: indexSnapshots,
      initial_snapshot_writes: s.initial_snapshots, extra_final_writes: s.extra_final_writes,
      logical_writes: logicalWrites, retry_attempts: retries, sync_function_invocations: attempts,
      sync_cdn_requests: attempts, sync_blob_reads: syncReads, advanced_operations_upper: advanced,
      multipart_operations_per_attempt: multipartFactor, blob_upload_body_bytes_before_retry: rawWriteBytes,
      snapshot_event_staggered_upper: staggeredEvents, index_snapshot_staggered_upper: archiveWrites,
      logical_writes_staggered_upper: s.initial_snapshots + staggeredEvents + archiveWrites * 2 + s.extra_final_writes,
      baseline_periodic_snapshot_only: Math.ceil(seconds / s.periodic_seconds),
      baseline_event_plus_periodic_snapshot_upper: mergedEvents + Math.ceil(seconds / s.periodic_seconds),
      baseline_staggered_event_plus_periodic_snapshot_upper: staggeredEvents + Math.ceil(seconds / s.periodic_seconds) },
    total: { function_invocations: browserRequests + attempts, blob_read_requests: blobRequests,
      blob_cdn_requests: blobRequests, cdn_requests: cdnRequests, blob_transfer_body_bytes: blobTransfer,
      supplied_storage_average_bytes: s.retained_average_bytes },
    quotas: budget(use, s, activeHours),
    storage_within_budget: s.retained_average_bytes + (s.used.storage_average_bytes ?? 0) <= freeLimits.storage_average_bytes * s.budget_fraction,
    browser_only_max_viewers_at_budget: Math.floor(freeLimits.cdn_requests * s.budget_fraction / polls),
    qualifications: [
      'One merged site.json is published for all channels at each synchronized event opportunity.',
      'Archive documents change every archive interval; one index snapshot follows each aligned batch. Index and live overlaps are counted separately.',
      'Staggered channel events and archives can create more snapshot writes than the aligned default.',
      'Retry attempts are charged conservatively as writes; actual failures or idempotent retries may avoid writes. SDK internal retries are not modeled.',
      'Every storage read is modeled as a Blob cache miss. No production CDN or cross-instance coalescing savings are assumed.',
      'A 304 response removes its response body only; the application still reads Blob to validate its ETag.',
      'CDN total includes browser polls, sync POSTs and Blob reads. Static assets, extra endpoints and dashboard operations require additional inputs.',
      'Byte inputs are supplied compressed body sizes. Headers, request bodies, regional rates, CPU, memory, and Fast Data/Origin Transfer charges are not priced.',
      'Storage average is a separate supplied GB-month estimate; cumulative upload bytes are not retained storage.',
      'Budget durations use a uniform active-hour rate, not a prediction of an account reset or live exhaustion date.',
    ] };
}

export function cacheSensitivity({ viewers = 300, hours = 176, poll_seconds = 5 } = {}) {
  if (!Number.isSafeInteger(viewers) || viewers < 0 || !Number.isFinite(hours) || hours <= 0
    || !Number.isFinite(poll_seconds) || poll_seconds <= 0) throw new Error('Invalid sensitivity input');
  const polls = Math.ceil(hours * 3600 / poll_seconds);
  return Array.from({ length: 37 }, (_, index) => index + 1).flatMap(keys => [1, 4, 16].map(instances => {
    const originPerWave = Math.min(viewers, keys); const overlappingReads = Math.min(originPerWave, instances);
    return { selection_cache_keys: keys, active_instances: instances, browser_requests: viewers * polls,
      ideal_200_cdn_function_invocations: polls * originPerWave,
      baseline_blob_reads_after_ideal_cdn: polls * originPerWave,
      post_blob_reads_if_all_same_path_overlap_per_instance: polls * overlappingReads,
      unshared_function_and_blob_reads: viewers * polls,
      basis: 'Conditional sensitivity only: synchronized poll waves, one CDN region, cacheable 200 responses, one request per key; 304/errors or staggered requests can approach unshared counts.' };
  }));
}

export function usageReport(overrides = {}) {
  const s = settings(overrides);
  return { sources, free_limits: freeLimits, idle: idleSimulation(),
    scenarios: [1, 4, 8].flatMap(channels => [0, 1, 50, 300].map(viewers => monthlyUsage({ ...overrides, channels, viewers }))),
    cache_sensitivity: cacheSensitivity({ viewers: s.viewers, hours: s.hours_per_day * s.days, poll_seconds: s.poll_seconds }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? 'reports/cloud-usage-model.json');
  const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const report = usageReport(overrides); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, scenarios: report.scenarios.length, measured_billing: false }));
}
