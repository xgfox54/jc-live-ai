import { readFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Usage: node scripts/backup-db.mjs [config.local.json] [keep=14]. Safe while the server runs (SQLite VACUUM INTO).
const configPath = resolve(process.argv[2] ?? 'config.local.json'); const keep = Number(process.argv[3] ?? 14);
if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error('보관 개수는 1~365입니다.');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const folder = resolve(config.backupDirectory ?? 'data/backups'); mkdirSync(folder, { recursive: true });
const target = join(folder, 'live-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite');
const source = new DatabaseSync(resolve(config.database), { readOnly: true });
const tables = ['streams', 'sessions', 'segments', 'events', 'corrections', 'broadcasts'];
let expected;
try {
  const exists = name => source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  expected = tables.filter(exists);
  source.prepare('VACUUM INTO ?').run(target);
} finally { source.close(); }
const restored = new DatabaseSync(target, { readOnly: true });
try {
  const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error('백업 복원 검증 실패: ' + integrity);
  const actual = Object.fromEntries(expected.map(name => [name, restored.prepare('SELECT count(*) AS n FROM ' + name).get().n]));
  const old = readdirSync(folder).filter(name => /^live-.*\.sqlite$/.test(name)).sort().slice(0, -keep);
  for (const name of old) rmSync(join(folder, name));
  console.log(JSON.stringify({ backup: target, bytes: statSync(target).size, integrity, rows: actual, removed: old.length }));
} finally { restored.close(); }
