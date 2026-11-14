import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';
import { CLOUDFLARE_SITE, VERCEL_SITE } from '../src/sites.mjs';

const configPath = resolve(process.argv[2] ?? 'config.local.json');
const endpoint = process.argv[3];
if (endpoint !== CLOUDFLARE_SITE + '/api/sync') throw new Error('Review the Cloudflare deployment endpoint');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const backupDir = resolve('data/cloudflare-migration-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(backupDir, { recursive: true });
copyFileSync(configPath, join(backupDir, 'config.local.json'));
const store = new Store(config.database);
try {
  store.db.prepare('VACUUM INTO ?').run(join(backupDir, 'live.sqlite'));
  if (config.cloudSyncFile) {
    copyFileSync(config.cloudSyncFile, join(backupDir, 'vercel-sync.secret'));
    const value = JSON.parse(readFileSync(config.cloudSyncFile, 'utf8'));
    value.archive_only = true;
    writeFileSync(config.cloudSyncFile, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
  const path = resolve('data/cloudflare-sync.secret');
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ provider: 'cloudflare', archive_only: true,
    endpoint, secret: randomBytes(32).toString('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const publisher = new CloudPublisher({ store, config: { ...config, cloudSyncFile: path } });
  if (!publisher.settings) throw new Error('Cloudflare publisher configuration rejected');
  const key = createHash('sha256').update(endpoint).digest('hex');
  const owner = publisher.control.load().publisher_id;
  if (!owner || publisher.key !== key) throw new Error('Cloudflare publisher identity was not prepared');
  config.cloudSyncFiles = [...new Set([...(config.cloudSyncFiles ?? []), path])];
  config.desktopLive = { enabled: true, port: 4321, publicOrigin: new URL(endpoint).origin,
    allowedOrigins: [VERCEL_SITE, new URL(endpoint).origin] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(JSON.stringify({ backupDir, prepared: true, targets: config.cloudSyncFiles.length + (config.cloudSyncFile ? 1 : 0),
    publicOrigin: config.desktopLive.publicOrigin, publisher_id: owner }));
} finally { store.close(); }
