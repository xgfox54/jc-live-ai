import { mkdir, readFile, writeFile, copyFile, cp, chmod, mkdtemp, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime, runtimeArchive, copyProductionPackages, generateConfig } from './build-support.mjs';
import { applyLiveTransport } from './live-transport.mjs';

export async function build({ root = fileURLToPath(new URL('../', import.meta.url)), fetchImpl = fetch } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build on Linux x64 to preserve executable permissions');
  const archive = await runtimeArchive({ cacheDir: join(root, '.vercel/cache/runtime'), fetchImpl });
  const staging = await mkdtemp(join(tmpdir(), 'jc-runtime-'));
  try {
    execFileSync('tar', ['-xJf', archive.path, '-C', staging, runtime.name + '/bin/node', runtime.name + '/LICENSE']);
    const binary = join(staging, runtime.name, 'bin/node');
    if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== 'v' + runtime.version) throw new Error('Runtime version mismatch');
    const output = join(root, '.vercel/output');
    const fn = join(output, 'functions/api/viewer.func');
    await rm(output, { recursive: true, force: true });
    await mkdir(join(fn, 'deployment'), { recursive: true });
    await mkdir(join(output, 'static'), { recursive: true });
    await copyFile(binary, join(fn, 'node'));
    await chmod(join(fn, 'node'), 0o755);
    await copyFile(join(staging, runtime.name, 'LICENSE'), join(fn, 'NODE-LICENSE'));
    for (const file of ['handler.mjs', 'runtime.mjs']) await copyFile(join(root, 'deployment', file), join(fn, 'deployment', file));
    await cp(join(root, 'lib'), join(fn, 'lib'), { recursive: true });
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const packages = await copyProductionPackages(root, fn, lock);
    await copyFile(join(root, 'package.json'), join(fn, 'package.json'));
    await writeFile(join(fn, 'bootstrap'), '#!/bin/sh\ncd /var/task\nif [ -n "$AWS_LAMBDA_EXEC_WRAPPER" ]; then\n  exec "$AWS_LAMBDA_EXEC_WRAPPER" /var/task/node /var/task/deployment/runtime.mjs\nfi\nexec /var/task/node /var/task/deployment/runtime.mjs\n');
    await chmod(join(fn, 'bootstrap'), 0o755);
    await writeFile(join(fn, '.vc-config.json'), JSON.stringify({
      runtime: 'provided.al2023', handler: 'bootstrap', architecture: 'x86_64',
      supportsWrapper: true, maxDuration: 30, regions: ['icn1'],
    }));
    const assets = JSON.parse(await readFile(join(root, 'deployment/public-assets.json'), 'utf8'));
    await symlink('viewer.func', join(output, 'functions/api/sync.func'));
    for (const file of assets) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file) || /admin|secret|config/i.test(file)) throw new Error('Unexpected public asset');
      await copyFile(join(root, 'public', file), join(output, 'static', file));
    }
    const { source, transport } = applyLiveTransport(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8')), process.env.JC_LIVE_DESKTOP_ORIGIN);
    await writeFile(join(output, 'static/live-transport.json'), JSON.stringify(transport) + '\n');
    await writeFile(join(output, 'config.json'), JSON.stringify(generateConfig(source)));
    return { event: 'build.runtime_verified', node: runtime.version, sha256: runtime.sha256, cacheHit: archive.cacheHit, packages: packages.length, publicAssets: assets.length };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await build()));
