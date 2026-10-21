import { execFileSync } from 'node:child_process';

// Blocks commits that add credential-looking strings or secret files. Install: node scripts/check-secrets.mjs --install
const patterns = [/sk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /glpat-[A-Za-z0-9_-]{20}/, /xox[bpas]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, new RegExp('ctx7' + 'sk-'), /"(?:adminToken|viewerToken|secret|api_key)"\s*:\s*"[a-f0-9]{64}"/];
const blockedFiles = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.secret|access\.secret|cloud-sync\.secret|config\.local\.json)$/;
if (process.argv.includes('--install')) {
  const { writeFileSync, chmodSync } = await import('node:fs');
  writeFileSync('.git/hooks/pre-commit', '#!/bin/sh\nexec node scripts/check-secrets.mjs\n'); chmodSync('.git/hooks/pre-commit', 0o755);
  console.log('pre-commit hook installed'); process.exit(0);
}
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const findings = [];
for (const file of files) {
  if (blockedFiles.test(file)) { findings.push(file + ': 비밀 파일은 커밋하지 않습니다.'); continue; }
  const diff = execFileSync('git', ['diff', '--cached', '-U0', '--', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).forEach((line, index) => {
    const hit = patterns.find(pattern => pattern.test(line));
    if (hit) findings.push(file + ': 추가 줄에 비밀로 보이는 문자열이 있습니다 (' + hit.source.slice(0, 20) + ')');
  });
}
if (findings.length) { console.error(findings.join('\n')); console.error('커밋을 중단했습니다. 값을 제거하거나 .gitignore 대상으로 옮겨 주세요.'); process.exit(1); }
console.log('secret scan: ' + files.length + ' files, 0 findings');
