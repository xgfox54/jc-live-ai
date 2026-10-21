import { OfficialPlayer } from './player.mjs';
import { transcriptNodes } from './transcripts.mjs';
import { committeeMembers } from './committee-members.mjs';

      + '<p class="help">화자 번호는 방송·연결 구간별 임시 번호입니다. 교대·겹침 구간은 문장별 화자를 확정한 결과가 아닙니다.</p>'
export class ViewerStage {
  constructor(options) {
    this.options = options; this.stream = options.stream; this.before = options.before ?? Number.MAX_SAFE_INTEGER; this.muted = true;
    this.element = document.createElement('article'); this.element.className = 'watch-panel';
    this.element.dataset.stream = this.stream.stream_id;
    this.element.innerHTML = '<div class="panel-heading"><h2></h2><div class="row"><button class="secondary sound">소리 켜기</button>'
      + '<button class="secondary fullscreen">전체 화면</button><button class="secondary close">닫기</button></div></div>'
      + '<div class="video-frame"></div><div class="video-info"><p role="status"></p><a target="_blank" rel="noopener noreferrer">공식 영상 열기</a></div>'
      + '<div class="transcript-controls"><h3>회의록 받아쓰기</h3><label>문장 검색<input type="search" maxlength="200" placeholder="후보정문 검색"></label>'
      + '<button class="secondary search-all">전체 기록 검색</button>'
      + '<label class="check"><input type="checkbox" checked> 새 문장으로 이동</label></div>'
      + '<p class="gap-note" hidden>음성이 누락된 구간이 있습니다. 원음과 함께 확인해 주세요.</p>'
      + '<div class="transcript" tabindex="0"></div><div class="panel-footer"><button class="secondary history">이전 문장</button></div>';
    const layout = document.createElement('div'); layout.className = 'watch-layout';
    const content = document.createElement('div'); content.className = 'watch-content';
    while (this.element.children.length > 1) content.append(this.element.children[1]);
    layout.append(committeeMembers(this.stream.stream_id), content); this.element.append(layout);
    const find = selector => this.element.querySelector(selector);
    this.title = find('h2'); this.video = find('.video-frame'); this.note = find('.video-info p'); this.link = find('.video-info a');
    this.transcript = find('.transcript'); this.search = find('input[type=search]'); this.follow = find('input[type=checkbox]');
    this.soundButton = find('.sound'); this.historyButton = find('.history');
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
    this.historyButton.addEventListener('click', async () => {
      this.historyButton.disabled = true;
      try {
        if (this.searchResults) { await this.searchAll(this.before); return; }
        const page = await (await options.api('/api/segments?stream=' + this.stream.stream_id + '&before=' + this.before)).json();
        if (!page.items.length) { options.message('이전 문장이 더 없습니다.'); return; }
        this.before = page.before ?? this.before;
        for (const item of [...options.state.segments.values()]) if (item.stream_id === this.stream.stream_id) options.state.segments.delete(item.segment_id);
        for (const item of page.items) options.state.put(item);
        this.follow.checked = false; this.render();
      } catch (error) { options.message(error.message); }
      finally { this.historyButton.disabled = false; }
    });
    this.update(this.stream, true);
  }
  setMuted(value) {
    this.muted = value; this.player.setMuted(value); this.soundButton.textContent = value ? '소리 켜기' : '소리 끄기';
    this.soundButton.setAttribute('aria-pressed', String(!value));
  }
  update(stream, initial = false) {
    const changed = initial || this.stream.video_id !== stream.video_id || this.stream.page_url !== stream.page_url;
    this.stream = stream; this.title.textContent = stream.name; this.link.href = stream.page_url || '#'; this.link.hidden = !stream.page_url;
    this.transcript.setAttribute('aria-label', stream.name + ' 회의록 받아쓰기'); this.element.setAttribute('aria-label', stream.name);
    this.soundButton.disabled = !stream.video_id;
    if (changed) { this.note.textContent = '영상을 불러옵니다.'; this.player.select(stream).catch(() => { this.note.textContent = '영상을 불러오지 못했습니다. 공식 영상 링크를 이용해 주세요.'; }); }
  }
  render() {
    const query = this.search.value.trim().toLocaleLowerCase();
    const items = this.searchResults ?? [...this.options.state.segments.values()].filter(item => item.stream_id === this.stream.stream_id
      && (!query || item.text?.toLocaleLowerCase().includes(query)));
    const top = this.transcript.scrollTop;
    this.transcript.replaceChildren(transcriptNodes(items, { publicOnly: true,
      empty: query ? '검색한 문장이 없습니다.' : 'AI 후보정이 완료된 문장을 기다립니다.' }));
    this.transcript.scrollTop = this.follow.checked ? this.transcript.scrollHeight : top;
    this.element.querySelector('.gap-note').hidden = !this.options.state.gaps.has(this.stream.stream_id);
  }
  async searchAll(before) {
    const epoch = (this.searchEpoch ?? 0) + 1; this.searchEpoch = epoch;
    const value = await (await this.options.api('/api/segments?stream=' + this.stream.stream_id + '&q=' + encodeURIComponent(this.search.value.trim()) + (before ? '&before=' + before : ''))).json();
    if (this.disposed || this.searchEpoch !== epoch) return;
    this.searchResults = value.items; this.before = value.before ?? 0; this.historyButton.disabled = !this.before;
    this.follow.checked = false; this.render();
  }
  dispose() { this.disposed = true; this.searchEpoch++; this.player.dispose(); this.element.remove(); }
}
