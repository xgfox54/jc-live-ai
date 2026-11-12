import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// JC-LIVE uses Wrangler OAuth in the OS keyring without changing inherited bridge tokens.
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) delete env[key];
const child = spawn(process.execPath, [fileURLToPath(new URL('../cloudflare/node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  ...process.argv.slice(2)], { cwd: fileURLToPath(new URL('../cloudflare/', import.meta.url)), env, stdio: 'inherit' });
child.on('error', () => { process.stderr.write('Cloudflare CLI could not start\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
