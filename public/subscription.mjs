// Events applied from the open stream during the last minute. A snapshot read while the stream stays open (a channel was
// chosen, or the 5-minute check) can be older than the newest of them; those are applied again on top of it, as the server
// would send them again to a new stream that starts at the snapshot.
export class RecentEvents {
  constructor({ keepMs = 60_000, now = Date.now } = {}) { this.keepMs = keepMs; this.now = now; this.clear(); }
  // After clear() the next snapshot is the new start: the stream is opened again from it.
  clear() { this.items = []; this.from = null; }
  add(event) {
    const time = this.now(); this.items.push({ event, time });
    while (time - this.items[0].time > this.keepMs) this.from = Math.max(this.from ?? 0, this.items.shift().event.event_id);
  }
  // The events to apply after a snapshot, or null when the snapshot is older than the events still kept.
  after(snapshotId) {
    this.from ??= snapshotId;
    if (snapshotId < this.from) return null;
    return this.items.map(item => item.event).filter(event => event.event_id > snapshotId);
  }
}

export async function subscribe(options) {
  let attempt = 0;
  while (!options.signal.aborted) {
    try {
      const response = await options.api('/api/events?after=' + options.state.cursor + '&streams=' + options.ids.join(','),
        { signal: options.signal });
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      // received() tells the page each time the stream delivers data (sentences or the heartbeat).
      options.connection('연결됨'); attempt = 0; options.received?.();
      let heartbeat = setTimeout(() => reader.cancel(), 25_000);
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          clearTimeout(heartbeat); heartbeat = setTimeout(() => reader.cancel(), 25_000); options.received?.();
          buffer += decoder.decode(part.value, { stream: true });
          if (buffer.length > 1_048_576) throw new Error('Event buffer exceeded');
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            if (event.kind === 'reset') { await options.refresh(); break; }
            if (options.state.apply(event)) {
              if (event.kind !== 'delivery-health') options.recent?.add(event);
              options.changed(event);
            }
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
