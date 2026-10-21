export async function pollSnapshots({ refresh, signal, interval, connection }) {
  while (!signal.aborted) {
    // Random spread (±20%) keeps many viewers from refreshing in the same second.
    const wait = Math.round(interval * (0.8 + Math.random() * 0.4));
    await new Promise(resolve => {
      const abort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, wait);
      signal.addEventListener('abort', abort, { once: true });
    });
    if (signal.aborted) return;
    try { await refresh(); if (!signal.aborted) connection(true); }
    catch { if (!signal.aborted) connection(false); }
  }
}
