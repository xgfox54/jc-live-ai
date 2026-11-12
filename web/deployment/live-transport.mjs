// connect-src must be the reviewed list ('self' and the council replay host); only the desktop origin is appended.
const CONNECT = /connect-src 'self'((?: https:\/\/vod\.council\.jeju\.kr)?);/;
export function applyLiveTransport(source, origin = '') {
  const result = structuredClone(source);
  let transport = { mode: 'same-origin' };
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password
      || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || url.hostname.endsWith('.localhost'))
      throw new Error('Desktop live origin must be a public HTTPS origin');
    transport = { mode: 'desktop', origin, recovery_interval_ms: 120000 };
    let changed = false;
    for (const rule of result.headers ?? []) for (const header of rule.headers ?? []) {
      if (header.key.toLowerCase() !== 'content-security-policy') continue;
      if (!CONNECT.test(header.value)) throw new Error('Review connect-src before enabling desktop live');
      header.value = header.value.replace(CONNECT, (match, replay) => "connect-src 'self'" + replay + ' ' + origin + ';'); changed = true;
    }
    if (!changed) throw new Error('Missing CSP');
  }
  return { source: result, transport };
}
