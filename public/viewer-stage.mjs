import { OfficialPlayer } from './player.mjs';
import { transcriptNodes } from './transcripts.mjs';
import { committeeMembers } from './committee-members.mjs';
import { viewerHealthMessage, TranscriptHistory, mergeTranscriptItems, deliveryMetricsText, meetingStateText, meetingPause, publicItem } from './client-state.mjs';
import { speakerText } from './speakers.mjs';

const BIG_SIZES = ['small', 'medium', 'large'];
// The whole record of the broadcast is shown at once (2026-11-21). One page holds 2,000 sentences, a full-day meeting
// (11-12 3차 본회의: 2,040 sentences, about 1 MB). An engine that still allows 200 sentences per page is read in pages of 200.
const HISTORY_PAGE = 2000;
// A sentence that left the pending list without its corrected text is looked up at most this many times.
const DRAFT_LOOKUPS = 2;

export class ViewerStage {
  constructor(options) {
    this.options = options; this.stream = options.stream; this.history = new TranscriptHistory(); this.muted = true;
    this.sourceEpoch = 0; this.nodeCache = new Map(); this.typing = new Map(); this.lookups = new Map();
    this.element = document.createElement('article'); this.element.className = 'watch-panel';
    this.element.dataset.stream = this.stream.stream_id;
    this.element.innerHTML = '<div class="panel-heading"><h2></h2><div class="row"><button class="secondary sound">소리 켜기</button>'
      + '<button class="secondary big-open">크게 보기</button><button class="secondary close">닫기</button></div></div>'
      + '<div class="video-frame"></div><div class="video-info"><p role="status"></p><a target="_blank" rel="noopener noreferrer">공식 영상 열기</a></div>'
      + '<div class="transcript-controls"><h3>회의록 받아쓰기</h3><label>문장 검색<input type="search" maxlength="200" placeholder="후보정문 검색"></label>'
      + '<label class="check"><input type="checkbox" checked> 새 문장으로 이동</label></div>'
      + '<p class="transcription-progress" role="status" hidden>받아쓰기 처리중<span class="processing-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></p>'
      + '<p class="gap-note" hidden>음성이 누락된 구간이 있습니다. 원음과 함께 확인해 주세요.</p>'
      + '<p class="help delivery-health" role="status" hidden></p>'
      + '<p class="help delivery-metrics" hidden></p>'
      + '<p class="help transcript-clock-note">영상 시간은 수집 구간 기준이며, 재연결하면 0부터 시작합니다. 실제 영상 재생 위치와 다를 수 있습니다.</p>'
      + '<div class="transcript" tabindex="0"></div><div class="panel-footer"><button class="secondary latest">최신 문장 보기</button></div>'
      + '<section class="big-captions" aria-label="큰 자막" hidden><div class="big-toolbar"><div class="big-sizes" role="group" aria-label="자막 글자 크기">'
      + '<button type="button" class="secondary" data-size="small">작게</button><button type="button" class="secondary" data-size="medium">보통</button>'
      + '<button type="button" class="secondary" data-size="large">크게</button></div><button type="button" class="secondary big-close">작게 보기</button></div>'
      + '<div class="big-previous"></div><div class="big-current"><p class="big-meta"></p><p class="big-text"></p></div><p class="big-status"></p></section>';
    const layout = document.createElement('div'); layout.className = 'watch-layout';
    const content = document.createElement('div'); content.className = 'watch-content';
    while (this.element.children.length > 1) content.append(this.element.children[1]);
    layout.append(committeeMembers(this.stream.stream_id), content); this.element.append(layout);
    const find = selector => this.element.querySelector(selector);
    this.title = find('h2'); this.video = find('.video-frame'); this.note = find('.video-info p'); this.link = find('.video-info a');
    this.transcript = find('.transcript'); this.search = find('input[type=search]'); this.follow = find('input[type=checkbox]');
    this.soundButton = find('.sound'); this.pageSize = HISTORY_PAGE;
    // Shown above the earliest sentence while earlier sentences are still loading.
    this.historyStatus = document.createElement('p'); this.historyStatus.className = 'help history-status'; this.historyStatus.setAttribute('role', 'status');
    // The progress line is repeated after the newest sentence, where the next sentence will appear.
    this.progress = find('.transcription-progress'); this.tailProgress = this.progress.cloneNode(true);
    this.tailProgress.removeAttribute('role'); this.tailProgress.setAttribute('aria-hidden', 'true');
    this.player = new OfficialPlayer(this.video, value => { this.note.textContent = value; }, { viewer: true, muted: true });
    find('.close').addEventListener('click', options.close);
    this.bigButton = find('.big-open'); this.big = find('.big-captions');
    this.bigButton.addEventListener('click', () => this.openBig());
    find('.big-close').addEventListener('click', () => this.closeBig());
    for (const button of this.big.querySelectorAll('[data-size]')) button.addEventListener('click', () => this.setBigSize(button.dataset.size));
    let size = null; try { size = localStorage.getItem('jc-big-caption-size'); } catch { /* Storage may be blocked; use the default size. */ }
    this.setBigSize(BIG_SIZES.includes(size) ? size : 'medium', false);
    // Leaving browser full screen (Esc) also leaves the large caption view; Esc closes the overlay where full screen is unavailable.
    this.onFullscreen = () => { if (this.bigFullscreen && document.fullscreenElement !== this.element) this.closeBig(); };
    this.onKey = event => { if (event.key === 'Escape' && !this.big.hidden) this.closeBig(); };
    document.addEventListener('fullscreenchange', this.onFullscreen); document.addEventListener('keydown', this.onKey);
    this.soundButton.addEventListener('click', () => { if (this.muted) options.sound(); this.setMuted(!this.muted); });
    // The whole record is loaded, so the search box filters every sentence of the broadcast.
    this.search.addEventListener('input', () => this.render());
    this.follow.addEventListener('change', () => this.render());
    this.transcript.addEventListener('scroll', () => {
      const top = this.transcript.scrollTop;
      const upward = top < (this.lastScrollTop ?? 0) - 1;
      const below = this.transcript.scrollHeight - this.transcript.clientHeight - top;
      this.lastScrollTop = top;
      // Moving up to read earlier sentences pauses following; scrolling back down to the newest sentence resumes it.
      // A position that stays at the bottom while the content shrinks (font load, wider panel) is not a user scroll.
      const reading = upward && below > 2;
      if (reading) this.follow.checked = false;
      else if (!upward && below <= 40) this.follow.checked = true;
    });
    find('.latest').addEventListener('click', () => { this.search.value = ''; this.follow.checked = true; this.render(); });
    this.update(this.stream, true);
  }
  setMuted(value) {
    this.muted = value; this.player.setMuted(value); this.soundButton.textContent = value ? '소리 켜기' : '소리 끄기';
    this.soundButton.setAttribute('aria-pressed', String(!value));
  }
  update(stream, initial = false) {
    const changed = initial || this.stream.video_id !== stream.video_id || this.stream.page_url !== stream.page_url;
    const source = stream.broadcast_id || stream.video_id || stream.page_url || '';
    if (!initial && this.source !== source) {
      this.sourceEpoch++; this.request?.abort(); this.request = null; clearTimeout(this.retryTimer); this.retryTimer = null;
      this.history = new TranscriptHistory(); this.nodeCache.clear(); this.historyError = ''; this.failures = 0; this.loadedOnce = false;
      for (const frame of this.typing.values()) cancelAnimationFrame(frame); this.typing.clear();
      this.reconcileRequest?.abort(); this.reconcileRequest = null; this.reconcileAfter = 0; this.lookups.clear();
    }
    this.source = source;
    this.stream = stream; this.title.textContent = stream.name; this.link.href = stream.page_url || '#'; this.link.hidden = !stream.page_url;
    this.transcript.setAttribute('aria-label', stream.name + ' 회의록 받아쓰기'); this.element.setAttribute('aria-label', stream.name);
    this.soundButton.disabled = !stream.video_id;
    if (changed) { this.note.textContent = '영상을 불러옵니다.'; this.player.select(stream).catch(() => { this.note.textContent = '영상을 불러오지 못했습니다. 공식 영상 링크를 이용해 주세요.'; }); }
  }
  render() {
    if (!this.request) this.history.update([...this.options.state.segments.values()].filter(item => item.stream_id === this.stream.stream_id), this.options.before);
    this.history.reconcilePending(this.options.state.livePending?.get(this.stream.stream_id), this.stream.broadcast_id);
    this.renderHealth();
    const query = this.search.value.trim().toLocaleLowerCase();
    const items = this.history.items.filter(item => !query || item.text?.toLocaleLowerCase().includes(query));
    const top = this.transcript.scrollTop;
    const edge = this.transcript.getBoundingClientRect().top;
    // A reader who left the newest sentence keeps the first visible sentence in place while sentences are added around it.
    const anchor = this.follow.checked ? null : [...this.transcript.children].find(node => node.id && node.getBoundingClientRect().bottom > edge);
    const offset = anchor?.getBoundingClientRect().top - edge;
    const nodes = items.filter(item => (item.ai_corrected === true || item.display_state === 'draft') && item.text?.trim()).map(item => {
      const cached = this.nodeCache.get(item.segment_id);
      if (cached?.item.version === item.version && cached.item.text === item.text && cached.item.display_state === item.display_state) return cached.node;
      this.cancelTyping(item.segment_id);
      const node = transcriptNodes([item], { publicOnly: true, livePreview: true }).firstElementChild;
      if (!cached && item.display_state === 'draft' && this.follow.checked && Date.now() - item.audio_received_ms < 120000) this.typeDraft(node, item);
      this.nodeCache.set(item.segment_id, { item, node }); return node;
    });
    // The status line shows only while earlier sentences can still arrive; a channel without a broadcast has no record to load.
    // Before the first page arrives, the empty list itself says that the record is on its way.
    const pending = this.history.cursor > 0 && Boolean(this.stream.broadcast_id || this.history.items.length);
    const loading = pending && (nodes.length || this.historyError) ? [this.historyStatus] : [];
    this.historyStatus.textContent = this.historyError || '이전 기록을 불러오고 있습니다.';
    const next = [...loading, ...(nodes.length ? nodes : [transcriptNodes([], { publicOnly: true,
      empty: query ? '검색한 문장이 없습니다.' : this.awaitingRecord() ? '방송 기록을 불러옵니다.' : '방송 음성을 기다립니다.' })]), this.tailProgress];
    // Only the list after the first changed sentence is replaced. Rebuilding a whole meeting (1,679 sentences) on every
    // health event took about 65 ms on a desktop PC (2026-11-21).
    const shown = this.transcript.children; let same = 0;
    while (same < next.length && shown[same] === next[same]) same++;
    while (shown.length > same) this.transcript.lastElementChild.remove();
    this.transcript.append(...next.slice(same));
    for (const item of items) if (['removed', 'reconciling'].includes(item.display_state)) { this.cancelTyping(item.segment_id); this.nodeCache.delete(item.segment_id); }
    const restored = anchor?.id ? this.transcript.querySelector('#' + CSS.escape(anchor.id)) : null;
    this.transcript.scrollTop = this.follow.checked ? this.transcript.scrollHeight
      : restored ? this.transcript.scrollTop + restored.getBoundingClientRect().top - edge - offset : top;
    this.lastScrollTop = this.transcript.scrollTop;
    this.markTarget();
    this.element.querySelector('.gap-note').hidden = !this.options.state.gaps.has(this.stream.stream_id);
    this.reconcileDrafts();
    this.loadHistory();
    this.renderBig();
  }
  async openBig() {
    if (!this.big.hidden) return;
    this.element.classList.add('big-view'); this.big.hidden = false; document.documentElement.classList.add('has-big-view');
    this.renderBig(); this.big.querySelector('.big-close').focus();
    this.bigFullscreen = false;
    try { await this.element.requestFullscreen(); this.bigFullscreen = !this.big.hidden; } catch { /* iPhone and embedded views keep the fixed overlay. */ }
  }
  closeBig({ restoreFocus = true } = {}) {
    if (this.big.hidden) return;
    this.element.classList.remove('big-view'); this.big.hidden = true;
    if (!document.querySelector('.watch-panel.big-view')) document.documentElement.classList.remove('has-big-view');
    const fullscreen = this.bigFullscreen; this.bigFullscreen = false;
    if (fullscreen && document.fullscreenElement === this.element) document.exitFullscreen().catch(() => {});
    if (restoreFocus) this.bigButton.focus();
  }
  setBigSize(size, save = true) {
    this.element.dataset.bigSize = size;
    for (const button of this.big.querySelectorAll('[data-size]')) button.setAttribute('aria-pressed', String(button.dataset.size === size));
    if (save) try { localStorage.setItem('jc-big-caption-size', size); } catch { /* The size still applies for this visit. */ }
  }
  renderBig() {
    if (this.big.hidden) return;
    const items = this.history.items.filter(publicItem); const current = items.at(-1);
    this.big.querySelector('.big-previous').replaceChildren(...items.slice(-3, -1).map(item => {
      const line = document.createElement('p'); line.textContent = item.text; return line;
    }));
    const speaker = current ? speakerText(current) : '';
    this.big.querySelector('.big-meta').textContent = current ? ['지금 발언', speaker, current.display_state === 'draft' ? '1차 받아쓰기' : ''].filter(Boolean).join(' · ') : '';
    this.big.querySelector('.big-text').textContent = current?.text ?? '발언이 시작되면 이곳에 큰 글씨로 표시합니다.';
    this.big.querySelector('.big-status').textContent = this.element.querySelector('.delivery-health').textContent;
  }
  // Rendering can replace sentence nodes while the snapshot and history load, so the alert's mark is re-applied until it expires.
  markTarget() {
    const active = this.target && Date.now() < this.target.until;
    for (const node of this.transcript.querySelectorAll('.segment.is-target')) if (!active || node.id !== 'segment-' + this.target.id) node.classList.remove('is-target');
    if (active) this.transcript.querySelector('#segment-' + CSS.escape(this.target.id))?.classList.add('is-target');
  }
  // Opens the newest copy of a sentence from a keyword alert; the snapshot may still be loading for a newly selected channel.
  reveal(segmentId, attempt = 0) {
    const node = this.transcript.querySelector('#segment-' + CSS.escape(segmentId));
    if (!node) { if (attempt < 5 && !this.disposed) setTimeout(() => this.reveal(segmentId, attempt + 1), 1000); return; }
    this.target = { id: segmentId, until: Date.now() + 4000 }; this.markTarget();
    this.follow.checked = false; node.scrollIntoView({ block: 'center' });
    setTimeout(() => { if (!this.disposed) this.markTarget(); }, 4100);
  }
  // Looks up sentences that left the pending list of a snapshot ('reconciling') before their corrected text arrived.
  // A draft still on the list waits for its correction, which comes as an event or with the next snapshot, so it is not
  // looked up: a draft held for review is not on the public pages until it is approved. Each sentence is looked up at most
  // DRAFT_LOOKUPS times because a removed sentence is never found. Looking every 30 seconds for drafts held for review made
  // 73-74% of the Worker requests on 2026-11-25 (docs/CLOUDFLARE.md).
  async reconcileDrafts() {
    if (this.disposed || this.reconcileRequest || Date.now() < (this.reconcileAfter ?? 0)) return;
    const missing = this.history.items.filter(item => item.display_state === 'reconciling' && Number.isSafeInteger(item.sequence)
      && !this.options.state.segments.has(item.segment_id) && (this.lookups.get(item.segment_id) ?? 0) < DRAFT_LOOKUPS);
    if (!missing.length) return;
    for (const item of missing) this.lookups.set(item.segment_id, (this.lookups.get(item.segment_id) ?? 0) + 1);
    const epoch = this.sourceEpoch; const controller = new AbortController(); this.reconcileRequest = controller;
    this.reconcileAfter = Date.now() + 30000;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const min = Math.min(...missing.map(item => item.sequence)); let before = Math.max(...missing.map(item => item.sequence)) + 1;
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = await (await this.options.api(this.historyUrl(200) + '&before=' + before, { signal: controller.signal })).json();
        if (this.disposed || epoch !== this.sourceEpoch) return;
        this.checkBroadcast(page);
        this.history.items = mergeTranscriptItems(this.history.items, page.items);
        const next = page.before ?? 0;
        if (next <= min || next >= before) break;
        before = next;
      }
      this.render();
    } catch { /* Retry with the next snapshot; keep the last received text readable. */ }
    finally { clearTimeout(timer); if (this.reconcileRequest === controller) this.reconcileRequest = null; }
  }
  // The earlier record loads by itself up to the first sentence of the broadcast; viewers do not ask for it. The first request
  // takes the newest page, so it also covers a snapshot that arrives later, and the viewers of one meeting send the same request
  // (the desktop answers it from a short cache). A failed page is requested again after about 2 seconds, doubling up to a
  // minute with random spread. An engine that allows 200 sentences per page refuses the larger page with 400, and loading goes
  // on with 200; a 409 (the broadcast changed) is retried like a failed page until the new broadcast arrives.
  async loadHistory() {
    // A channel chosen before its first snapshot has no broadcast yet; its record loads once the broadcast is known.
    if (this.disposed || this.request || this.retryTimer || this.history.cursor === 0 || (!this.stream.broadcast_id && !this.history.items.length)) return;
    const epoch = this.sourceEpoch; const requested = this.loadedOnce ? this.history.cursor : Number.MAX_SAFE_INTEGER;
    const controller = new AbortController(); this.request = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    let retryMs = null;
    try {
      const page = await (await this.options.api(this.historyUrl(this.pageSize) + '&before=' + requested, { signal: controller.signal })).json();
      if (this.disposed || epoch !== this.sourceEpoch) return;
      this.checkBroadcast(page); this.history.addPage(page, requested); this.loadedOnce = true; this.historyError = ''; this.failures = 0;
    } catch (error) {
      if (this.disposed || epoch !== this.sourceEpoch) return;
      if (error.status === 400 && this.pageSize > 200) { this.pageSize = 200; retryMs = 0; }
      else {
        this.failures = (this.failures ?? 0) + 1; retryMs = Math.round(Math.min(60000, 2000 * 2 ** (this.failures - 1)) * (0.5 + Math.random()));
        this.historyError = '연결이 원활하지 않아 이전 기록을 자동으로 다시 불러오고 있습니다.';
      }
    } finally {
      clearTimeout(timer);
      if (this.request === controller) {
        this.request = null;
        if (retryMs !== null) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.render(); }, retryMs);
        this.render();
      }
    }
  }
  // Until the channel's snapshot or the first page of its record arrives, an empty list means the record is on its way.
  awaitingRecord() {
    return !this.history.items.length && (this.options.hasSnapshot?.() === false || (Boolean(this.stream.broadcast_id) && !this.loadedOnce));
  }
  historyUrl(limit) {
    return '/api/segments?stream=' + encodeURIComponent(this.stream.stream_id) + '&limit=' + limit
      + (this.stream.broadcast_id ? '&broadcast=' + encodeURIComponent(this.stream.broadcast_id) : '');
  }
  checkBroadcast(page) {
    if (page.broadcast_id && this.stream.broadcast_id && page.broadcast_id !== this.stream.broadcast_id)
      throw new Error('방송이 변경되었습니다. 새 방송 기록을 다시 불러와 주세요.');
  }
  renderHealth() {
    const note = this.element.querySelector('.delivery-health');
    const health = this.options.state.health.get(this.stream.stream_id);
    // During a recess or after adjournment the engine keeps decoding room sound, but nothing is being written down.
    // The note then drops the "transcribing" and "no speech detected" sentences and keeps warnings.
    const pause = meetingPause(this.history.items);
    const pending = this.history.items.some(item => item.display_state === 'draft');
    const status = pause && ['processing', 'silent'].includes(health?.status) ? '' : viewerHealthMessage(health);
    note.textContent = [status, meetingStateText(health, pause)].filter(Boolean).join(' ');
    if (!pause && pending && health?.status === 'ready') note.textContent = '1차 받아쓰기를 표시합니다. AI 후보정이 끝나면 자동으로 바뀝니다.';
    note.hidden = !note.textContent;
    const metrics = this.element.querySelector('.delivery-metrics');
    metrics.textContent = deliveryMetricsText(health); metrics.hidden = !metrics.textContent;
    const busy = !pause && (health?.stages?.transcription === 'processing' || health?.stages?.correction === 'processing'
      || (pending && !['delayed', 'correction_delayed'].includes(health?.status)));
    this.progress.hidden = !busy;
    this.tailProgress.hidden = !busy || Boolean(this.search.value.trim());
  }
  cancelTyping(id) {
    const frame = this.typing.get(id); if (frame !== undefined) cancelAnimationFrame(frame); this.typing.delete(id);
  }
  typeDraft(node, item) {
    if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const text = node.querySelector('span');
    const letters = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(item.text)].map(part => part.segment);
    const duration = Math.min(1200, letters.length * 24); const start = performance.now();
    text.textContent = letters[0] ?? ''; text.setAttribute('aria-label', item.text);
    const tick = now => {
      const count = Math.min(letters.length, Math.max(1, Math.ceil(letters.length * (now - start) / Math.max(1, duration))));
      text.textContent = letters.slice(0, count).join('');
      if (this.follow.checked) { this.transcript.scrollTop = this.transcript.scrollHeight; this.lastScrollTop = this.transcript.scrollTop; }
      if (count < letters.length && !this.disposed) this.typing.set(item.segment_id, requestAnimationFrame(tick));
      else { this.typing.delete(item.segment_id); text.removeAttribute('aria-label'); }
    };
    this.typing.set(item.segment_id, requestAnimationFrame(tick));
  }
  dispose() { this.closeBig({ restoreFocus: false }); document.removeEventListener('fullscreenchange', this.onFullscreen); document.removeEventListener('keydown', this.onKey);
    this.disposed = true; this.request?.abort(); clearTimeout(this.retryTimer); this.reconcileRequest?.abort();
    for (const frame of this.typing.values()) cancelAnimationFrame(frame); this.typing.clear(); this.player.dispose(); this.element.remove(); }
}
