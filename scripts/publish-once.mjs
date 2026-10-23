// Publishes the current public minutes and site snapshot to the configured Vercel site once.
// Use when the live service runs with --manual (cloud sync off) and stored minutes changed.
// Usage: node scripts/publish-once.mjs [config.local.json]
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';
import { CouncilSchedule } from '../src/council-schedule.mjs';

const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.local.json', 'utf8'));
if (!config.cloudSyncFile) throw new Error('cloudSyncFile is not configured.');
const store = new Store(config.database); const registry = new BroadcastRegistry(store);
const schedule = new CouncilSchedule(); await schedule.refresh();
if (schedule.status.phase !== 'ready') throw new Error('Council schedule could not be loaded; the public schedule would be emptied.');
// Minutes are already rebuilt by the running service; this script only reads them.
const publisher = new CloudPublisher({ store, registry, schedule, config, minutes: { flush() {} }, scheduler: { states: () => [] } });
try {
  if (!publisher.settings) throw new Error(publisher.status.error ?? 'Cloud publication is not configured.');
  await publisher.flush({ force: true });
  console.log(JSON.stringify(publisher.view()));
  if (publisher.status.phase !== 'published') process.exitCode = 1;
} finally { await publisher.close(); await schedule.close(); store.close(); }
