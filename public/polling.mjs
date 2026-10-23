const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const abort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

// Retries a failed first load after a random, growing delay so viewers who all opened the page together
// do not reconnect in the same instant. Errors with retry === false (for example HTTP 404) fail at once.
export async function retryWithJitter(task, { signal, attempts = 4, baseMs = 1000, random = Math.random } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await task(); } catch (error) {
      if (signal?.aborted || error?.retry === false || attempt >= attempts) throw error;
      await pause(Math.round(baseMs * 2 ** (attempt - 1) * (0.5 + random())), signal);
      if (signal?.aborted) throw error;
    }
  }
}

export async function pollSnapshots({ refresh, signal, interval, connection, timeoutMs = 15000 }) {
  while (!signal.aborted) {
    // Random spread (±20%) keeps many viewers from refreshing in the same second.
    const wait = Math.round(interval * (0.8 + Math.random() * 0.4));
    await pause(wait, signal);
    if (signal.aborted) return;
    const request = new AbortController();
    let timer;
    let abort;
    try {
      const interrupted = new Promise((_, reject) => {
        abort = () => { request.abort(); reject(new Error('Snapshot request aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { request.abort(); reject(new Error('Snapshot request timed out')); }, timeoutMs);
      });
      await Promise.race([refresh({ signal: request.signal }), interrupted]);
      if (!signal.aborted) connection(true);
    } catch { if (!signal.aborted) connection(false); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
