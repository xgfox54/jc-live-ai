import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLOUDFLARE_SITE } from '../src/sites.mjs';

const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
const target = JSON.parse(readFileSync('data/cloudflare-sync.secret', 'utf8'));
if (target.endpoint !== CLOUDFLARE_SITE + '/api/sync') throw new Error('Unexpected archive endpoint');
const db = new DatabaseSync(config.database, { readOnly: true });
const row = db.prepare('SELECT document FROM cloud_control WHERE endpoint=?').get(createHash('sha256').update(target.endpoint).digest('hex'));
db.close();
const publisher = JSON.parse(row.document).publisher_id;
if (!/^[a-f0-9]{64}$/.test(target.secret) || !publisher) throw new Error('Publisher credentials missing');
const child = spawn(process.execPath, [fileURLToPath(new URL('./cloudflare-cli.mjs', import.meta.url)), 'secret', 'bulk'],
  { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(JSON.stringify({ JC_SYNC_SECRET: target.secret, JC_PUBLISHER_ID: publisher }));
child.on('exit', code => { process.exitCode = code ?? 1; });
