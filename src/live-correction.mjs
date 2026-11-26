import { randomUUID } from 'node:crypto';
import { correctionIssue, hallucination, modelChain, parseCorrections } from './ai-correction.mjs';
import { correctionPrompt } from './correction-prompt.mjs';
import { committees } from '../public/committees.mjs';
import { peopleGlossary } from './people-reference.mjs';

// Corrects each new recognition segment as soon as it is stored, so the public text follows the audio within seconds.
// Segments of one stream are corrected in order (each uses the previous corrected sentences as context);
// streams run in parallel. After hedgeMs a second request goes to the next model of the saved order (the same model when
// there is none) to cut slow-provider tails; the first valid answer is used.
export class LiveCorrection {
  // A refinement asks the next model after 20 s. Gemini 4 Hydrogen took 12.8 s on average for one sentence and over 9 s for 9
  // of 12 sentences (2026-11-20), so a 9 s wait would ask the next model for most of its refinements.
  constructor({ store, registry, ai, speakers = null, now = Date.now, hedgeMs = 3500, timeoutMs = 9000, refineTimeoutMs = 40000, refineHedgeMs = 20000, refineLimit = 16, nextWaitMs = 10000 }) {
    Object.assign(this, { store, registry, ai, speakers, now, hedgeMs, timeoutMs, refineTimeoutMs, refineHedgeMs, refineLimit, nextWaitMs });
    this.waiting = new Map();
    this.chains = new Map(); this.closed = false; this.inflight = ai.liveInflight = new Set();
    this.refining = new Set();
    ai.liveCorrectionBusy = id => this.refining.size > 0 || [...this.waiting.values()].some(item => item.broadcastId === id);
    this.metrics = { requests: 0, hedged: 0, applied: 0, held: 0, failed: 0, skipped: 0,
      refine_requests: 0, refine_hedged: 0, refine_applied: 0, refine_same: 0, refine_held: 0, refine_failed: 0, refine_skipped: 0 };
    this.listener = event => { if (event.kind === 'segment' && event.payload.version === 1) this.enqueue(event.payload); };
    store.on('event', this.listener);
  }
  enqueue(segment) {
    const settings = this.ai.settings();
    if (this.closed || !settings.automatic || settings.provider !== 'proxy' || !settings.model || !segment.raw_text?.trim()) return;
    const broadcastId = this.registry.forSession(segment.session_id);
    if (!broadcastId || this.registry.get(broadcastId)?.test_run === true) return;
    if (settings.refine_model && settings.refine_model !== settings.model) this.awaitNext(segment, broadcastId, settings);
    this.inflight.add(segment.segment_id);
    const chain = (this.chains.get(segment.stream_id) ?? Promise.resolve())
      .then(() => this.correct(segment, broadcastId, settings))
      .catch(() => { this.metrics.failed++; })
      .finally(() => this.inflight.delete(segment.segment_id));
    this.chains.set(segment.stream_id, chain);
  }
  context(segment) {
    return this.store.db.prepare('SELECT document FROM segments WHERE session_id=? AND start_ms<? ORDER BY start_ms DESC LIMIT 3')
      .all(segment.session_id, segment.start_ms).map(row => JSON.parse(row.document)).reverse()
      .map(row => row.corrected_text ?? row.raw_text);
  }
  glossary(record, field) {
    const committee = committees.find(item => item.stream_id === record?.stream_id);
    const members = committee ? committee.members.map(member => member.name + ' ' + (member.role === '위원' ? '위원' : member.role)) : [];
    const speakers = record?.speaker_glossary ?? this.speakers?.glossaryFor(committee?.name) ?? [];
    return { committee: committee?.name ?? '', text: [...new Set([...members, ...speakers, ...peopleGlossary(record ?? {}, this.speakers)])].concat(field.glossary.text ? [field.glossary.text] : []).join(', ').slice(0, 3000) };
  }
  request(messages, settings, { hedgeMs = this.hedgeMs, timeoutMs = this.timeoutMs, prefix = '' } = {}) {
    const controller = new AbortController();
    const chain = modelChain(settings);
    const attempt = model => { let used = model; return this.ai.requestText(messages, { ...settings, model }, controller.signal, value => { used = value; })
      .then(text => ({ text: parseCorrections(text, [{ id: 'S0' }]).get('S0'), model: used })); };
    return new Promise((resolve, reject) => {
      let started = 1; let failures = 0; let settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(hedge); clearTimeout(deadline); controller.abort(); callback(value); };
      const fail = error => { if (++failures >= started) finish(reject, error); };
      this.metrics[prefix + 'requests']++; attempt(chain[0]).then(value => finish(resolve, value), fail);
      const hedge = setTimeout(() => { started++; this.metrics[prefix + 'hedged']++; attempt(chain[1] ?? chain[0]).then(value => finish(resolve, value), fail); }, hedgeMs);
      const deadline = setTimeout(() => finish(reject, new Error('Live correction timeout')), timeoutMs);
    });
  }
  async correct(segment, broadcastId, settings) {
    if (this.closed) return;
    const current = () => {
      const row = this.store.db.prepare('SELECT document FROM segments WHERE id=?').get(segment.segment_id);
      const value = row && JSON.parse(row.document);
      return value && value.raw_text === segment.raw_text && value.corrected_text === null ? value : null;
    };
    if (!current()) { this.metrics.skipped++; return; }
    const field = this.ai.field(broadcastId); const context = this.ai.context(settings, field);
    const insert = candidate => this.store.db.prepare('INSERT INTO ai_candidates VALUES(?,?,?,?,?,?)')
      .run(candidate.id, broadcastId, segment.segment_id, candidate.source_version, context, JSON.stringify(candidate));
    const base = { id: randomUUID(), broadcast_id: broadcastId, segment_id: segment.segment_id, source_version: segment.version,
      source_text: segment.raw_text, model: settings.model, provider: settings.provider, start_ms: segment.start_ms, end_ms: segment.end_ms, live: true };
    if (hallucination(segment.raw_text, current())) { insert({ ...base, text: segment.raw_text, issue: 'hallucination', status: 'rejected', created_ms: this.now() }); return; }
    const glossary = this.glossary(this.registry.get(broadcastId), field);
    const messages = correctionPrompt({ style: 'minutes', committee: glossary.committee, glossary: glossary.text, context: this.context(segment),
      segments: [{ id: 'S0', text: segment.raw_text }] });
    const { text, model } = await this.request(messages, settings);
    if (this.closed) return;
    const latest = current();
    if (!latest) { this.metrics.skipped++; return; }
    let candidate = { ...base, source_version: latest.version, text, model, glossary: field.glossary.text, issue: correctionIssue(segment.raw_text, text), status: 'pending', created_ms: this.now() };
    insert(candidate);
    if (candidate.issue && settings.auto_apply_safe) {
      // A flagged minutes-style edit falls back to a word-preserving correction that can still be published automatically.
      const plain = await this.request(correctionPrompt({ style: 'plain', glossary: glossary.text, segments: [{ id: 'S0', text: segment.raw_text }] }), settings).catch(() => null);
      const again = current();
      if (plain && again && !this.closed) {
        candidate = { ...base, id: randomUUID(), source_version: again.version, text: plain.text, model: plain.model, glossary: field.glossary.text,
          issue: correctionIssue(segment.raw_text, plain.text), status: 'pending', created_ms: this.now(), fallback: true };
        insert(candidate); this.metrics.fallback = (this.metrics.fallback ?? 0) + 1;
      }
    }
    if (candidate.issue || !settings.auto_apply_safe) { this.metrics.held++; return; }
    try { this.ai.apply(candidate.id); this.metrics.applied++; } catch (error) { if (error.status !== 409) throw error; this.metrics.skipped++; }
  }
  input(segment) {
    return { id: 'S0', text: segment.raw_text };
  }
  // Each segment is refined once the next segment of the same stream arrives (or after nextWaitMs), so the refinement
  // model can repair words cut at the chunk boundary. Its result replaces the fast correction (or fills a held one)
  // when it passes the same checks and no administrator has edited the sentence meanwhile.
  awaitNext(segment, broadcastId, settings) {
    const previous = this.waiting.get(segment.stream_id);
    if (previous) {
      clearTimeout(previous.timer); this.waiting.delete(segment.stream_id);
      this.refine(previous.segment, previous.broadcastId, settings, previous.segment.session_id === segment.session_id ? segment.raw_text : '');
    }
    const timer = setTimeout(() => {
      if (this.waiting.get(segment.stream_id)?.segment !== segment) return;
      this.waiting.delete(segment.stream_id); this.refine(segment, broadcastId, settings, '');
    }, this.nextWaitMs);
    timer.unref?.();
    this.waiting.set(segment.stream_id, { segment, broadcastId, timer });
  }
  refine(segment, broadcastId, settings, next) {
    if (this.closed || hallucination(segment.raw_text, segment)) return;
    if (this.refining.size >= this.refineLimit) { this.metrics.refine_skipped++; return; }
    const field = this.ai.field(broadcastId); const context = this.ai.context(settings, field);
    const glossary = this.glossary(this.registry.get(broadcastId), field);
    const messages = correctionPrompt({ style: 'minutes', committee: glossary.committee, glossary: glossary.text, context: this.context(segment), next,
      segments: [this.input(segment)] });
    const task = this.request(messages, { ...settings, model: settings.refine_model }, { hedgeMs: this.refineHedgeMs, timeoutMs: this.refineTimeoutMs, prefix: 'refine_' })
      .then(({ text, model }) => {
        if (this.closed) return;
        const row = this.store.db.prepare('SELECT document FROM segments WHERE id=?').get(segment.segment_id);
        const value = row && JSON.parse(row.document);
        const last = this.store.db.prepare('SELECT document FROM corrections WHERE segment_id=? ORDER BY version DESC LIMIT 1').get(segment.segment_id);
        const origin = last ? JSON.parse(last.document).origin : null;
        if (!value || value.raw_text !== segment.raw_text || (value.corrected_text !== null && origin !== 'ai')) { this.metrics.refine_skipped++; return; }
        if (value.corrected_text === text) { this.metrics.refine_same++; return; }
        const candidate = { id: randomUUID(), broadcast_id: broadcastId, segment_id: segment.segment_id, source_version: value.version, source_text: segment.raw_text,
          text, model, provider: settings.provider, glossary: field.glossary.text, start_ms: segment.start_ms, end_ms: segment.end_ms,
          issue: correctionIssue(segment.raw_text, text), status: 'pending', created_ms: this.now(), live: true, refine: true };
        this.store.db.prepare('INSERT INTO ai_candidates VALUES(?,?,?,?,?,?)')
          .run(candidate.id, broadcastId, segment.segment_id, candidate.source_version, context, JSON.stringify(candidate));
        if (candidate.issue || !settings.auto_apply_safe) { this.metrics.refine_held++; return; }
        try { this.ai.apply(candidate.id); this.metrics.refine_applied++; } catch (error) { if (error.status !== 409) throw error; this.metrics.refine_skipped++; }
      })
      .catch(() => { this.metrics.refine_failed++; })
      .finally(() => this.refining.delete(entry));
    const entry = { task }; this.refining.add(entry);
  }
  async close() {
    this.closed = true; this.store.off('event', this.listener);
    for (const item of this.waiting.values()) clearTimeout(item.timer);
    this.waiting.clear(); await Promise.allSettled(this.chains.values());
    await Promise.allSettled([...this.refining].map(entry => entry.task));
  }
}



