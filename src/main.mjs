import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Store } from './store.mjs';
import { WhisperEngine } from './engine.mjs';
import { Scheduler } from './scheduler.mjs';
import { FileInputs } from './files.mjs';
import { createService } from './server.mjs';

const config = JSON.parse(readFileSync(resolve(process.argv[2] ?? 'config.local.json'), 'utf8'));
if (![5, 10].includes(config.chunkSeconds) || !Number.isInteger(config.queueChunks)
  || config.queueChunks < 2 || config.queueChunks > 24) throw new Error('Invalid chunk or queue configuration');
if (config.batch !== 1) throw new Error('This whisper-rs adapter supports batch 1 only');
if (!['cpu', 'gpu'].includes(config.device)) throw new Error('Invalid device');
if (!Number.isInteger(config.beam) || config.beam < 1 || config.beam > 8) throw new Error('Invalid beam');
if (!Number.isInteger(config.port ?? 4320) || (config.port ?? 4320) < 0 || (config.port ?? 4320) > 65535) throw new Error('Invalid port');
if (!Number.isFinite(config.silenceRms) || config.silenceRms < 0 || config.silenceRms > 0.02) throw new Error('Invalid silence threshold');
mkdirSync(dirname(resolve(config.database)), { recursive: true });
mkdirSync(dirname(resolve(config.engineLog)), { recursive: true });
const tokenFile = resolve(config.tokenFile);
if (!existsSync(tokenFile)) {
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify({ adminToken: randomBytes(32).toString('hex'),
    viewerToken: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
}
Object.assign(config, JSON.parse(readFileSync(tokenFile, 'utf8')));
if (!/^[a-f0-9]{64}$/.test(config.adminToken) || !/^[a-f0-9]{64}$/.test(config.viewerToken)
  || config.adminToken === config.viewerToken) throw new Error('Distinct 256-bit tokens required');
const store = new Store(config.database); store.recover();
const engine = new WhisperEngine(config);
const scheduler = new Scheduler(store, engine, config);
const inputs = new FileInputs(scheduler, config);
const service = createService({ store, scheduler, inputs, config, shutdown: () => stop().catch(error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
}) });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await inputs.close(); await scheduler.close(); if (service.server.listening) await service.close(); store.close();
}
process.on('SIGINT', () => stop().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }));
process.on('SIGTERM', () => stop().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }));
try {
  await engine.start();
  if (!stopping) {
    service.server.listen(config.port ?? 4320, '127.0.0.1'); await once(service.server, 'listening');
    process.stdout.write(JSON.stringify({ event: 'service.ready', url: 'http://127.0.0.1:' + service.server.address().port,
      engine: engine.metadata }) + '\n');
  }
} catch (error) {
  await stop(); process.stderr.write(error.message + '\n'); process.exitCode = 1;
}
