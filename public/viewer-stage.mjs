import { OfficialPlayer } from './player.mjs';
import { transcriptNodes } from './transcripts.mjs';
import { committeeMembers } from './committee-members.mjs';
import { viewerHealthMessage, TranscriptHistory, mergeTranscriptItems } from './client-state.mjs';

export class ViewerStage {
  constructor(options) {
    this.options = options; this.stream = options.stream; this.history = new TranscriptHistory(); this.muted = true;
    this.sourceEpoch = 0; this.nodeCache = new Map(); this.typing = new Map();
    this.element = document.createElement('article'); this.element.className = 'watch-panel';
    this.element.dataset.stream = this.stream.stream_id;
    this.element.innerHTML = '<div class="panel-heading"><h2></h2><div class="row"><button class="secondary sound">소리 켜기</button>'
      + '<button class="secondary fullscreen">전체 화면</button><button class="secondary close">닫기</button></div></div>'
      + '<div class="video-frame"></div><div class="video-info"><p role="status"></p><a target="_blank" rel="noopener noreferrer">공식 영상 열기</a></div>'
      + '<div class="transcript-controls"><h3>회의록 받아쓰기</h3><label>문장 검색<input type="search" maxlength="200" placeholder="후보정문 검색"></label>'
      + '<button class="secondary search-all">전체 기록 검색</button>'
      + '<label class="check"><input type="checkbox" checked> 새 문장으로 이동</label></div>'
      + '<p class="transcription-progress" role="status" hidden>받아쓰기 처리중<span class="processing-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></p>'
      + '<p class="gap-note" hidden>음성이 누락된 구간이 있습니다. 원음과 함께 확인해 주세요.</p>'
      + '<p class="help delivery-health" role="status" hidden></p>'
      + '<p class="help transcript-clock-note">영상 시간은 수집 구간 기준이며, 재연결하면 0부터 시작합니다. 실제 영상 재생 위치와 다를 수 있습니다.</p>'
      + '<div class="panel-footer row"><button class="secondary history">이전 기록 불러오기</button><span class="help history-status" role="status"></span></div>'
      + '<div class="transcript" tabindex="0"></div><div class="panel-footer"><button class="secondary latest">최신 문장 보기</button></div>';
    const layout = document.createElement('div'); layout.className = 'watch-layout';
    const content = document.createElement('div'); content.className = 'watch-content';
    while (this.element.children.length > 1) content.append(this.element.children[1]);
    layout.append(committeeMembers(this.stream.stream_id), content); this.element.append(layout);
    const find = selector => this.element.querySelector(selector);
    this.title = find('h2'); this.video = find('.video-frame'); this.note = find('.video-info p'); this.link = find('.video-info a');
    this.transcript = find('.transcript'); this.search = find('input[type=search]'); this.follow = find('input[type=checkbox]');
    this.soundButton = find('.sound'); this.historyButton = find('.history');
    this.historyStatus = find('.history-status');
    find('.search-all').addEventListener('click', () => this.searchAll().catch(error => options.message(error.message)));
    this.player = new OfficialPlayer(this.video, value => { this.note.textContent = value; }, { viewer: true, muted: true });
    find('.close').addEventListener('click', options.close);
    find('.fullscreen').addEventListener('click', async () => {
      try { await this.video.requestFullscreen(); } catch { options.message('전체 화면을 열지 못했습니다. 영상 플레이어의 전체 화면 버튼을 이용해 주세요.'); }
    });
    this.soundButton.addEventListener('click', () => { if (this.muted) options.sound(); this.setMuted(!this.muted); });
    this.search.addEventListener('input', () => { this.searchEpoch = (this.searchEpoch ?? 0) + 1; this.searchResults = null; this.render(); });
    this.search.addEventListener('keydown', event => { if (event.key === 'Enter') this.searchAll().catch(error => options.message(error.message)); });
    this.follow.addEventListener('change', () => this.render());
    this.historyButton.addEventListener('click', () => this.loadHistory());
    this.transcript.addEventListener('scroll', () => {
      const top = this.transcript.scrollTop;
      const upward = top < (this.lastScrollTop ?? 0) - 1;
      this.lastScrollTop = top;
      if (upward) this.follow.checked = false;
      if (upward && top <= 64) this.loadHistory();
    });
    find('.latest').addEventListener('click', () => {
      this.searchEpoch = (this.searchEpoch ?? 0) + 1; this.searchResults = null; this.search.value = '';
      this.follow.checked = true; this.render();
    });
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
      this.sourceEpoch++; this.searchEpoch = (this.searchEpoch ?? 0) + 1; this.request?.abort(); this.request = null; this.searchRequest?.abort(); this.searchRequest = null;
      this.history = new TranscriptHistory(); this.nodeCache.clear(); this.searchResults = null; this.historyError = '';
      for (const frame of this.typing.values()) cancelAnimationFrame(frame); this.typing.clear();
      this.reconcileRequest?.abort(); this.reconcileRequest = null; this.reconcileAfter = 0;
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
    const items = this.searchResults ?? this.history.items.filter(item => !query || item.text?.toLocaleLowerCase().includes(query));
    const top = this.transcript.scrollTop;
    const edge = this.transcript.getBoundingClientRect().top;
    const anchor = [...this.transcript.children].find(node => node.getBoundingClientRect().bottom > edge);
    const offset = anchor?.getBoundingClientRect().top - edge;
    const nodes = items.filter(item => (item.ai_corrected === true || item.display_state === 'draft') && item.text?.trim()).map(item => {
      const cached = this.nodeCache.get(item.segment_id);
      if (cached?.item.version === item.version && cached.item.text === item.text && cached.item.display_state === item.display_state) return cached.node;
      this.cancelTyping(item.segment_id);
      const node = transcriptNodes([item], { publicOnly: true, livePreview: true }).firstElementChild;
      if (!cached && item.display_state === 'draft' && this.follow.checked && Date.now() - item.audio_received_ms < 120000) this.typeDraft(node, item);
      this.nodeCache.set(item.segment_id, { item, node }); return node;
    });
    if (nodes.length) this.transcript.replaceChildren(...nodes);
    else this.transcript.replaceChildren(transcriptNodes([], { publicOnly: true,
      empty: query ? '검색한 문장이 없습니다.' : '방송 음성을 기다립니다.' }));
    for (const item of items) if (['removed', 'reconciling'].includes(item.display_state)) { this.cancelTyping(item.segment_id); this.nodeCache.delete(item.segment_id); }
    const restored = anchor?.id ? this.transcript.querySelector('#' + CSS.escape(anchor.id)) : null;
    this.transcript.scrollTop = this.follow.checked ? this.transcript.scrollHeight
      : restored ? this.transcript.scrollTop + restored.getBoundingClientRect().top - edge - offset : top;
    this.lastScrollTop = this.transcript.scrollTop;
    this.renderHistoryStatus();
    this.element.querySelector('.gap-note').hidden = !this.options.state.gaps.has(this.stream.stream_id);
    this.reconcileDrafts();
  }
  async reconcileDrafts() {
    if (this.disposed || this.reconcileRequest || Date.now() < (this.reconcileAfter ?? 0)) return;
    const missing = this.history.items.filter(item => ['draft', 'reconciling'].includes(item.display_state) && Number.isSafeInteger(item.sequence)
      && !this.options.state.segments.has(item.segment_id));
    if (!missing.length) return;
    const epoch = this.sourceEpoch; const controller = new AbortController(); this.reconcileRequest = controller;
    this.reconcileAfter = Date.now() + 30000;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const min = Math.min(...missing.map(item => item.sequence)); let before = Math.max(...missing.map(item => item.sequence)) + 1;
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = await (await this.options.api(this.historyUrl() + '&before=' + before, { signal: controller.signal })).json();
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
  renderHistoryStatus() {
    const cursor = this.searchResults ? this.searchBefore : this.history.cursor;
    this.historyButton.disabled = Boolean(this.request || this.searchRequest) || cursor === 0;
    this.historyStatus.textContent = this.historyError || (this.request || this.searchRequest ? '이전 기록을 불러오고 있습니다.'
      : cursor === 0 ? '처음 기록까지 모두 불러왔습니다.' : '위로 스크롤하면 이전 기록을 불러옵니다.');
  }
  async loadHistory() {
    if (this.disposed || this.request || this.searchRequest || (this.searchResults ? this.searchBefore : this.history.cursor) === 0) return;
    if (this.searchResults) { try { await this.searchAll(this.searchBefore); } catch (error) { this.options.message(error.message); } return; }
    const epoch = this.sourceEpoch; const requested = this.history.cursor;
    const controller = new AbortController(); this.request = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    let emptyPage = false;
    this.historyError = ''; this.follow.checked = false; this.renderHistoryStatus();
    try {
      const page = await (await this.options.api(this.historyUrl() + '&before=' + requested, { signal: controller.signal })).json();
      if (this.disposed || epoch !== this.sourceEpoch) return;
      this.checkBroadcast(page); this.history.addPage(page, requested); emptyPage = !page.items.length && this.history.cursor > 0; this.render();
    } catch (error) {
      if (!this.disposed && epoch === this.sourceEpoch) {
        this.historyError = '이전 기록을 불러오지 못했습니다. 버튼을 눌러 다시 시도해 주세요.';
        this.options.message(this.historyError);
      }
    } finally {
      clearTimeout(timer);
      if (this.request === controller) {
        this.request = null; this.render();
        if (emptyPage) queueMicrotask(() => { if (!this.disposed && epoch === this.sourceEpoch) this.loadHistory(); });
      }
    }
  }
  historyUrl() {
    return '/api/segments?stream=' + encodeURIComponent(this.stream.stream_id) + '&limit=200'
      + (this.stream.broadcast_id ? '&broadcast=' + encodeURIComponent(this.stream.broadcast_id) : '');
  }
  checkBroadcast(page) {
    if (page.broadcast_id && this.stream.broadcast_id && page.broadcast_id !== this.stream.broadcast_id)
      throw new Error('방송이 변경되었습니다. 새 방송 기록을 다시 불러와 주세요.');
  }
  renderHealth() {
    const note = this.element.querySelector('.delivery-health');
    const health = this.options.state.health.get(this.stream.stream_id);
    note.textContent = viewerHealthMessage(health);
    note.hidden = !note.textContent;
    const pending = this.history.items.some(item => item.display_state === 'draft');
    if (pending && health?.status === 'ready') note.textContent = '1차 받아쓰기를 표시합니다. AI 후보정이 끝나면 자동으로 바뀝니다.';
    const busy = health?.stages?.transcription === 'processing' || health?.stages?.correction === 'processing'
      || (pending && !['delayed', 'correction_delayed'].includes(health?.status));
    this.element.querySelector('.transcription-progress').hidden = !busy;
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
  async searchAll(before) {
    const epoch = (this.searchEpoch ?? 0) + 1; this.searchEpoch = epoch;
    this.searchRequest?.abort(); const controller = new AbortController(); this.searchRequest = controller;
    const timer = setTimeout(() => controller.abort(), 15000); this.renderHistoryStatus();
    try {
      const value = await (await this.options.api(this.historyUrl() + '&q=' + encodeURIComponent(this.search.value.trim()) + (before ? '&before=' + before : ''), { signal: controller.signal })).json();
      if (this.disposed || this.searchEpoch !== epoch) return;
      this.checkBroadcast(value);
      this.searchResults = before ? mergeTranscriptItems(this.searchResults ?? [], value.items, true) : value.items;
      this.searchBefore = value.before ?? 0;
      this.follow.checked = false; this.render();
    } finally {
      clearTimeout(timer);
      if (this.searchRequest === controller) { this.searchRequest = null; if (!this.disposed) this.renderHistoryStatus(); }
    }
  }
  dispose() { this.disposed = true; this.searchEpoch++; this.request?.abort(); this.searchRequest?.abort(); this.reconcileRequest?.abort();
    for (const frame of this.typing.values()) cancelAnimationFrame(frame); this.typing.clear(); this.player.dispose(); this.element.remove(); }
}
