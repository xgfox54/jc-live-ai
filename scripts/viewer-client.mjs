import http from 'node:http';
import { performance } from 'node:perf_hooks';

export class Viewer {
  constructor(base, token) {
    this.base = base; this.token = token; this.cursor = 0; this.count = 0; this.bytes = 0;
    this.duplicates = 0; this.latencies = []; this.versions = new Map(); this.reset = false;
    this.readiness = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.request = http.get(this.base + '/api/events?streams=ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8&after=' + this.cursor,
        { agent: false, headers: { Authorization: 'Bearer ' + this.token } }, response => {
          this.response = response;
          if (response.statusCode !== 200) { response.resume(); reject(new Error('SSE HTTP ' + response.statusCode)); return; }
          let buffer = ''; response.setEncoding('utf8');
          response.on('data', chunk => {
            this.bytes += Buffer.byteLength(chunk); buffer += chunk;
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const line = block.split('\n').find(item => item.startsWith('data: ')); if (!line) continue;
              const event = JSON.parse(line.slice(6));
              if (event.kind === 'reset') { this.reset = true; continue; }
              if (event.kind === 'heartbeat') { this.cursor = Math.max(this.cursor, event.event_id); continue; }
              if (event.event_id <= this.cursor) this.duplicates++;
              this.cursor = Math.max(this.cursor, event.event_id); this.count++;
              if (event.created_ms) this.latencies.push(Date.now() - event.created_ms);
              if (event.kind === 'segment') {
                this.versions.set(event.payload.segment_id, event.payload.version);
                if (Number.isFinite(event.payload.latency_ms)) {
                  const samples = this.readiness.get(event.payload.stream_id) ?? [];
                  samples.push(event.payload.latency_ms + Date.now() - event.created_ms);
                  this.readiness.set(event.payload.stream_id, samples);
                }
              }
            }
          });
          response.on('error', () => {}); resolve();
        });
      this.request.on('error', reject);
    });
  }
  close() { this.response?.destroy(); this.request?.destroy(); }
}
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}
export async function connectViewers(base, token, count) {
  const start = performance.now();
  const viewers = Array.from({ length: count }, () => new Viewer(base, token));
  try { await Promise.all(viewers.map(viewer => viewer.connect())); }
  catch (error) { viewers.forEach(viewer => viewer.close()); throw error; }
  return { viewers, connect_ms: performance.now() - start };
}
export function viewerSummary(viewers) {
  const latencies = viewers.flatMap(v => v.latencies);
  const readiness = Array.from({length:8},(_,i)=>'ch'+(i+1)).map(id=>{
    const samples=viewers.flatMap(v=>v.readiness.get(id)??[]);
    return {stream_id:id,samples:samples.length,p50_ms:percentile(samples,0.5),
      p95_ms:percentile(samples,0.95),p99_ms:percentile(samples,0.99),over_30s:samples.filter(v=>v>30000).length};
  });
  return { connections: viewers.length, subscriptions: viewers.length * 8,
    readiness_including_transport: readiness,
    received_events: viewers.reduce((n, v) => n + v.count, 0), duplicates: viewers.reduce((n, v) => n + v.duplicates, 0),
    reset_clients: viewers.filter(v => v.reset).length, received_bytes: viewers.reduce((n, v) => n + v.bytes, 0),
    event_latency_p50_ms: percentile(latencies, 0.5), event_latency_p95_ms: percentile(latencies, 0.95),
    event_latency_p99_ms: percentile(latencies, 0.99) };
}
