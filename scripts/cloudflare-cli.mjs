import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// JC-LIVE uses Wrangler OAuth in the OS keyring without changing inherited bridge tokens.
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) delete env[key];
// The account, D1 and VPC IDs stay out of the repository. cloudflare/wrangler.local.json (git-ignored) is
// cloudflare/wrangler.example.json with the three IDs filled in; login commands do not need it.
const config = fileURLToPath(new URL('../cloudflare/wrangler.local.json', import.meta.url));
const login = ['login', 'logout', 'whoami'].includes(process.argv[2]);
if (!login) {
  const value = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
  const ids = [value.account_id, ...(value.d1_databases ?? []).map(item => item.database_id), ...(value.vpc_services ?? []).map(item => item.service_id)];
  if (ids.some(id => !/^[0-9a-f-]{32,36}$/i.test(id ?? ''))) {
    process.stderr.write('cloudflare/wrangler.example.json을 cloudflare/wrangler.local.json으로 복사하고 계정·D1·VPC ID를 채워 주세요.\n');
    process.exit(1);
  }
}
const child = spawn(process.execPath, [fileURLToPath(new URL('../cloudflare/node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  ...process.argv.slice(2), ...(login ? [] : ['--config', config])], { cwd: fileURLToPath(new URL('../cloudflare/', import.meta.url)), env, stdio: 'inherit' });
child.on('error', () => { process.stderr.write('Cloudflare CLI could not start\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
