// Real-time 8-stream test of the production pipeline (engine pool, scheduler, live diarization, live AI correction)
// fed from accuracy-set recordings at 1 s per second. Uses its own database; nothing is published.
// Usage: node scripts/latency/live8.mjs <set-dir> <out-dir> <minutes> model=<ai model> [glossary=<file>]
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { Store } from '../../src/store.mjs';
import { EnginePool } from '../../src/engine.mjs';
import { Scheduler } from '../../src/scheduler.mjs';
import { LiveDiarization } from '../../src/live-diarization.mjs';
import { BroadcastRegistry } from '../../src/broadcast-registry.mjs';
import { CorrectionService } from '../../src/ai-correction.mjs';
import { LiveCorrection } from '../../src/live-correction.mjs';
import { AltEngine } from '../../src/alt-engine.mjs';
import { committees } from '../../public/committees.mjs';
import { cer, referenceText } from '../accuracy/metrics.mjs';

const [set, out, minutesArg, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.map(item => item.split('=')));
const minutes = Number(minutesArg ?? 10); await mkdir(out, { recursive: true });
if (await access(join(out, 'live.sqlite')).then(() => true, () => false)) throw new Error('Use a new output directory; prior runs must remain separate');
const base = JSON.parse(await readFile('config.local.json', 'utf8'));
const config = { ...base, database: join(out, 'live.sqlite'), engineLog: join(out, 'engine.log'), worker: options.worker ?? 'bin/jc-live-worker-next.exe',
  model: options.asr ?? 'models/ggml-large-v3-turbo-q8_0.bin', workers: Number(options.workers ?? 2), segmentSeconds: (options.seg ?? '6,8').split(',').map(Number),
  decode: { no_timestamps: false }, beam: 2, queueChunks: 12, silenceRms: 0, adminToken: 'a'.repeat(64) };
const manifest = JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8')).slice(0, Number(options.streams ?? 8));
const speakerGlossary = options.glossary ? JSON.parse(await readFile(options.glossary, 'utf8')) : {};
const store = new Store(config.database); const engine = new EnginePool(config); const scheduler = new Scheduler(store, engine, config);
if (config.liveDiarization) scheduler.diarizer = new LiveDiarization(store, config);
if (options.alt) scheduler.alt = new AltEngine({ ...config, altLog: join(out, 'alt.log'), altThreads: Number(options.altThreads ?? 4) });
const registry = new BroadcastRegistry(store);
const ai = new CorrectionService({ store, registry, scheduler, config });
ai.saveSettings({ model: options.model, refine_model: options.refine ?? '', automatic: true, auto_apply_safe: true, provider: 'proxy', base: options.base ?? 'http://127.0.0.1:10100/v1' });
const live = new LiveCorrection({ store, registry, ai, hedgeMs: Number(options.hedge ?? 3500) });
clearInterval(ai.timer);
await engine.start(); await scheduler.diarizer?.start(); await scheduler.alt?.start();
const streams = [];
for (const [index, item] of manifest.entries()) {
  const committee = committees.find(c => item.title.replace(/\s+/g, '').includes(c.name));
  const used = new Set(streams.map(s => s.stream_id));
  const stream_id = committee && !used.has(committee.stream_id) ? committee.stream_id : 'test' + index;
  const stream = { stream_id, name: item.title, kind: 'file' };
  const session = scheduler.start(stream); const broadcastId = registry.attach(stream, session);
  registry.save({ ...registry.get(broadcastId), speaker_glossary: speakerGlossary[item.fidx] ?? [] });
  streams.push({ ...item, stream_id, session_id: session.session_id, broadcastId, audio: await readFile(join(set, item.pcm)), seq: 0 });
}
const begin = Date.now(); const end = begin + minutes * 60_000; const samples = [];
let tick = 0; let cpuPrev = os.cpus();
while (tick < Math.ceil(minutes * 60)) {
  const wait = Math.min(end, begin + (tick + 1) * 1000) - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  for (const s of streams) {
    if (s.stopped) continue;
    const offset = tick * 32000;
    const last = Math.min(s.audio.length, offset + 32000, Math.floor(minutes * 60 * 16000) * 2);
    if (last > offset) scheduler.feed(s.stream_id, { session_id: s.session_id, epoch: 0, seq: s.seq++, pcm: s.audio.subarray(offset, last) });
    s.fed_s = last / 32000;
    if (last >= s.audio.length || last >= minutes * 60 * 32000) { scheduler.stop(s.stream_id); s.stopped = true; }
  }
  tick++;
  if (tick % 30 === 0) {
    const now = os.cpus(); let idle = 0; let total = 0;
    now.forEach((c, i) => { const p = cpuPrev[i].times; const t = c.times; for (const k of ['user', 'nice', 'sys', 'idle', 'irq']) total += t[k] - p[k]; idle += t.idle - p.idle; });
    cpuPrev = now;
    samples.push({ t: Math.round((Date.now() - begin) / 1000), cpu: Math.round(1000 * (1 - idle / total)) / 10, queues: scheduler.states().map(s => s.queue_length),
      live: { ...live.metrics } });
    console.log(JSON.stringify(samples.at(-1)));
  }
}
const stopAt = Date.now();
for (const s of streams) scheduler.stop(s.stream_id);
while (scheduler.busy || scheduler.finishes.size) await new Promise(resolve => setTimeout(resolve, 100));
await new Promise(resolve => setTimeout(resolve, options.refine ? 45000 : 15000)); await live.close();
const rows = store.db.prepare('SELECT s.id, s.session_id, s.document FROM segments s').all().map(row => ({ id: row.id, ...JSON.parse(row.document) }));
const corrections = new Map();
for (const row of store.db.prepare('SELECT segment_id, document FROM corrections ORDER BY version').all())
  corrections.set(row.segment_id, [...(corrections.get(row.segment_id) ?? []), JSON.parse(row.document)]);
