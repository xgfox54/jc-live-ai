import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';

const url = new URL(process.argv[2] ?? '');
if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app') || url.port || url.username || url.password
  || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('Pass the verified Vercel production origin.');
const configPath = resolve(process.argv[3] ?? 'config.local.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const secretFile = resolve(dirname(config.database), 'cloud-sync.secret'); mkdirSync(dirname(secretFile), { recursive: true });
const previous = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, 'utf8')) : null;
if (previous && previous.endpoint !== url.origin + '/api/sync') throw new Error('An existing cloud destination requires operator review.');
const settings = previous ?? { endpoint: url.origin + '/api/sync', secret: randomBytes(32).toString('hex'), interval_ms: 60000, minutes_interval_ms: 300000 };
if (!previous) writeFileSync(secretFile, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 });
writeFileSync(configPath + '.tmp', JSON.stringify({ ...config, cloudSyncFile: secretFile }, null, 2), { mode: 0o600 });
renameSync(configPath + '.tmp', configPath);
console.log(JSON.stringify({ endpoint: settings.endpoint, secretFile, vercelEnvironmentVariable: 'JC_SYNC_SECRET', restartRequired: true }));
