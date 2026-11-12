export function desktopOrigin(value, { allowLoopback = false } = {}) {
  if (typeof value !== 'string' || value.length > 250) throw new Error('Invalid desktop origin');
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || url.search || url.hash
    || (!allowLoopback && (loopback || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)))
    || (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')))
    throw new Error('Invalid desktop origin');
  return url.origin;
}

export function createLiveTransport({ fetcher = fetch, pageOrigin = location.origin } = {}) {
  let configured;
  let recoveryInterval = 5000;
  const load = () => configured ??= fetcher('/live-transport.json', { cache: 'no-cache', credentials: 'omit',
    signal: AbortSignal.timeout(10000) }).then(async response => {
    if (!response.ok) throw new Error('실시간 연결 설정을 불러오지 못했습니다. 다시 연결해 주세요.');
    const value = await response.json();
    if (value.mode === 'same-origin') return '';
    if (value.mode !== 'desktop') throw new Error('실시간 연결 설정을 확인해 주세요.');
    if (value.recovery_interval_ms !== undefined) {
      if (![5000, 120000].includes(value.recovery_interval_ms)) throw new Error('Invalid recovery interval');
      recoveryInterval = value.recovery_interval_ms;
    }
    return desktopOrigin(value.origin, { allowLoopback: /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(pageOrigin) });
  }).catch(error => { configured = null; throw error; });
  return {
    get recoveryInterval() { return recoveryInterval; },
    async fetch(path, options = {}) {
      const base = await load();
      const url = new URL(path, pageOrigin);
      if (url.origin !== pageOrigin || !/^\/api\/(snapshot|segments|events|schedule|status)$/.test(url.pathname))
        throw new Error('Invalid live request');
      options.signal?.throwIfAborted();
      return fetcher(base + url.pathname.replace('/api/', '/api/viewer/') + url.search,
        { ...options, credentials: 'omit', redirect: 'error' });
    }
  };
}
