export class TranscriptState {
  constructor() { this.cursor = 0; this.segments = new Map(); this.status = new Map(); this.gaps = new Map(); this.partials = new Map(); }
  reset(snapshot) {
    this.segments.clear(); this.status.clear(); this.gaps.clear(); this.partials.clear();
    this.cursor = snapshot.event_id;
    for (const segment of snapshot.segments) this.put(segment);
    for (const state of snapshot.states ?? []) { this.status.set(state.stream_id, state); if (state.partial) this.partials.set(state.stream_id, state.partial); }
    for (const gap of snapshot.gaps ?? []) this.gaps.set(gap.stream_id, gap);
  }
  put(segment) {
    const current = this.segments.get(segment.segment_id);
    if (!current || current.version < segment.version) this.segments.set(segment.segment_id, segment);
    const channel = [...this.segments.values()].filter(s => s.stream_id === segment.stream_id);
    for (const old of channel.slice(0, Math.max(0, channel.length - 200))) this.segments.delete(old.segment_id);
  }
  apply(event) {
    if (event.event_id <= this.cursor) return false;
    switch (event.kind) {
      case 'segment': this.put(event.payload); this.partials.delete(event.payload.stream_id); break;
      case 'partial': this.partials.set(event.payload.stream_id, event.payload); break;
      case 'session': case 'status': this.status.set(event.payload.stream_id, event.payload); if (!event.payload.partial) this.partials.delete(event.payload.stream_id); break;
      case 'gap': this.gaps.set(event.payload.stream_id, event.payload); break;
      case 'heartbeat': break;
      case 'stream': break;
      case 'reset': return false;
      default: return false;
    }
    this.cursor = event.event_id; return true;
  }
}
