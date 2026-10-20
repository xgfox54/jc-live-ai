export class AutomationTools {
  constructor({ api, message }) {
    this.api = api; this.message = message; this.enabled = true; this.version = 0;
    document.querySelector('#discovery-toggle').addEventListener('click', () => this.run(true));
    document.querySelector('#discovery-scan').addEventListener('click', () => this.run(false));
  }
  async run(toggle) {
    const buttons = [...document.querySelectorAll('#automation button')]; buttons.forEach(button => { button.disabled = true; });
    try {
      const response = await this.api(toggle ? '/api/admin/discovery' : '/api/admin/discovery/scan', {
        method: 'POST', body: toggle ? JSON.stringify({ enabled: !this.enabled }) : undefined });
      this.render(await response.json());
      this.message(toggle ? (this.enabled ? '신규 주소 탐색을 켰습니다.' : '신규 주소 탐색을 껐습니다. 등록된 방송의 감지·수집은 계속됩니다.') : '공식 방송 목록을 확인했습니다. 조회 결과를 확인해 주세요.');
    } catch (error) { this.message(error.message); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  async refresh() {
    const version = this.version; const result = await (await this.api('/api/admin/discovery')).json();
    if (version === this.version) this.render(result);
  }
  clear() { this.version++; document.querySelector('#discovery-records').replaceChildren(); document.querySelector('#discovery-status').textContent = ''; }
  render(value) {
    this.enabled = value.enabled;
    document.querySelector('#discovery-toggle').textContent = value.enabled ? '신규 주소 탐색 끄기' : '신규 주소 탐색 켜기';
    const names = { waiting: '첫 조회 대기', checking: '공식 목록 확인 중', watching: '신규 방송 확인 대기', retry: '조회 재시도 대기' };
    document.querySelector('#discovery-status').textContent = (value.enabled ? names[value.phase] ?? '조회 대기' : '신규 주소 탐색 꺼짐')
      + (value.checked_ms ? ' · 최근 확인 ' + new Date(value.checked_ms).toLocaleString('ko-KR') : '')
      + (value.error ? ' · ' + value.error : '') + (value.minutes_error ? ' · 회의록 파일 저장 오류: ' + value.minutes_error : '');
    const sources = document.querySelector('#discovery-sources'); sources.replaceChildren();
    for (const [key, label, url] of [['youtube', '공식 YouTube 생방송 채널', value.channel_url], ['council', '의회 오늘의 생방송', value.council_url]]) {
      const row = document.createElement('p'); const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label;
      const status = value.sources[key]; row.append(link, document.createTextNode(' · ' + (!status ? '조회 전' : status.ok ? '조회 성공 · ' + status.count + '건' : status.error))); sources.append(row);
    }
    const list = document.querySelector('#discovery-records'); list.replaceChildren();
    if (!value.records.length) { const p = document.createElement('p'); p.textContent = '새로 발견한 생방송이 없습니다. 종료 방송과 다시보기는 새 방송으로 등록하지 않습니다.'; list.append(p); }
    for (const item of value.records) {
      const row = document.createElement('div'); row.className = 'discovery-record';
      const title = document.createElement('strong'); title.textContent = item.title;
      const note = document.createElement('p'); note.className = 'help';
      note.textContent = item.suspended ? '관리자가 자동 감지를 중지했습니다.' : item.completed ? '수집 완료 · 회의록 검토 가능'
        : item.queued ? '등록 대기 · 사용 가능한 방송 슬롯이 필요합니다.' : item.phase === 'live' ? '생방송 감지 · ' + (item.stream_id ?? '등록 대기')
        : item.phase === 'waiting' ? '방송 시작 대기 · ' + (item.stream_id ?? '등록 대기') : '생방송 종료 또는 상태 확인 대기';
      row.append(title, note); list.append(row);
    }
  }
}
