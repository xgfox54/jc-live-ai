import { readFileSync } from 'node:fs';
import { CLOUDFLARE_SITE } from './sites.mjs';

export function playlistResume(playlist, videoMs) {
  const sequence = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]);
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
  if (!Number.isSafeInteger(sequence) || !durations.length || durations.some(d => d !== durations[0]) || durations[0] <= 0)
    throw new Error('Cannot verify the broadcast resume timeline');
  const duration = durations[0] * 1000, first = sequence * duration;
  const target = Math.max(0, videoMs - 10_000);
  if (target < first - duration) throw new Error('Saved transcription position is outside the live replay window');
  const index = Math.max(0, Math.min(durations.length - 1, Math.floor((target - first) / duration)));
  return { index: index - durations.length, video_ms: first + index * duration };
}

export function processedPosition(session) {
  if (session.timeline_epoch !== 0 || session.total_gap_s > 0 || !Number.isFinite(session.video_offset_ms) ||
    !Number.isFinite(session.audio_processed_until)) return null;
  return session.video_offset_ms + session.audio_processed_until;
}

export function videoOffset(timeline) {
  const spans = timeline.spans;
  if (!spans?.length || spans[0].pcm_sample !== 0) return null;
  const offset = spans[0].source_pts;
  if (!Number.isFinite(offset) || offset < 0 || spans.some(s => Math.abs(s.source_pts - s.pcm_sample - offset) > 16)) return null;
  return offset / 16;
}

export class Handoff {
  constructor({ store, registry, scheduler, config }) {
    Object.assign(this, { store, registry, scheduler, config });
    this.sent = new Map(); this.checkpoints = new Map(); this.busy = null; this.closed = false; this.stopping = new AbortController();
    if (config.handoffFile) {
      this.settings = JSON.parse(readFileSync(config.handoffFile, 'utf8'));
      if (this.settings.secretFile) {
        const value = readFileSync(this.settings.secretFile, 'utf8').trim();
        this.settings.secret = this.settings.secretJson ? JSON.parse(value).secret : value;
      }
      if (this.settings.endpoint !== CLOUDFLARE_SITE + '/api/handoff' ||
        !/^[a-f0-9]{64}$/.test(this.settings.secret)) throw new Error('Invalid handoff configuration');
      // Progress and changed sentences go every 60 seconds, up to 60 sentences a request. Every 15 seconds with 30 a request
      // it was about 16 Worker requests a minute with two channels on air (2026-11-25). A laptop that takes over
      // transcribes again at most about one more minute of the broadcast.
      this.timer = setInterval(() => this.flush().catch(error => {
        console.error(JSON.stringify({ event: 'handoff.sync_failed', error: error.message }));
      }), 60000); this.timer.unref();
    }
  }
  async request(video, data, after = '') {
    const url = this.settings.endpoint + '?video=' + encodeURIComponent(video) + (after ? '&after=' + encodeURIComponent(after) : '');
    const response = await fetch(url, { method: data ? 'POST' : 'GET',
      headers: { 'X-JC-Handoff-Key': this.settings.secret, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.any([AbortSignal.timeout(30000), this.stopping.signal]) });
    if (!response.ok) throw new Error('Handoff HTTP ' + response.status);
    return response.json();
  }
  importRows(rows, stream) {
    this.store.transaction(() => {
      for (const row of rows) {
        const s = row.segment, session = { ...row.session, state: 'stopped' };
        if (s.session_id !== session.session_id) throw new Error('Handoff session mismatch');
        this.store.db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?)').run(session.session_id, stream.stream_id, JSON.stringify(session));
        this.store.db.prepare('INSERT OR IGNORE INTO broadcast_sessions VALUES(?,?)').run(session.session_id, stream.broadcast_id);
        this.store.db.prepare('INSERT INTO segments VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,document=excluded.document WHERE excluded.version>segments.version')
          .run(s.segment_id, s.session_id, stream.stream_id, s.version, s.start_ms, JSON.stringify(s));
      }
    });
  }
  async resume(stream) {
    if (!this.settings || !stream.video_id) return null;
    let after = '', shared = null;
    do {
      const page = await this.request(stream.video_id, null, after);
      if (page.checkpoint?.video_id === stream.video_id) shared = page.checkpoint.video_ms;
      this.importRows(page.rows, stream); after = page.next;
    } while (after);
    const local = this.registry.sessions(stream.broadcast_id).filter(s => s.video_id === stream.video_id).map(processedPosition).filter(Number.isFinite);
    const positions = [...local, shared].filter(Number.isFinite);
    return positions.length ? Math.max(...positions) : null;
  }
  flush() {
    if (!this.settings || this.closed) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.publish().finally(() => { this.busy = null; }); return this.busy;
  }
  async publish() {
    for (const stream of this.store.streams().filter(s => s.broadcast_id && s.video_id)) {
      const session = this.scheduler.states().find(s => s.stream_id === stream.stream_id);
      if (!session || session.video_id !== stream.video_id || this.registry.forSession(session.session_id) !== stream.broadcast_id) continue;
      const position = processedPosition(session); if (position === null || position <= 0) continue;
      const sessions = new Map(this.registry.sessions(stream.broadcast_id).map(s => [s.session_id, s]));
      const rows = this.registry.segments(stream.broadcast_id).filter(s =>
        this.sent.get(s.segment_id) !== JSON.stringify(s)).map(segment => ({ segment,
        session: sessions.get(segment.session_id), broadcast_id: stream.broadcast_id }));
      for (let i = 0; i < rows.length; i += 60) {
        const batch = rows.slice(i, i + 60);
        await this.request(stream.video_id, { type: 'rows', rows: batch });
        for (const row of batch) this.sent.set(row.segment.segment_id, JSON.stringify(row.segment));
      }
      // An unchanged position is not sent again. A stopped session used to resend it every 15 seconds until restart,
      // 240 Worker calls and D1 writes an hour per channel.
      const key = stream.video_id + '/' + stream.broadcast_id;
      if (this.checkpoints.get(key) === position) continue;
      await this.request(stream.video_id, { type: 'checkpoint', video_id: stream.video_id,
        broadcast_id: stream.broadcast_id, video_ms: position, processor: this.settings.processor });
      this.checkpoints.set(key, position);
    }
  }
  // The last progress is still sent at shutdown, but for at most 10 seconds (each request alone could wait 30 seconds).
  async close() {
    clearInterval(this.timer); const limit = setTimeout(() => this.stopping.abort(), 10_000);
    try { await this.flush(); }
    catch (error) { console.error(JSON.stringify({ event: 'handoff.final_sync_failed', error: error.message })); }
    finally { clearTimeout(limit); this.closed = true; }
  }
}
