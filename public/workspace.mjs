import { transcriptNodes } from './transcripts.mjs';

const $ = selector => document.querySelector(selector);
const element = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value ?? ''; if (className) node.className = className; return node; };
const phases = { running: '처리 중', completed: '완료', paused: '중단 위치 저장', interrupted: '서버 종료로 중단', failed: '실패' };
export class Workspace {
  constructor({ api, message }) {
    Object.assign(this, { api, message }); this.epoch = 0; this.before = null; this.audio = $('#workspace-audio');
    $('#record-select').addEventListener('change', () => this.select().catch(error => message(error.message)));
    $('#record-refresh').addEventListener('click', () => this.refresh().catch(error => message(error.message)));
    $('#record-search').addEventListener('submit', event => { event.preventDefault(); this.search().catch(error => message(error.message)); });
    $('#record-older').addEventListener('click', () => this.search(this.before).catch(error => message(error.message)));
    $('#record-mode').addEventListener('change', () => this.renderRows(this.items ?? []));
    $('#record-repeats').addEventListener('change', () => this.search().catch(error => message(error.message)));
    for (const [selector, route] of [['#minutes-generate', '/generate'], ['#minutes-pause', '/pause'], ['#audio-pause', '/pause-audio']])
      $(selector).addEventListener('click', () => this.action(route, { broadcast_id: this.id() }));
    $('#live-summary').addEventListener('change', () => this.action('/live', { broadcast_id: this.id(), enabled: $('#live-summary').checked }));
    $('#minutes-edit').addEventListener('click', () => this.loadEditor().catch(error => message(error.message)));
    $('#minutes-save').addEventListener('click', () => this.action('/minutes', { broadcast_id: this.id(), version: this.editVersion ?? 0, markdown: $('#minutes-editor').value }));
    $('#participant-form').addEventListener('submit', event => {
      event.preventDefault(); const names = {};
      for (const input of $('#participant-rows').querySelectorAll('input[data-key]')) names[input.dataset.key] = input.value;
      this.action('/participants', { broadcast_id: this.id(), names }).then(() => this.participants().catch(error => message(error.message)));
    });
    for (const kind of ['raw', 'reviewed', 'json']) $('#export-' + kind).addEventListener('click', () => this.download(kind).catch(error => message(error.message)));
    $('#diagnostics').addEventListener('click', async () => {
      try { const value = await this.json('/diagnostics'); $('#diagnostics-text').textContent = JSON.stringify(value, null, 2);
        await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); message('회의 내용과 비밀값을 제외한 진단 정보를 복사했습니다.'); }
      catch { message('아래 진단 정보를 선택하여 복사해 주세요.'); }
    });
    $('#profile-save').addEventListener('click', () => this.action('/profile-save', { name: $('#profile-name').value }));
    $('#profile-use').addEventListener('click', () => this.action('/profile-use', { id: $('#profile-select').value }));
    $('#profile-delete').addEventListener('click', () => this.action('/profile-delete', { id: $('#profile-select').value }));
    $('#model-pull').addEventListener('click', () => this.action('/pull-model', { model: $('#managed-model').value }));
    $('#model-cancel').addEventListener('click', () => this.action('/cancel-model', {}));
    $('#model-delete').addEventListener('click', () => { if ($('#model-delete-confirm').checked) this.action('/delete-model', { model: $('#managed-model').value }); else message('모델 삭제 확인 항목을 선택해 주세요.'); });
  }
  id() { return $('#record-select').value; }
  async json(route) { return (await this.api('/api/admin/workspace' + route)).json(); }
  async action(route, data) {
    try {
      await this.api('/api/admin/workspace' + route, { method: 'POST', body: JSON.stringify(data) });
      await this.status(); await this.profiles();
      if (route === '/minutes' && data.broadcast_id === this.id()) this.editVersion++;
      if (route === '/profile-use') document.dispatchEvent(new Event('jc-ai-settings-changed'));
      this.message(route === '/pause' || route === '/pause-audio' ? '현재 묶음 처리 후 중단합니다.' : '작업 상태를 저장했습니다.');
    } catch (error) { this.message(error.message); }
  }
  async refresh() {
    const epoch = this.epoch; const selected = this.id(); const value = await this.json(''); if (epoch !== this.epoch) return;
    $('#record-select').replaceChildren(new Option('기록을 선택해 주세요', ''));
    for (const item of value.items) $('#record-select').append(new Option(item.title, item.id));
    $('#record-select').value = value.items.some(item => item.id === selected) ? selected : value.items[0]?.id ?? '';
    await this.profiles();
    const download = await this.json('/model-status');
    $('#model-job').textContent = (phases[download.phase] ?? ({ idle: '다운로드 대기', downloading: '다운로드 중', cancelled: '취소' }[download.phase] ?? download.phase))
      + (download.model ? ' · ' + download.model : '') + (download.total ? ' · ' + (download.completed / 1000000).toFixed(1) + '/' + (download.total / 1000000).toFixed(1) + 'MB' : '') + (download.error ? ' · ' + download.error : '');
    if (selected !== this.id() || !this.items) await this.select(); else await this.status();
  }
  async select() {
    this.stopAudio(); this.before = null; $('#minutes-editor').value = ''; this.editVersion = null;
    await this.search(); await this.status(); if (this.id()) await this.loadEditor();
  }
  async search(before) {
    if (!this.id()) { this.renderRows([]); return; }
    const id = this.id(); const epoch = this.epoch;
    const value = await this.json('/search?broadcast=' + id + '&q=' + encodeURIComponent($('#record-query').value)
      + (before ? '&before=' + before : '') + ($('#record-repeats').checked ? '&repeats=1' : ''));
    if (id !== this.id() || epoch !== this.epoch) return;
    this.before = value.before; $('#record-older').disabled = !value.before; this.renderRows(value.items);
  }
  renderRows(items) {
    this.items = items; $('#record-results').replaceChildren(transcriptNodes(items, { mode: $('#record-mode').value,
      audio: item => this.play(item).catch(error => this.message(error.message)), speaker: (item, speaker) =>
        this.action('/speaker', { segment_id: item.segment_id, version: item.version, speaker }).then(() => this.search()).catch(error => this.message(error.message)) }));
  }
  async play(item) {
    this.stopAudio(); const epoch = this.epoch; const id = this.id();
    const response = await this.api('/api/admin/workspace/audio?segment=' + encodeURIComponent(item.segment_id));
    const blob = await response.blob(); if (epoch !== this.epoch || id !== this.id()) return;
    this.audioUrl = URL.createObjectURL(blob); this.audio.src = this.audioUrl;
    await this.audio.play();
  }
  stopAudio() { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); if (this.audioUrl) URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; }
  async loadEditor() {
    if (!this.id()) return; const id = this.id(); const epoch = this.epoch;
    const value = await this.json('/state?broadcast=' + id);
    if (id !== this.id() || epoch !== this.epoch) return;
    this.editVersion = value.manual?.version ?? 0; $('#minutes-editor').value = value.manual?.markdown ?? value.structured?.markdown ?? value.current_markdown ?? '';
  }
  async status() {
    if (!this.id()) return; const id = this.id(); const epoch = this.epoch;
    const [value, audio] = await Promise.all([this.json('/state?broadcast=' + id), this.json('/recordings?broadcast=' + id), this.participants()]);
    if (id !== this.id() || epoch !== this.epoch) return;
    this.renderStatus(id, value, audio);
  }
  async participants() {
    const id = this.id(); const rows = $('#participant-rows'); if (!id) { rows.replaceChildren(); return; }
    const value = await this.json('/participants?broadcast=' + id); if (id !== this.id()) return;
    rows.replaceChildren(); $('#participant-members').replaceChildren(...value.members.map(name => new Option(name)));
    $('#participant-status').textContent = value.speakers.length ? (value.committee ? value.committee + ' 의원 명단을 입력 후보로 제공합니다. ' : '')
      + '참여자 ' + value.speakers.length + '명이 분석되었습니다.' : '분석된 참여자가 아직 없습니다.';
    for (const speaker of value.speakers) {
      const label = element('label', '참여자 ' + speaker.speaker_id + ' · ' + speaker.segments + '구간 · 첫 발언 "' + speaker.sample.slice(0, 40) + '"');
      const input = document.createElement('input'); input.maxLength = 60; input.setAttribute('list', 'participant-members'); input.dataset.key = speaker.key;
      input.value = value.names[speaker.key] ?? ''; input.placeholder = '이름 (비우면 번호만 표시)'; label.append(input); rows.append(label);
    }
  }
  renderStatus(id, value, audio) {
    const job = value.job;
    $('#minutes-job').textContent = job ? (phases[job.phase] ?? job.phase) + ' · ' + job.completed + '/' + job.total + '묶음'
      + (job.remaining_ms ? ' · 남은 시간 추정 ' + Math.ceil(job.remaining_ms / 1000) + '초' : '') + (job.error ? ' · ' + job.error : '') : '생성 대기';
    $('#minutes-generate').disabled = job?.phase === 'running'; $('#minutes-pause').disabled = job?.phase !== 'running';
    $('#live-summary').checked = value.live_summary.enabled;
    const notes = $('#structured-notes'); notes.replaceChildren();
    if (value.stale) notes.append(element('p', '회의록 받아쓰기가 바뀌었습니다. AI 회의록을 다시 생성해 주세요.', 'help'));
    for (const note of value.structured?.notes ?? []) for (const [key, label] of [['summary','논의 요약'],['decisions','결정사항'],['proposals','제안'],['actions','후속 조치'],['numbers','수치'],['open_questions','미결 사항']]) {
      if (!note[key].length) continue; notes.append(element('h3', label));
      for (const fact of note[key]) {
        notes.append(element('p', fact.text), element('p', '근거: ' + fact.quote, 'help'));
        const source = value.structured.sources.find(source => source.id === fact.source_id);
        const button = element('button', '근거 회의록 받아쓰기 보기', 'secondary');
        button.addEventListener('click', async () => {
          try { const item = await this.json('/segment?broadcast=' + id + '&segment=' + source.segment_id); if (this.id() !== id) return; this.renderRows([item]); $('#record-results').scrollIntoView({ block: 'nearest' }); }
          catch (error) { this.message(error.message); }
        }); notes.append(button);
      }
    }
    const timeline = $('#summary-timeline'); timeline.replaceChildren();
    for (const entry of [...value.timeline].reverse()) timeline.append(element('p', new Date(entry.updated_ms).toLocaleTimeString('ko-KR') + ' · ' + entry.segment_count + '구간 · ' + entry.summary.map(item => item.text).join(' ')));
    const recordings = $('#record-audio-jobs'); recordings.replaceChildren();
    for (const recording of audio.items) {
      const row = element('div', '', 'discovery-record');
      row.append(element('p', recording.session_id + ' · ' + (recording.available ? recording.seconds.toFixed(1) + '초 저장' : '저장 원음 없음')));
      if (recording.available) for (const [recover, label] of [[false, '전체 원음 재전사'], [true, '미처리 뒷부분 복구']]) {
        const button = element('button', label, 'secondary'); button.addEventListener('click', () => this.action('/retranscribe', { broadcast_id: id, session_id: recording.session_id, recover })); row.append(button);
      }
      if (recording.available) { const button = element('button', '저장 원음 참여자 분석', 'secondary'); button.addEventListener('click', () => this.action('/diarize', { broadcast_id: id, session_id: recording.session_id })); row.append(button); }
      recordings.append(row);
    }
    for (const job of audio.jobs) {
      const row = element('div', '', 'discovery-record'); row.append(element('p', (job.kind === 'diarization' ? '참여자 분석 · ' : '재전사 · ') + (phases[job.phase] ?? job.phase) + ' · ' + (job.offset / 32000).toFixed(1) + '/' + (job.total_bytes / 32000).toFixed(1) + '초' + (job.error ? ' · ' + job.error : '')));
      if (job.kind !== 'diarization' && job.phase !== 'completed' && job.phase !== 'running') {
        const button = element('button', '저장 위치에서 재개', 'secondary'); button.addEventListener('click', () => this.action('/retranscribe', { broadcast_id: id, job_id: job.id })); row.append(button);
      }
      if (job.result_id) {
        const open = element('button', '재전사 기록 열기', 'secondary'); open.addEventListener('click', async () => { await this.refresh(); $('#record-select').value = job.result_id; await this.select(); }); row.append(open);
      }
      recordings.append(row);
    }
  }
  async download(kind) {
    if (!this.id()) return; const epoch = this.epoch; const response = await this.api('/api/admin/workspace/export?broadcast=' + this.id() + '&kind=' + kind);
    const blob = await response.blob(); if (epoch !== this.epoch) return;
    const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = 'JC-LIVE-' + kind + (kind === 'json' ? '.json' : '.txt'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async profiles() {
    const epoch = this.epoch; const value = await this.json('/profiles'); if (epoch !== this.epoch) return;
    const selected = $('#profile-select').value; $('#profile-select').replaceChildren(new Option('저장된 연결 선택', ''));
    for (const profile of value.items) $('#profile-select').append(new Option(profile.name + ' · ' + profile.model, profile.id));
    $('#profile-select').value = selected;
  }
  clear() { this.epoch++; this.stopAudio(); this.items = null; $('#record-select').replaceChildren(); $('#record-query').value = ''; $('#record-results').replaceChildren(); $('#structured-notes').replaceChildren(); $('#minutes-editor').value = ''; $('#summary-timeline').replaceChildren(); $('#record-audio-jobs').replaceChildren(); $('#diagnostics-text').textContent = ''; $('#profile-select').replaceChildren(); $('#profile-name').value = ''; }
}
