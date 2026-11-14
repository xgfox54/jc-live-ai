// Standby controller for a laptop that transcribes only while the desktop is down (docs/LAPTOP-STANDBY.md).
// Every 15 seconds it asks the Worker whether the desktop answers, writes the lease the engine checks, starts the
// engine after 60 seconds of confirmed desktop silence and shuts it down when the desktop answers again.
// Usage: node scripts/standby/laptop-standby.mjs [config.local.json]
import { readFileSync, writeFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { StandbyPolicy } from './standby-policy.mjs';
import { CLOUDFLARE_SITE } from '../../src/sites.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const configPath = resolve(root, process.argv[2] ?? 'config.local.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.cloudSyncFile || config.cloudSyncFiles?.length) throw new Error('Standby engine must not publish archives automatically');
if (!config.standbyLeaseFile) throw new Error('Set standbyLeaseFile in the standby engine configuration');
const site = process.env.JC_LIVE_SITE ?? CLOUDFLARE_SITE;
const state = resolve(root, 'data/standby'); mkdirSync(state, { recursive: true });
const token = JSON.parse(readFileSync(resolve(root, config.tokenFile), 'utf8')).adminToken;
const secret = readFileSync(resolve(state, 'gateway.secret'), 'utf8').trim();
const leasePath = resolve(root, config.standbyLeaseFile);
const engine = 'http://127.0.0.1:' + (config.port ?? 4320);
const policy = new StandbyPolicy();
let child = null, lastRole = '', stopping = false;
async function tick() {
  let desktop = null;
  try {
    const response = await fetch(site + '/api/failover', { headers: { 'X-JC-Laptop-Key': secret }, signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const data = await response.json();
      if (typeof data.desktop_ready === 'boolean' && Number.isFinite(data.checked_ms) && Math.abs(Date.now() - data.checked_ms) < 20000)
        desktop = data.desktop_ready;
    }
  } catch (error) { if (!(error instanceof Error)) throw error; }
  const active = policy.observe(desktop, Date.now());
  const role = active ? 'laptop' : desktop === true ? 'desktop' : 'waiting';
  writeFileSync(leasePath, JSON.stringify({ role, desktop_ready: desktop, checked_ms: Date.now(), valid_until: active ? Date.now() + 25000 : 0 }));
  if (role !== lastRole) { console.log(JSON.stringify({ event: 'standby.role', role, at: new Date().toISOString() })); lastRole = role; }
  let running = false;
  try { running = (await fetch(engine + '/health/live', { signal: AbortSignal.timeout(2000) })).ok; }
  catch (error) { if (!(error instanceof Error)) throw error; }
  if (!active && running) {
    const response = await fetch(engine + '/api/admin/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Standby shutdown HTTP ' + response.status);
  }
  if (active && !running && !child) {
    const out = openSync(resolve(state, 'engine.out.log'), 'a'), err = openSync(resolve(state, 'engine.err.log'), 'a');
    child = spawn(process.execPath, ['src/main.mjs', configPath], { cwd: root, windowsHide: true, stdio: ['ignore', out, err] });
    closeSync(out); closeSync(err);
    child.once('error', error => { console.error(JSON.stringify({ event: 'standby.start_failed', error: error.message })); child = null; });
    child.once('exit', () => { child = null; });
  }
}
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
while (!stopping) {
  try { await tick(); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    writeFileSync(leasePath, JSON.stringify({ role: 'waiting', valid_until: 0 }));
    console.error(JSON.stringify({ event: 'standby.check_failed', error: error.message }));
  }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
