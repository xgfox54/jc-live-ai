import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Store } from './store.mjs';
import { EnginePool } from './engine.mjs';
import { Scheduler } from './scheduler.mjs';
import { FileInputs } from './files.mjs';
import { createService } from './server.mjs';
import { initializeCommitteeChannels } from './committees.mjs';
import { LiveDiarization } from './live-diarization.mjs';
import { AcousticVad } from './acoustic-vad.mjs';
import { assertSupportedRuntime } from '../web/lib/runtime.mjs';

assertSupportedRuntime();
const configPath = resolve(process.argv[2] ?? 'config.local.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
// A standby laptop runs only while its standby controller holds a valid lease: desktop transcription has priority
// (docs/LAPTOP-STANDBY.md). Without standbyLeaseFile the engine starts as before.
const standbyLease = () => {
  if (!config.standbyLeaseFile) return true;
  try {
    const lease = JSON.parse(readFileSync(config.standbyLeaseFile, 'utf8'));
    return lease.role === 'laptop' && lease.valid_until > Date.now();
  } catch (error) { if (!(error instanceof Error)) throw error; return false; }
};
if (!standbyLease()) throw new Error('Laptop is waiting for a valid standby lease');
if (config.speechGate === undefined) config.speechGate = true;
if (typeof config.speechGate !== 'boolean') throw new Error('Invalid speech gate configuration');
if (process.argv.includes('--manual')) { config.manualMode = true; delete config.cloudSyncFile; delete config.cloudSyncFiles; }
if (![5, 10].includes(config.chunkSeconds) || !Number.isInteger(config.queueChunks)
  || config.queueChunks < 2 || config.queueChunks > 24) throw new Error('Invalid chunk or queue configuration');
if (config.batch !== 1) throw new Error('This whisper-rs adapter supports batch 1 only');
if (!['cpu', 'gpu'].includes(config.device)) throw new Error('Invalid device');
if (!Number.isInteger(config.beam) || config.beam < 1 || config.beam > 8) throw new Error('Invalid beam');
if (config.workers !== undefined && (!Number.isInteger(config.workers) || config.workers < 1 || config.workers > 4)) throw new Error('Invalid worker count');
if (config.flashAttention !== undefined && typeof config.flashAttention !== 'boolean') throw new Error('Invalid flash attention setting');
if (config.segmentSeconds !== undefined && (!Array.isArray(config.segmentSeconds) || config.segmentSeconds.length !== 2
  || !config.segmentSeconds.every(Number.isFinite) || config.segmentSeconds[0] < 2 || config.segmentSeconds[0] > config.segmentSeconds[1]
  || config.segmentSeconds[1] > 10)) throw new Error('Invalid segment seconds');
const decodeKeys = { beam: 'number', temperature: 'number', temperature_inc: 'number', no_timestamps: 'boolean', no_speech_thold: 'number',
  logprob_thold: 'number', entropy_thold: 'number', max_initial_ts: 'number', audio_ctx: 'number' };
if (config.decode !== undefined && (typeof config.decode !== 'object' || config.decode === null
  || Object.entries(config.decode).some(([key, value]) => typeof value !== decodeKeys[key]))) throw new Error('Invalid decode options');
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
initializeCommitteeChannels(store);
const engine = new EnginePool(config);
const scheduler = new Scheduler(store, engine, config);
scheduler.exclusive = true;
if (config.liveDiarization === true) {
  scheduler.diarizer = new LiveDiarization(store, config); scheduler.metrics.diarization = scheduler.diarizer.metrics;
}
if (config.acousticVad) scheduler.vad = new AcousticVad(config.acousticVad);
const inputs = new FileInputs(scheduler, config);
const service = createService({ store, scheduler, inputs, config, configPath, shutdown: () => stop().catch(error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
}) });
let stopping = false;
// When the lease lapses the desktop is back: stop collecting at once, then shut down normally.
const standbyTimer = config.standbyLeaseFile ? setInterval(() => {
  if (standbyLease() || stopping) return;
  inputs.close().then(() => stop()).catch(error => {
    process.stderr.write(JSON.stringify({ event: 'standby.expired', error: error.message }) + '\n'); process.exitCode = 1;
  });
}, 2000) : null;
standbyTimer?.unref();
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(standbyTimer);
  // New collection stops first, so no audio is taken after a handover while the other services close.
  await service.monitor.close(); await service.discovery.close(); await inputs.close();
  await service.retention.close(); await service.finalSpeakers.close(); await service.videoAlignment.close(); await service.schedule.close(); await service.speakerDirectory.close(); await service.review.close(); await service.audioReview.close(); await service.modelManager.close(); await service.liveCorrection.close(); await service.correctionAI.close(); await inputs.close(); await scheduler.close();
  service.minutes.flush(); await service.cloudSync.flush({ force: true });
  if (service.server.listening) await service.close(); else { await service.desktopLive?.close(); service.minutes.close(); } store.close();
}
process.on('SIGINT', () => stop().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }));
process.on('SIGTERM', () => stop().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }));
for (const kind of ['unhandledRejection', 'uncaughtException']) process.on(kind, error => {
  process.stderr.write(JSON.stringify({ level: 'error', event: 'process.' + kind, error: error?.message ?? String(error) }) + '\n');
  process.exitCode = 1; stop().catch(() => {});
});
try {
  await engine.start();
  await scheduler.vad?.start();
  await scheduler.diarizer?.start();
  scheduler.exclusive = false; scheduler.pump();
  if (!stopping) {
    service.server.listen(config.port ?? 4320, '127.0.0.1'); await once(service.server, 'listening');
    await service.desktopLive?.start();
    service.schedule.start();
    if (!config.manualMode) service.speakerDirectory.start(); else await service.speakerDirectory.load();
    if (!config.manualMode) { service.monitor.start(); service.discovery.start(); service.cloudSync.start(); service.retention.start(); }
    process.stdout.write(JSON.stringify({ event: 'service.ready', url: 'http://127.0.0.1:' + service.server.address().port,
      engine: engine.metadata, diarization: scheduler.diarizer?.engine.metadata ?? null, manual: config.manualMode === true }) + '\n');
  }
} catch (error) {
  await stop(); process.stderr.write(error.message + '\n'); process.exitCode = 1;
}
