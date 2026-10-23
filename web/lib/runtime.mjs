export function assertSupportedRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supported = match && Number(match[1]) === 24
    && (Number(match[2]) > 22 || (Number(match[2]) === 22 && Number(match[3]) >= 1));
  if (!supported) throw new Error('JC-LIVE requires Node.js >=24.22.1 <25. Use the patched runtime.');
}
