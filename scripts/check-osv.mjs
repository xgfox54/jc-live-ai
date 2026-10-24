import { readFileSync } from 'node:fs';
// Queries OSV for every locked npm (web) and crates.io (worker) package, like the GitLab pre-receive OSV check.
const queries = [];
const lock = JSON.parse(readFileSync('web/package-lock.json', 'utf8'));
for (const [path, item] of Object.entries(lock.packages)) if (path && item.version) queries.push({ package: { ecosystem: 'npm', name: path.split('node_modules/').at(-1) }, version: item.version });
for (const block of readFileSync('worker/Cargo.lock', 'utf8').split('[[package]]').slice(1)) {
  const name = block.match(/name = "([^"]+)"/)?.[1]; const version = block.match(/version = "([^"]+)"/)?.[1];
  if (name && version && /source = "registry/.test(block)) queries.push({ package: { ecosystem: 'crates.io', name }, version });
}
const response = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries }) });
if (!response.ok) throw new Error('OSV ' + response.status);
const { results } = await response.json();
const hits = results.map((result, i) => ({ ...queries[i].package, version: queries[i].version, vulns: (result.vulns ?? []).map(v => v.id) })).filter(item => item.vulns.length);
console.log(JSON.stringify({ checked: queries.length, npm: queries.filter(q => q.package.ecosystem === 'npm').length, crates: queries.filter(q => q.package.ecosystem === 'crates.io').length, vulnerable: hits }, null, 1));

