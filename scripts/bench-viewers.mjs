import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectViewers, viewerSummary } from './viewer-client.mjs';

const duration = Number(process.argv[2] ?? 30);
if (!Number.isInteger(duration) || duration < 5 || duration > 7200) throw new Error('Duration must be 5..7200 seconds');
const output = resolve(process.argv[3] ?? 'reports/viewers-' + Date.now()); mkdirSync(output, { recursive: true });
const token = randomBytes(32).toString('hex');
const child = fork(new URL('./bench-host.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
const command = async payload => { const reply = once(child, 'message'); child.send(payload); return (await reply)[0]; };
const start = await command({ action: 'start', database: output + '/events.sqlite',
  config: { adminToken: randomBytes(32).toString('hex'), viewerToken: token, maxClients: 350, maxBytes: 262144 } });
const base = 'http://127.0.0.1:' + start.port; const begun = Date.now();
const { viewers, connect_ms } = await connectViewers(base, token, 300);
const samples = []; let peakRss = 0;
try {
  for (let second = 0; second < duration; second++) {
    if (second === 5) viewers.slice(0, 10).forEach(v => v.response.pause());
    const sample = await command({ action: 'burst', rounds: second === 6 ? 20 : 1, padding: second === 6 ? 1000 : 0 });
    peakRss = Math.max(peakRss, sample.memory.rss); samples.push(sample);
    if (second === 8) viewers.slice(0, 10).forEach(v => v.response.resume());
    if (second === Math.floor(duration / 2)) {
      viewers.forEach(v => v.close());
      await new Promise(resolve => setTimeout(resolve, 100));
      await Promise.all(viewers.map(v => v.connect()));
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const final = await command({ action: 'metrics' });
  const deadline = Date.now() + 15000;
  while (viewers.some(v => v.count < final.events) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const summary = { test: 'C', source: 'synthetic transcript events; no STT or video', started_at: new Date(begun).toISOString(),
    duration_s: (Date.now() - begun) / 1000, connect_ms, produced_events: final.events,
    ...viewerSummary(viewers), missing_deliveries: viewers.reduce((n, v) => n + Math.max(0, final.events - v.count), 0),
    server_peak_rss_bytes: peakRss, server: final, slow_clients: 10, simultaneous_reconnects: 300 };
  writeFileSync(output + '/summary.json', JSON.stringify(summary, null, 2));
  writeFileSync(output + '/samples.json', JSON.stringify(samples, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally {
  viewers.forEach(v => v.close()); child.send({ action: 'stop' }); await once(child, 'exit');
}
