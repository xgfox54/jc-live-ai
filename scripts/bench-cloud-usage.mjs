import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { viewerRequest as currentViewer } from '../web/lib/http.mjs';
import { publicUpdate } from '../web/lib/model.mjs';
import { idleSimulation, usageReport } from './usage-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const channelIds = Array.from({ length: 8 }, (_, i) => 'ch' + i);
const choices = [[], ...channelIds.map(id => [id]), ...channelIds.flatMap((id, i) => channelIds.slice(i + 1).map(other => [id, other]))];

function fixture() {
  const snapshot = { event_id: 1, streams: channelIds.map(stream_id => ({ stream_id, name: '합성 회의 ' + stream_id, page_url: '' })),
    segments: channelIds.flatMap(stream_id => Array.from({ length: 40 }, (_, i) => ({ stream_id,
      session_id: 'synthetic-session', segment_id: stream_id + '-segment-' + i, start_ms: i * 10_000,
      end_ms: (i + 1) * 10_000, text: '사용량 측정을 위한 합성 발언입니다. '.repeat(5) + i,
      ai_corrected: true, sequence: i + 1, version: 1 }))),
    live_policy: 'whisper-draft-v1', live_segments: [], live_pending: [], states: [], health: [], gaps: [], before: {} };
  return publicUpdate({ kind: 'snapshot', published_ms: 1_700_000_000_000, snapshot, minutes_index: [] });
}

class MemoryStorage {
  constructor(value) {
    this.value = value; this.etag = 'fixture-v1'; this.reads = 0; this.bytes = 0; this.fail = false;
    this.compressedBytes = gzipSync(Buffer.from(JSON.stringify(value))).length;
  }
  async read(path) {
    this.reads++;
    await new Promise(resolve => setImmediate(resolve));
    if (this.fail) throw new Error('synthetic storage unavailable');
    if (path !== 'site.json') return null;
    this.bytes += this.compressedBytes;
    return { value: this.value, etag: this.etag };
  }
}

const request = (ids, etag) => new Request('https://synthetic.invalid/api/viewer/snapshot?text_streams=' + ids.join(','),
  { headers: etag ? { 'If-None-Match': etag } : {} });
function percentile(sorted, fraction) { return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]; }

async function burst({ viewer, storage, selections, tag, expectedStatus = 200 }) {
  const reads = storage.reads; const bytes = storage.bytes; const started = performance.now();
  const results = await Promise.all(Array.from({ length: 300 }, async (_, i) => {
    const began = performance.now(); const selected = selections[i % selections.length];
    const response = await viewer(request(selected, tag), { storage });
    const body = Buffer.from(await response.arrayBuffer()); const elapsed = performance.now() - began;
    assert.equal(response.status, expectedStatus);
    if (response.status === 200) {
      const value = JSON.parse(body.toString());
      assert.equal(value.streams.length, 8);
      assert.equal(value.segments.length, selected.length * 40);
      assert.ok(value.segments.every(item => selected.includes(item.stream_id)));
    }
    return { milliseconds: elapsed, bytes: body.length, hash: digest(body), etag: response.headers.get('etag') };
  }));
  const timings = results.map(item => item.milliseconds).sort((a, b) => a - b);
  return { requests: results.length, status: expectedStatus, blob_reads: storage.reads - reads,
    simulated_blob_compressed_bytes: storage.bytes - bytes, response_body_bytes: results.reduce((sum, item) => sum + item.bytes, 0),
    latency_ms: { p50: percentile(timings, .5), p95: percentile(timings, .95), p99: percentile(timings, .99) },
    wall_ms: performance.now() - started, response_hashes_digest: digest(results.map(item => item.hash).join(',')), first_etag: results[0].etag };
}

