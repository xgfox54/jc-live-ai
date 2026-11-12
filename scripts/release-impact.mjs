import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyRelease({ files, base, shallow = false, baseKnown = true }) {
  if (!base || !baseKnown || shallow || !Array.isArray(files)) return { build: true, reason: 'deployment-base-unavailable' };
  const harmless = path => /^(docs\/|test\/)/.test(path) || /^(README(?:\.[^/]+)?|LICENSE|UPSTREAM-LICENSE\.md|ORIGIN\.md)$/.test(path);
  const impact = files.filter(path => !harmless(path));
  return { build: impact.length > 0, reason: impact.length ? 'runtime-or-unknown-change' : 'documentation-or-test-only', files: impact };
}

export const ignoredBuildExitCode = result => result.build ? 1 : 0;

export function inspectRelease({ base, cwd = process.cwd(), run = execFileSync } = {}) {
  if (!base || !/^[0-9a-f]{40,64}$/i.test(base)) return classifyRelease({ base: null });
  try {
    const git = args => run('git', args, { cwd, encoding: 'utf8' }).trim();
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') return classifyRelease({ base, shallow: true });
    if (git(['status', '--porcelain'])) return { build: true, reason: 'uncommitted-changes' };
    git(['cat-file', '-e', `${base}^{commit}`]);
    git(['merge-base', '--is-ancestor', base, 'HEAD']);
    const files = git(['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
    return classifyRelease({ base, files });
  } catch { return classifyRelease({ base, baseKnown: false }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--base');
  const result = inspectRelease({ base: index >= 0 ? args[index + 1] : process.env.VERCEL_GIT_PREVIOUS_SHA });
  console.log(JSON.stringify(result));
  if (args.includes('--ignored-build-step')) process.exitCode = ignoredBuildExitCode(result);
}