const latency = []; const raw = []; const replaced = []; let unpublished = 0; const viewDelay = Number(options.view ?? 30000);
for (const row of rows) {
  // File samples are paced from begin; using enqueue time would hide time waiting in the segment buffer.
  const first = begin + row.start_ms;
  raw.push(row.ready_ms - first); row.first_ms = first;
  const list = corrections.get(row.id) ?? [];
  if (row.ai_corrected && list.length) latency.push(list[0].created_ms - first); else unpublished++;
  if (list.length > 1) replaced.push(list.at(-1).created_ms - first);
  row.at_view = list.filter(item => item.created_ms - first <= viewDelay).at(-1)?.text ?? '';
}
const stat = values => { const v = [...values].sort((a, b) => a - b); return v.length ? { n: v.length, mean: Math.round(v.reduce((s, x) => s + x, 0) / v.length),
  p50: v[Math.floor(v.length * .5)], p95: v[Math.floor(v.length * .95)], p99: v[Math.floor(v.length * .99)], max: v.at(-1),
  over15s: v.filter(x => x > 15000).length } : null; };
const accuracy = streams.map(s => {
  const mine = rows.filter(r => r.session_id === s.session_id).sort((a, b) => a.start_ms - b.start_ms);
  const fed = s.fed_s;
  const records = s.minutes; const ratio = fed / (s.end_s - s.start_s);
  const reference = referenceText(records); const cut = reference.slice(0, Math.floor(reference.length * Math.min(1, ratio)));
  const publicText = mine.map(r => r.ai_corrected ? r.corrected_text : '').join(' ');
  const rawText = mine.map(r => r.raw_text).join(' ');
  const viewText = mine.map(r => r.at_view).join(' ');
  return { fidx: s.fidx, stream_id: s.stream_id, fed_s: Math.round(fed), segments: mine.length,
    public: cer(cut, publicText, { trim: 60 }), raw: cer(cut, rawText, { trim: 60 }), view: cer(cut, viewText, { trim: 60 }) };
});
const pooled = key => { let e = 0; let n = 0; for (const a of accuracy) { const x = a[key]; e += x.substitutions + x.insertions + x.deletions; n += x.reference_chars - x.excluded_deletions; } return 1 - e / n; };
const summary = { started: new Date(begin).toISOString(), minutes, streams: streams.length, config: { model: config.model, workers: config.workers, segmentSeconds: config.segmentSeconds,
  ai: options.model, refine: options.refine ?? null, alt: Boolean(options.alt), hedge_ms: live.hedgeMs }, raw_latency_ms: stat(raw), public_latency_ms: stat(latency),
  replaced_latency_ms: stat(replaced), replaced_within_view: replaced.filter(value => value <= viewDelay).length, unpublished, live: live.metrics,
  scheduler: { jobs: scheduler.metrics.jobs, gaps: scheduler.metrics.gaps, errors: scheduler.metrics.errors, alt_errors: scheduler.metrics.alt_errors ?? 0 },
  latency_basis: 'paced source sample start, including segment buffering and EOF drain',
  alt_corrupt_segments: rows.filter(row => row.alt_text?.includes('\uFFFD')).length,
  diarization: scheduler.diarizer?.metrics ?? null,
  accuracy_public: pooled('public'), accuracy_at_view: pooled('view'), accuracy_raw: pooled('raw'),
  max_queue: Math.max(...samples.flatMap(s => s.queues)), cpu_max: Math.max(...samples.map(s => s.cpu)) };
await writeFile(join(out, 'result.json'), JSON.stringify({ summary, accuracy: accuracy.map(a => ({ ...a, public: { accuracy: a.public.accuracy },
  raw: { accuracy: a.raw.accuracy }, view: { accuracy: a.view.accuracy } })), samples }, null, 2));
console.log(JSON.stringify(summary));
await scheduler.close(); store.close(); process.exit(0);