async function runVariant(viewer, expectedBurstReads) {
  const storage = new MemoryStorage(fixture());
  const cold = await burst({ viewer, storage, selections: [channelIds] });
  const unchanged = await burst({ viewer, storage, selections: [channelIds], tag: cold.first_etag, expectedStatus: 304 });
  const selections = await burst({ viewer, storage, selections: choices });
  for (const result of [cold, unchanged, selections]) assert.equal(result.blob_reads, expectedBurstReads);
  assert.equal(unchanged.response_body_bytes, 0);
  const before = storage.reads;
  const settled = await viewer(request(channelIds, cold.first_etag), { storage });
  assert.equal(settled.status, 304); assert.equal(storage.reads - before, 1);
  storage.value = structuredClone(storage.value); storage.value.snapshot.segments[0].text = '다음 합성 발언입니다.';
  storage.etag = 'fixture-v2';
  const fresh = await viewer(request(channelIds, cold.first_etag), { storage });
  assert.equal(fresh.status, 200); assert.notEqual(fresh.headers.get('etag'), cold.first_etag);
  assert.equal((await fresh.json()).segments[0].text, '다음 합성 발언입니다.');
  const broken = new MemoryStorage(fixture()); broken.fail = true;
  const healthy = new MemoryStorage(fixture()); const errors = []; const originalError = console.error;
  let failures;
  console.error = value => errors.push(String(value));
  try {
    const result = await Promise.all([
      burst({ viewer, storage: broken, selections: [channelIds], expectedStatus: 503 }),
      burst({ viewer, storage: healthy, selections: [channelIds] }),
    ]);
    assert.equal(result[0].blob_reads, expectedBurstReads); assert.equal(result[1].blob_reads, expectedBurstReads);
    failures = { failed: result[0], isolated_healthy: result[1], captured_error_events: errors.length };
  } finally { console.error = originalError; }
  broken.fail = false; const recovered = await viewer(request(channelIds), { storage: broken });
  assert.equal(recovered.status, 200); assert.equal(broken.reads, expectedBurstReads + 1);
  const mixed = new MemoryStorage(fixture());
  const [missing, present] = await Promise.all([
    viewer(new Request('https://synthetic.invalid/api/viewer/minutes/' + 'a'.repeat(64)), { storage: mixed }),
    viewer(request(channelIds), { storage: mixed }),
  ]);
  assert.equal(missing.status, 404); assert.equal(present.status, 200); assert.equal(mixed.reads, 2);
  return { cold, unchanged_304: unchanged, mixed_37_selections: selections, failures,
    fresh_etag_after_settlement: true, settled_304_reads: 1, recovery_status: recovered.status,
    distinct_path_statuses: [missing.status, present.status], distinct_path_reads: mixed.reads };
}

function captureBaseline(output) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const revision = git(['rev-parse', 'HEAD']).trim(); const directory = join(output, 'baseline-source');
  mkdirSync(directory, { recursive: true });
  const files = git(['ls-tree', '-r', '--name-only', revision, 'web/lib']).trim().split('\n').filter(path => path.endsWith('.mjs'));
  const hashes = {};
  for (const file of files) {
    const source = git(['show', revision + ':' + file]); const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source); hashes[file] = digest(source);
  }
  return { revision, hashes, http: join(directory, 'web/lib/http.mjs') };
}

export async function benchmark(output) {
  const started = new Date().toISOString();
  mkdirSync(output, { recursive: true }); const baseline = captureBaseline(output);
  const sourceHashes = Object.fromEntries(readdirSync(join(root, 'web/lib')).filter(name => name.endsWith('.mjs'))
    .map(name => ['web/lib/' + name, digest(readFileSync(join(root, 'web/lib', name)))]));
  const { viewerRequest: originalViewer } = await import(pathToFileURL(baseline.http).href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network forbidden in synthetic benchmark'); };
  let before; let after;
  try { before = await runVariant(originalViewer, 300); after = await runVariant(currentViewer, 1); }
  finally { globalThis.fetch = originalFetch; }
  for (const key of ['cold', 'unchanged_304', 'mixed_37_selections']) {
    assert.equal(after[key].response_hashes_digest, before[key].response_hashes_digest);
    assert.equal(after[key].response_body_bytes, before[key].response_body_bytes);
  }
  const report = { started_at: started, finished_at: new Date().toISOString(), runtime: process.version, baseline, current_source_sha256: sourceHashes,
    method: 'actual viewerRequest; 8 synthetic channels with 40 corrected segments each; 300 concurrent promises; one MemoryStorage per instance; setImmediate read latency',
    limitations: 'No HTTP listener, real network, Blob SDK, CDN, browser rendering, audio, AI inference or production latency measured. Byte counts exclude headers. Sequential variants have no statistical latency confidence claim.',
    before, after, idle_arithmetic_only: idleSimulation(), assertions_passed: true };
  writeFileSync(join(output, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  const model = usageReport({ snapshot_blob_bytes: gzipSync(Buffer.from(JSON.stringify(fixture()))).length,
    response_body_bytes: after.cold.response_body_bytes / 300 });
  model.byte_input_provenance = { snapshot: 'synthetic fixture gzip bytes', response: 'measured full eight-channel uncompressed response bytes', archive: 'supplied 100000 bytes, not measured' };
  writeFileSync(join(output, 'monthly-model.json'), JSON.stringify(model, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? '.omo/evidence/cloud-usage-20261025');
  const report = await benchmark(output);
  console.log(JSON.stringify({ output, baseline: report.baseline.revision, before: report.before.cold, after: report.after.cold, assertions_passed: report.assertions_passed }, null, 2));
}
