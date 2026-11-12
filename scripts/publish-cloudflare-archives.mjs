import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';

const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
Object.assign(config, JSON.parse(readFileSync(config.tokenFile, 'utf8')));
config.cloudSyncFile = 'data/cloudflare-sync.secret';
const store = new Store(config.database), registry = new BroadcastRegistry(store);
const publisher = new CloudPublisher({ config, store, registry, minutes: { flush() {} }, getCorrectionAI: () => ({}) });
try {
  await publisher.flush({ force: true });
  const result = publisher.view();
  console.log(JSON.stringify({ host: publisher.settings && new URL(publisher.settings.endpoint).host, ...result }));
  if (result.phase !== 'published') process.exitCode = 1;
} finally { await publisher.close(); store.close(); }
