export class EventFeed {
  constructor(store, options = {}) {
    this.store = store; this.clients = new Set();
    this.maxClients = options.maxClients ?? 350;
    this.maxBytes = options.maxBytes ?? 262144;
    this.project = options.project ?? (event => event);
    this.heartbeatPayload = options.heartbeatPayload;
    this.metrics = { sent: 0, bytes: 0, slow_disconnects: 0, high_water_bytes: 0, peak_clients: 0 };
    // Clients share the events read after one cursor (until the next event) and the projected wire text of each event.
    this.recent = new Map(); this.wires = new Map();
    this.onEvent = () => { this.recent.clear(); for (const client of this.clients) this.schedule(client); };
    store.on('event', this.onEvent);
    this.heartbeat = setInterval(() => {
      const payload = this.clients.size && this.heartbeatPayload ? this.heartbeatPayload() : null;
      for (const client of this.clients) if (!client.waiting) this.send(client, {
        kind: payload ? 'delivery-health' : 'heartbeat', event_id: client.cursor, payload: payload ?? {} });
    }, options.heartbeatMs ?? 10_000);
    this.heartbeat.unref();
  }
  schedule(client) {
    if (client.scheduled || client.waiting || client.res.destroyed) return;
    client.scheduled = true;
    setImmediate(() => { client.scheduled = false; this.pump(client); });
  }
  wire(event) {
    if (this.wires.has(event.event_id)) return this.wires.get(event.event_id);
    const projected = this.project(event);
    const wire = projected ? 'id: ' + event.event_id + '\ndata: ' + JSON.stringify(projected) + '\n\n' : null;
    this.wires.set(event.event_id, wire); if (this.wires.size > 2048) this.wires.delete(this.wires.keys().next().value);
    return wire;
  }
  send(client, event, wire) {
    if (client.res.destroyed) { this.clients.delete(client); return false; }
    if (wire === undefined) { const projected = this.project(event); wire = projected ? 'id: ' + event.event_id + '\ndata: ' + JSON.stringify(projected) + '\n\n' : null; }
    if (!wire) return true;
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
    let events = this.recent.get(client.cursor);
    if (!events) { events = this.store.events(client.cursor, 64); this.recent.set(client.cursor, events); }
    for (const event of events) {
      client.cursor = event.event_id;
      if (event.kind !== 'metric' && client.ids.has(event.payload.stream_id) && !this.send(client, event, this.wire(event))) return;
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
    this.store.off('event', this.onEvent);
    clearInterval(this.heartbeat);
    for (const client of this.clients) { clearTimeout(client.timer); client.res.end(); }
    this.clients.clear();
  }
}
