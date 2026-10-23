// Adds the whole-meeting digest (one-line summary, topics, time-ordered titles) to stored grounded summaries.
// Usage: node scripts/rebuild-digests.mjs [config.local.json] [--force] [--dry-run] [--regenerate] [--only=<broadcast id>]
// --regenerate rebuilds stale batch summaries from the current corrected text first (cached batches are reused).
// Run while the live service is stopped. Batch summaries, raw text and corrections are left unchanged.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService } from '../src/ai-correction.mjs';
import { ReviewService } from '../src/review.mjs';
import { digestFacts } from '../src/meeting-digest.mjs';

const args = process.argv.slice(2); const force = args.includes('--force'); const dryRun = args.includes('--dry-run'); const regenerate = args.includes('--regenerate');
const only = args.find(arg => arg.startsWith('--only='))?.slice(7);
const configPath = args.find(arg => !arg.startsWith('--')) ?? 'config.local.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const adminToken = JSON.parse(readFileSync(config.tokenFile, 'utf8')).adminToken;
const ready = await fetch('http://127.0.0.1:' + (config.port ?? 4320) + '/health/ready', { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
if (ready) throw new Error('Stop the live service first; this script writes review_state directly.');
const store = new Store(config.database); const registry = new BroadcastRegistry(store);
const ai = new CorrectionService({ store, registry, scheduler: { states: () => [] }, config: { adminToken, manualMode: true } });
const review = new ReviewService({ store, registry, correctionAI: ai });
const settings = ai.settings(); settings.model = settings.refine_model || settings.model;
if (!settings.model) throw new Error('관리자 후보정 모델을 먼저 설정해 주세요.');
const results = [];
try {
  for (const record of registry.list()) {
    if (only && record.id !== only) continue;
    let structured = review.get('structured:' + record.id);
    if (!structured || structured.scope !== 'published') continue;
    let current = registry.structuredCurrent(record.id, structured);
    if (!current && regenerate && !dryRun) {
      const started = Date.now(); review.start(record.id); await review.pending;
      const job = review.get('job:' + record.id);
      structured = review.get('structured:' + record.id); current = registry.structuredCurrent(record.id, structured);
      results.push({ id: record.id, title: record.title, regenerated: job.phase, batches: job.total, skipped_batches: job.skipped ?? 0, dropped_facts: job.dropped ?? 0, ms: Date.now() - started });
      if (job.phase !== 'completed') continue;
    }
    const facts = digestFacts(structured.notes, structured.sources);
    if (!current) { results.push({ id: record.id, title: record.title, skipped: 'stale_summary' }); continue; }
    if (structured.digest && !force) { results.push({ id: record.id, title: record.title, skipped: 'digest_exists' }); continue; }
    if (!facts.length) { results.push({ id: record.id, title: record.title, skipped: 'no_summary_facts' }); continue; }
    if (dryRun) { results.push({ id: record.id, title: record.title, facts: facts.length, groups: structured.notes.length }); continue; }
    const started = Date.now();
    const { digest, digest_error } = await review.digest(structured.notes, structured.sources, settings, new AbortController().signal);
    if (digest) review.save('structured:' + record.id, { ...structured, digest, digest_error: null, digest_model: settings.model, updated_ms: Date.now() });
    results.push({ id: record.id, title: record.title, facts: facts.length, groups: structured.notes.length, model: settings.model, ms: Date.now() - started,
      topics: digest?.topics.length ?? 0, overview_chars: digest?.overview.text.length ?? 0, error: digest_error,
      source_hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 12) });
  }
} finally { await review.close(); await ai.close(); store.close(); }
console.log(JSON.stringify({ model: settings.model, dryRun, results }, null, 2));
if (results.some(item => item.error)) process.exitCode = 1;
