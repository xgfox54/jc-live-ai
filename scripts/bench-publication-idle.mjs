import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? '.omo/evidence/publication-idle-20261025');
mkdirSync(output, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const source = execFileSync('git', ['show', revision + ':src/cloud-publisher.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
const adapted = source.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => "from '" + new URL(relative, new URL('../src/cloud-publisher.mjs', import.meta.url)).href + "'");
const baselinePath = resolve(output, 'baseline-publisher.mjs'); writeFileSync(baselinePath, adapted);
const { CloudPublisher: Baseline } = await import(pathToFileURL(baselinePath).href);
async function measure(Publisher) {
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  let now = 1792882800000, posts = 0, bytes = 0;
  store.saveStream({ stream_id: 'ch0', name: '합성 본회의', page_url: '' });
  const context = { store, registry, config: {}, scheduler: { states: () => [] }, minutes: { flush() {} }, now: () => now,
    settings: { endpoint: 'https://fixture.invalid/api/sync', secret: 'a'.repeat(64), interval_ms: 60000, minutes_interval_ms: 300000 },
    fetcher: async (_, options) => { posts++; bytes += options.body.length; return Response.json({ accepted: true }); } };
  let publisher = new Publisher(context);
  try {
    await publisher.flush(); const initial = { posts, bytes };
    for (let minute = 0; minute < 1440; minute++) { now += 60000; await publisher.flush({ force: true }); }
    await publisher.close(); publisher = new Publisher(context); await publisher.flush({ force: true });
    return { initial, recurring: { posts: posts - initial.posts, body_bytes: bytes - initial.bytes }, total: { posts, body_bytes: bytes },
      local_streams: store.streams().length, period_hours: 24, restart_checked: true };
  } finally { await publisher.close(); store.close(); }
}
const report = { baseline: revision, method: 'Actual publishers with virtual clock, in-memory SQLite, injected successful HTTP acknowledgement; no SDK or network',
  before: await measure(Baseline), after: await measure(CloudPublisher) };
if (report.after.recurring.posts !== 0 || report.after.local_streams !== 1) throw new Error('Idle publication regression');
const path = resolve(output, 'result.json'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
