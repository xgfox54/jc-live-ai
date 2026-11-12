import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { createDesktopLive } from '../src/desktop-live.mjs';
import { assertSupportedRuntime } from '../web/lib/runtime.mjs';
import { CouncilSchedule } from '../src/council-schedule.mjs';

assertSupportedRuntime();
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.local.json', 'utf8'));
const store = new Store(config.database, { readOnly: true });
const registry = new BroadcastRegistry(store);
const schedule = new CouncilSchedule();
const context = { config, store, registry, scheduler: { states: () => [], config },
  schedule };
const live = createDesktopLive(context);
if (!live) { store.close(); throw new Error('Desktop live is not configured'); }
let cursor = store.cursor();
const poll = setInterval(() => {
  const next = store.cursor();
  if (next !== cursor) { cursor = next; store.emit('event'); }
}, 250);
let closing = false;
async function close() {
  if (closing) return; closing = true; clearInterval(poll); await schedule.close(); await live.close(); store.close();
}
process.on('SIGINT', close); process.on('SIGTERM', close);
try { await live.start(); schedule.start(); console.log(JSON.stringify({ event: 'desktop.live_ready', port: live.server.address().port, readOnly: true, engineStarted: false })); }
catch (error) { await close(); throw error; }
