import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.local.json'));
const { adminToken } = JSON.parse(readFileSync(config.tokenFile));
const response = await fetch('http://127.0.0.1:' + (config.port ?? 4320) + '/api/admin/shutdown',
  { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken } });
if (!response.ok) throw new Error('Shutdown request failed: HTTP ' + response.status);
console.log('Normal shutdown requested; queued audio will be drained.');
