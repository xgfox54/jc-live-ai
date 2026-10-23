export function viewerHealthMessage(health, now = Date.now()) {
  if (health?.stages?.ingestion === 'stopped' && health.stages.transcription === 'stopped'
    && health.status === 'correction_delayed')
    return '방송 기록 수집이 종료되었습니다. 일부 문장은 AI 후보정을 기다리고 있습니다.';
  switch (health?.status) {
    case 'waiting': return '방송 음성 수신을 기다립니다.';
    case 'silent': return '음성을 수신하고 있습니다. 현재 감지된 발언이 없습니다.';
    case 'processing': return health.stage === 'correction' ? '받아쓰기 내용을 AI가 후보정하고 있습니다.' : '수신한 음성을 받아쓰고 있습니다.';
    case 'correction_delayed': return Number.isFinite(health.last_corrected_ms) && Number.isFinite(health.last_received_ms)
      && health.last_corrected_ms >= health.last_received_ms - 60000 && now - health.last_corrected_ms <= 180000
      ? '일부 문장의 후보정이 지연되고 있습니다. 새로 완료된 문장은 계속 표시합니다.'
      : 'AI 후보정이 지연되고 있습니다. 완료된 문장은 계속 표시합니다.';
    case 'delayed': return health.stage === 'ingestion' ? '방송 음성 수신이 지연되고 있습니다. 공식 영상에서 방송 상태를 확인해 주세요.'
      : health.stage === 'publication' ? '새 받아쓰기 자료의 게시가 지연되고 있습니다. 마지막 게시 자료를 표시합니다.'
        : '회의록 받아쓰기가 지연되고 있습니다. 완료된 문장은 계속 표시합니다.';
    case 'ready': return 'AI 후보정이 완료된 받아쓰기 내용을 표시합니다.';
    case 'stopped': return '방송 기록 수집이 종료되었습니다.';
    default: return '';
  }
}

export function publicationConnectionMessage(delivery, publication, received, now = Date.now()) {
  if (!received) return '새 자료 수신이 지연되고 있습니다';
  const published = delivery?.published_ms;
  const threshold = Number.isFinite(publication?.stale_after_ms) && publication.stale_after_ms > 0 ? publication.stale_after_ms : 120_000;
  if (!Number.isFinite(published) || published <= 0) return '게시 시각을 확인할 수 없습니다';
  if (now - published > threshold) return '새 자료 게시가 지연되고 있습니다 · 최근 갱신 ' + new Date(published).toLocaleTimeString('ko-KR');
  return '최근 갱신 ' + new Date(published).toLocaleTimeString('ko-KR');
}

export function mergeTranscriptItems(current, incoming, prepend = false) {
  const values = new Map();
  for (const item of prepend ? [...incoming, ...current] : [...current, ...incoming]) {
    const previous = values.get(item.segment_id);
    if (!previous || previous.version <= item.version) values.set(item.segment_id, item);
  }
  return [...values.values()].sort((a, b) => Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence) ? a.sequence - b.sequence : 0);
}

export class TranscriptHistory {
  constructor() { this.items = []; this.before = null; this.bridge = null; }
  reconcilePending(manifest, broadcastId) {
    if (manifest?.complete !== true || (manifest.broadcast_id ?? null) !== (broadcastId ?? null)) return;
    const pending = new Set(manifest.segment_ids);
    this.items = this.items.map(item => item.stream_id === manifest.stream_id && item.display_state === 'draft' && !pending.has(item.segment_id)
      ? { ...item, display_state: 'reconciling', text: '' } : item);
  }
  update(items, before) {
    const ordered = items.filter(item => Number.isSafeInteger(item.sequence) && item.sequence > 0);
    const oldest = ordered.length ? Math.min(...ordered.map(item => item.sequence)) : before;
    const newest = this.items.reduce((last, item) => Math.max(last, item.sequence ?? 0), 0);
    if (this.before === null || !this.items.length) this.before = oldest ?? Number.MAX_SAFE_INTEGER;
    else if (newest && ordered.length && oldest > newest) {
      this.bridge = { before: Math.max(oldest, this.bridge?.before ?? 0), target: Math.min(newest, this.bridge?.target ?? newest) };
    }
    this.items = mergeTranscriptItems(this.items, items);
  }
  get cursor() { return this.bridge?.before ?? this.before ?? Number.MAX_SAFE_INTEGER; }
  addPage(page, requested) {
    const next = page.before ?? 0;
    if (!Number.isSafeInteger(next) || next < 0 || next >= requested) throw new Error('이전 기록 조회 위치를 확인하지 못했습니다. 다시 시도해 주세요.');
    this.items = mergeTranscriptItems(this.items, page.items, true);
    if (this.bridge && next > this.bridge.target) this.bridge.before = next;
    else { this.bridge = null; this.before = Math.min(this.before ?? requested, next); }
  }
}

export class TranscriptState {
  constructor() { this.cursor = 0; this.segments = new Map(); this.status = new Map(); this.gaps = new Map(); this.partials = new Map(); this.health = new Map(); this.livePending = new Map(); }
  updateHealth(snapshot) {
    this.health.clear();
    for (const health of snapshot.health ?? []) this.health.set(health.stream_id, health);
  }
  reset(snapshot) {
    this.segments.clear(); this.status.clear(); this.gaps.clear(); this.partials.clear();
    this.cursor = snapshot.event_id;
    this.updateHealth(snapshot);
    this.livePending = new Map((snapshot.live_pending ?? []).map(item => [item.stream_id, item]));
    for (const segment of snapshot.segments) this.put(segment);
    for (const segment of snapshot.live_segments ?? []) this.put(segment);
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
      case 'segment': case 'live-segment': this.put(event.payload); this.partials.delete(event.payload.stream_id); this.livePending.delete(event.payload.stream_id); break;
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
