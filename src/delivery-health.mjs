import { publicSpeech } from './silence-filter.mjs';

const ACTIVE = new Set(['running', 'draining', 'degraded', 'reconnecting']);
const LIMIT = 256;
const stamp = value => Number.isFinite(value) && value >= 0 ? value : null;
const age = (now, value) => value === null ? null : Math.max(0, now - value);
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
const latest = values => values.filter(value => value !== null).reduce((a, b) => Math.max(a ?? 0, b), null);

export function publicationHealth(context, now = Date.now()) {
  const publisher = context.cloudSync ?? (typeof context.view === 'function' && context.known instanceof Map ? context : null);
  const view = publisher?.view() ?? { enabled: false, phase: 'disabled' };
  const last_published_ms = stamp(view.published_ms);
  const phase = view.live_phase ?? view.phase;
  const stale_after_ms = Math.max(120000, positive(publisher?.settings?.interval_ms, 60000) * 3);
  const delayed = ['blocked', 'retry'].includes(phase)
    || (view.enabled && last_published_ms !== null && now - last_published_ms > stale_after_ms);
  return { status: delayed ? 'delayed' : !view.enabled ? 'disabled'
    : ['waiting', 'publishing', 'published'].includes(phase) ? phase : 'waiting',
  last_published_ms, stale_after_ms };
}

function segmentHealth(store, sessionId) {
  if (!sessionId) return { pending: [], limited: false, last_corrected_ms: null };
  // Both reads stay inside the session's indexed correction state and stop at a fixed limit.
  const pendingRows = store.db.prepare(`SELECT document FROM segments WHERE session_id=?
    AND json_extract(document,'$.ai_corrected')=0 ORDER BY start_ms LIMIT ?`).all(sessionId, LIMIT + 1);
  const pending = pendingRows.slice(0, LIMIT).map(row => JSON.parse(row.document))
    .filter(row => typeof row.raw_text === 'string' && row.raw_text.trim() && publicSpeech(row));
  const corrected = store.db.prepare(`SELECT id FROM segments WHERE session_id=?
    AND json_extract(document,'$.ai_corrected')=1 ORDER BY start_ms DESC LIMIT 16`).all(sessionId);
  const correctedAt = store.db.prepare(`SELECT json_extract(document,'$.created_ms') AS created_ms
    FROM corrections WHERE segment_id=? AND json_extract(document,'$.origin')='ai' ORDER BY id DESC LIMIT 1`);
  return { pending, limited: pendingRows.length > LIMIT,
    last_corrected_ms: latest(corrected.map(row => stamp(correctedAt.get(row.id)?.created_ms))) };
}

export function deliveryHealth(context, ids, { now = Date.now(), states, admin = false } = {}) {
  const { store, scheduler } = context;
  const current = states ?? [...new Map([...store.states(), ...scheduler.states()].map(state => [state.stream_id, state])).values()];
  const publication = publicationHealth(context, now);
  const config = context.config ?? scheduler.config ?? {};
  const receiveLimit = positive(config.ingestionDelayMs, 15000);
  const processLimit = positive(config.transcriptionDelayMs, 30000);
  const correctionLimit = positive(config.correctionDelayMs, 60000);
  const health = ids.map(stream_id => {
    const state = current.find(item => item.stream_id === stream_id);
    const active = ACTIVE.has(state?.state);
    const channel = scheduler.channels?.get(stream_id);
    const facts = segmentHealth(store, state?.session_id);
    const last_received_ms = stamp(state?.last_receive_ms);
    const last_processed_ms = stamp(state?.last_processed_ms);
    const last_corrected_ms = facts.last_corrected_ms;
    const oldest = facts.pending.map(row => stamp(row.ready_ms ?? row.audio_received_ms)).filter(value => value !== null);
    const pendingAge = age(now, oldest.length ? Math.min(...oldest) : null);
    const receiveAge = age(now, last_received_ms ?? stamp(state?.started_ms));
    const processingAge = age(now, last_processed_ms ?? stamp(state?.started_ms));
    const queueLength = Math.max(0, state?.queue_length ?? 0);
    const inflight = Boolean(channel?.inflight);
    const queued = queueLength > 0 || inflight || (state?.audio_received_until ?? 0) > (state?.audio_processed_until ?? 0);
    const inputDelayed = active && state.state !== 'draining' && receiveAge !== null && receiveAge > receiveLimit;
    const engineFailed = active && (scheduler.engine?.ready === false || Boolean(state.error));
    const transcriptionDelayed = engineFailed || (active && queued && ((state?.queue_oldest_ms ?? 0) > processLimit
      || (processingAge !== null && processingAge > processLimit)));
    const correctionDelayed = facts.pending.length > 0 && pendingAge !== null && pendingAge > correctionLimit;
    const silent = active && last_processed_ms !== null && state?.last_processing_result === 'silent';
    const stages = {
      ingestion: inputDelayed ? 'delayed' : !active ? 'stopped' : last_received_ms === null ? 'waiting' : 'ready',
      transcription: transcriptionDelayed ? 'delayed' : !active ? 'stopped' : silent && !queued ? 'silent' : queued ? 'processing' : last_processed_ms === null ? 'waiting' : 'ready',
      correction: correctionDelayed ? 'delayed' : facts.pending.length ? 'processing' : last_corrected_ms === null ? 'waiting' : 'ready',
      publication: publication.status
    };
    let status = !state ? 'waiting' : !active ? 'stopped' : silent && !facts.pending.length ? 'silent'
      : queued || facts.pending.length ? 'processing' : last_processed_ms === null ? 'waiting' : 'ready';
    let stage = null;
    if (inputDelayed) { status = 'delayed'; stage = 'ingestion'; }
    if (transcriptionDelayed) { status = 'delayed'; stage = 'transcription'; }
    if (correctionDelayed && !stage) { status = 'correction_delayed'; stage = 'correction'; }
    if (publication.status === 'delayed' && !stage) { status = 'delayed'; stage = 'publication'; }
    const message = stage === 'ingestion' ? '음성 수신이 지연되고 있습니다. 방송 연결 상태를 확인해 주세요.'
      : stage === 'transcription' ? '음성 인식이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.'
      : stage === 'correction' ? '발언 문장 교정이 지연되고 있습니다. 교정이 끝나면 표시합니다.'
      : stage === 'publication' ? '공개 화면 갱신이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.'
      : status === 'silent' ? '음성을 수신하고 있습니다. 최근 처리 구간에서 발언을 확인하지 못했습니다.'
      : status === 'processing' ? '수신한 음성을 처리하고 있습니다. 교정이 끝나면 발언을 표시합니다.'
      : status === 'stopped' ? '음성 처리가 종료되었습니다. 저장된 발언을 확인할 수 있습니다.'
      : status === 'ready' ? '최근 음성 처리를 마쳤습니다. 새 발언을 수신하면 표시합니다.'
      : '음성 수신을 기다리고 있습니다. 방송 시작 여부를 확인해 주세요.';
    return { stream_id, status, stage, message, last_received_ms, last_processed_ms, last_corrected_ms, stages,
      ...(admin ? { pending_corrections: facts.pending.length, pending_count_limited: facts.limited,
        oldest_pending_age_ms: pendingAge, queue_length: queueLength, inflight,
        alerts: Object.entries(stages).filter(([, value]) => value === 'delayed').map(([name]) => name) } : {}) };
  });
  return { health, publication };
}
