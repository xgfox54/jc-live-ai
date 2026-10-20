export class EventFeed {
  constructor(store, options = {}) {
    this.store = store; this.clients = new Set();
    this.maxClients = options.maxClients ?? 350;
    this.maxBytes = options.maxBytes ?? 262144;
    this.project = options.project ?? (event => event);
    this.metrics = { sent: 0, bytes: 0, slow_disconnects: 0, high_water_bytes: 0, peak_clients: 0 };
    store.on('event', () => { for (const client of this.clients) this.schedule(client); });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) if (!client.waiting) this.send(client, { kind: 'heartbeat', event_id: client.cursor, payload: {} });
    }, 10_000);
    this.heartbeat.unref();
  }
  schedule(client) {
    if (client.scheduled || client.waiting || client.res.destroyed) return;
    client.scheduled = true;
    setImmediate(() => { client.scheduled = false; this.pump(client); });
  }
  send(client, event) {
    if (client.res.destroyed) { this.clients.delete(client); return false; }
    const wire = 'id: ' + event.event_id + '\ndata: ' + JSON.stringify(this.project(event)) + '\n\n';
    if (client.res.writableLength + Buffer.byteLength(wire) > this.maxBytes) {
      this.metrics.slow_disconnects++; client.res.destroy(); this.clients.delete(client); return false;
    }
    const writable = client.res.write(wire);
    this.metrics.high_water_bytes = Math.max(this.metrics.high_water_bytes, client.res.writableLength);
    this.metrics.sent++; this.metrics.bytes += Buffer.byteLength(wire);
    if (!writable) {
      client.waiting = true;
      client.timer = setTimeout(() => {
        this.metrics.slow_disconnects++; client.res.destroy(); this.clients.delete(client);
      }, 5000);
      client.res.once('drain', () => {
        clearTimeout(client.timer); client.waiting = false; this.schedule(client);
      });
    }
    return writable;
  }
  pump(client) {
    if (client.res.destroyed || client.waiting || !this.clients.has(client)) return;
    const events = this.store.events(client.cursor, 64);
    for (const event of events) {
      client.cursor = event.event_id;
      if (event.kind !== 'metric' && client.ids.has(event.payload.stream_id) && !this.send(client, event)) return;
    }
    if (events.length === 64) this.schedule(client);
  }
  connect(req, res, ids, cursor) {
    if (this.clients.size >= this.maxClients) { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const client = { res, ids: new Set(ids), cursor, waiting: false, scheduled: false, timer: null };
    // Synchronous SQLite replay and listener registration share one event-loop turn.
    const events = this.store.events(cursor);
    if (cursor > this.store.cursor() || events.length > 2000) {
      this.send(client, { kind: 'reset', event_id: this.store.cursor(), payload: {} }); res.end(); return;
    }
    this.clients.add(client);
    this.metrics.peak_clients = Math.max(this.metrics.peak_clients, this.clients.size);
    res.write(': connected\n\n'); this.schedule(client);
    req.on('close', () => { clearTimeout(client.timer); this.clients.delete(client); });
  }
  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) { clearTimeout(client.timer); client.res.end(); }
    this.clients.clear();
  }
}
