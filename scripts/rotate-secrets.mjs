import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sealCredential, openCredential } from '../src/ai-proxy.mjs';

// Usage: node scripts/rotate-secrets.mjs [config.local.json] [--cloud]. Stop the server first.
const args = process.argv.slice(2); const cloud = args.includes('--cloud');
const configPath = resolve(args.find(value => !value.startsWith('--')) ?? 'config.local.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const running = await fetch('http://127.0.0.1:' + (config.port ?? 4320) + '/health/live', { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
if (running) throw new Error('JC-LIVE 서버를 먼저 종료해 주세요.');
const write = (path, value) => { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path); };
const hex = () => randomBytes(32).toString('hex');

const tokenFile = resolve(config.tokenFile); const old = JSON.parse(readFileSync(tokenFile, 'utf8'));
const next = { ...old, adminToken: hex(), viewerToken: hex() };
const db = new DatabaseSync(resolve(config.database)); let resealed = 0;
try {
  db.exec('CREATE TABLE IF NOT EXISTS ai_settings(id TEXT PRIMARY KEY, document TEXT NOT NULL)'); db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare("SELECT id,document FROM ai_settings WHERE id='proxy-credential' OR id LIKE 'profile:%'").all()) {
      const document = JSON.parse(row.document); const sealed = row.id === 'proxy-credential' ? document : document.credential;
      if (!sealed) continue;
      const fresh = sealCredential(openCredential(sealed, sealed.destination, old.adminToken), sealed.destination, next.adminToken);
      db.prepare('UPDATE ai_settings SET document=? WHERE id=?').run(JSON.stringify(row.id === 'proxy-credential' ? fresh : { ...document, credential: fresh }), row.id);
      resealed++;
    }
    write(tokenFile, next); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }

let cloudRotated = false;
if (cloud) {
  const file = resolve(config.cloudSyncFile ?? ''); if (!config.cloudSyncFile || !existsSync(file)) throw new Error('공개 웹사이트 전송 설정이 없습니다.');
  write(file, { ...JSON.parse(readFileSync(file, 'utf8')), secret: hex() }); cloudRotated = true;
}
console.log(JSON.stringify({ tokens: 'rotated', resealed_credentials: resealed, cloud_secret: cloudRotated ? 'rotated' : 'unchanged',
  next: cloudRotated ? 'data/cloud-sync.secret의 새 전송키를 Vercel production 민감 변수 JC_SYNC_SECRET에 등록한 뒤 재배포하고 서버를 시작합니다.' : '서버를 시작하고 새 관리자 접근키로 로그인합니다.' }));
