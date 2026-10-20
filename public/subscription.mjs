export async function subscribe(options) {
  let attempt = 0;
  while (!options.signal.aborted) {
    try {
      const response = await options.api('/api/events?after=' + options.state.cursor + '&streams=' + options.ids.join(','),
        { signal: options.signal });
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      options.connection('연결됨'); attempt = 0;
      let heartbeat = setTimeout(() => reader.cancel(), 25_000);
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          clearTimeout(heartbeat); heartbeat = setTimeout(() => reader.cancel(), 25_000);
          buffer += decoder.decode(part.value, { stream: true });
          if (buffer.length > 1_048_576) throw new Error('Event buffer exceeded');
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            if (event.kind === 'reset') { await options.refresh(); break; }
            if (options.state.apply(event)) options.changed(event);
          }
        }
      } finally { clearTimeout(heartbeat); await reader.cancel(); }
    } catch (error) {
      if (options.signal.aborted) return;
      options.connection('재연결 중: ' + error.message);
    }
    if (options.signal.aborted) return;
    options.connection('재연결 대기');
    await new Promise(resolve => {
      const abort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(); },
        Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) + Math.random() * 500);
      options.signal.addEventListener('abort', abort, { once: true });
    });
  }
}
