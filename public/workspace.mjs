import { transcriptNodes, formatElapsedTime } from './transcripts.mjs';

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
    for (const [selector, route] of [['#minutes-generate', '/generate'], ['#minutes-pause', '/pause'], ['#audio-pause', '/pause-audio'], ['#final-speakers', '/final-speakers'], ['#pause-final-speakers', '/pause-final-speakers']])
      $(selector).addEventListener('click', () => this.action(route, { broadcast_id: this.id() }));
    $('#live-summary').addEventListener('change', () => this.action('/live', { broadcast_id: this.id(), enabled: $('#live-summary').checked }));
    $('#minutes-edit').addEventListener('click', () => this.loadEditor().catch(error => message(error.message)));
    $('#minutes-save').addEventListener('click', () => this.action('/minutes', { broadcast_id: this.id(), version: this.editVersion ?? 0, markdown: $('#minutes-editor').value }));
    $('#participant-form').addEventListener('submit', event => {
      event.preventDefault(); const names = {};
      for (const input of $('#participant-rows').querySelectorAll('input[data-key]')) names[input.dataset.key] = input.value;
      this.action('/participants', { broadcast_id: this.id(), names }).then(() => this.participants().catch(error => message(error.message)));
    });
    $('#speaker-review-refresh').addEventListener('click', () => this.loadSpeakers().catch(error => message(error.message)));
    for (const selector of ['#speaker-review-query', '#speaker-review-unknown']) $(selector).addEventListener('input', () => this.filterSpeakers());
    $('#speaker-review-form').addEventListener('submit', event => { event.preventDefault(); this.previewSpeakers().catch(error => message(error.message)); });
    $('#speaker-review-confirm').addEventListener('click', () => this.confirmSpeakers().catch(error => message(error.message)));
    $('#speaker-review-undo').addEventListener('click', async () => {
      await this.action('/speaker-undo', { broadcast_id: this.id(), version: this.speakerView?.version }); await this.loadSpeakers();
    });
    $('#speaker-review-audio').addEventListener('click', () => {
      const item = this.speakerView?.items.find(item => item.segment_id === $('#speaker-review-segment').value);
      if (item) this.play(item).catch(error => message(error.message));
    });
    for (const selector of ['#speaker-review-segment', '#speaker-review-name', '#speaker-review-role', '#speaker-review-mode'])
      $(selector).addEventListener('input', () => this.clearSpeakerPreview());
    $('#speaker-roster-form').addEventListener('submit', event => { event.preventDefault(); this.saveRoster().catch(error => message(error.message)); });
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
    await this.search(); await this.status(); if (this.id()) { await this.loadEditor(); await this.loadSpeakers(); }
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
      identity: item => this.openSpeaker(item).catch(error => this.message(error.message)),
      audio: item => this.play(item).catch(error => this.message(error.message)), speaker: (item, speaker) =>
        this.action('/speaker', { segment_id: item.segment_id, version: item.version, speaker }).then(() => this.search()).catch(error => this.message(error.message)) }));
  }
  clearSpeakerPreview() { this.speakerPreview = null; $('#speaker-review-preview-list').replaceChildren(); $('#speaker-review-confirm').disabled = true; }
  async loadSpeakers() {
    const id = this.id(); this.clearSpeakerPreview(); if (!id) return;
    const [view, roster] = await Promise.all([this.json('/speaker-review?broadcast=' + id), this.json('/speaker-roster?broadcast=' + id)]);
    if (id !== this.id()) return;
    this.speakerView = view; this.rosterView = roster; this.filterSpeakers();
    $('#speaker-review-status').textContent = '전체 ' + view.total + '구간 · 미확인 ' + view.unresolved + '구간 · 관리자 변경 ' + view.version + '회'
      + (view.conflicts ? ' · 음성 분석과 문장 근거 불일치 ' + view.conflicts + '구간' : '')
      + (view.acoustic ? ' · 원음 분석 ' + (view.acoustic.phase === 'complete' ? '완료' : '대기') + ' · 원음 미확보 ' + view.acoustic.missing + '세션' : ' · 종료 후 원음 분석 대기');
    $('#speaker-review-undo').disabled = !view.version;
    $('#speaker-review-people').replaceChildren(...view.candidates.map(person => new Option(person.name + ' ' + person.title, person.name)));
    $('#speaker-roster').value = roster.people.map(p => [p.name, ({ member: '의원', official: '공무원', unknown: '기타' })[p.role], p.title, p.as_of, p.source].join(' | ')).join('\n');
    $('#speaker-roster-status').textContent = '직접 확인한 참석자 ' + roster.people.length + '명';
    $('#speaker-roster-candidates').replaceChildren(...view.candidates.map(person => element('li',
      person.name + ' · ' + person.title + ' · ' + (person.attendance ? '해당 회의에서 확인' : '참고 후보') + (person.as_of ? ' · ' + person.as_of : ''))));
  }
  filterSpeakers() {
    this.clearSpeakerPreview(); const select = $('#speaker-review-segment'); const selected = select.value;
    const query = $('#speaker-review-query').value.trim();
    const items = (this.speakerView?.items ?? []).filter(item => (!$('#speaker-review-unknown').checked || !item.identity)
      && (!query || item.text.includes(query) || item.identity?.name.includes(query)));
    select.replaceChildren(...items.slice(0, 300).map(item => new Option(formatElapsedTime(item.start_ms) + ' · '
      + (item.identity?.name ?? '발언자 미확인') + (item.conflict_candidates?.length ? ' (원음 검토 필요)' : '') + ' · ' + item.text.slice(0, 80), item.segment_id)));
    if (items.some(item => item.segment_id === selected)) select.value = selected;
    if (items.length > 300) this.message('앞의 300구간을 표시합니다. 검색어로 범위를 좁혀 주세요.');
  }
  async openSpeaker(item) {
    await this.loadSpeakers(); $('#speaker-review-unknown').checked = false; $('#speaker-review-query').value = item.corrected_text?.slice(0, 50) ?? '';
    this.filterSpeakers(); $('#speaker-review-segment').value = item.segment_id;
    $('#speaker-review-segment').focus(); $('#speaker-review-form').scrollIntoView({ block: 'center' });
  }
  speakerInput() {
    const source = this.speakerView?.items.find(item => item.segment_id === $('#speaker-review-segment').value);
    if (!source) throw new Error('확인할 발언 구간을 선택해 주세요.');
    return { broadcast_id: this.id(), version: this.speakerView.version, analysis_version: this.speakerView.analysis_version,
      segment_id: source.segment_id, segment_version: source.version, name: $('#speaker-review-name').value.trim() || null,
      role: $('#speaker-review-role').value, mode: $('#speaker-review-mode').value };
  }
  async previewSpeakers() {
    this.clearSpeakerPreview(); const input = this.speakerInput();
    const preview = await (await this.api('/api/admin/workspace/speaker-preview', { method: 'POST', body: JSON.stringify(input) })).json();
    if (input.broadcast_id !== this.id()) return;
    if (JSON.stringify(input) !== JSON.stringify(this.speakerInput())) return;
    this.speakerPreview = { input, preview };
    for (const item of preview.items) {
      const label = element('label', '', 'check'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true;
      check.dataset.segment = item.segment_id; if (item.segment_id === input.segment_id) check.disabled = true;
      label.append(check, document.createTextNode(formatElapsedTime(item.start_ms) + ' · ' + item.text.slice(0, 160)));
      $('#speaker-review-preview-list').append(label);
    }
    $('#speaker-review-confirm').disabled = false;
    if (preview.limited) this.message('한 번에 최대 200구간까지 확인합니다. 저장 후 나머지 구간을 다시 확인해 주세요.');
  }
  async confirmSpeakers() {
    if (!this.speakerPreview) return; const { input, preview: shown } = this.speakerPreview;
    const selected = [...$('#speaker-review-preview-list').querySelectorAll('input:checked')].map(node => node.dataset.segment);
    const value = { ...input, expected_segments: shown.items.filter(item => selected.includes(item.segment_id)).map(item => ({ segment_id: item.segment_id, version: item.version })),
      ...(input.mode === 'similar' ? { mode: 'selected', segment_ids: selected } : {}) };
    const preview = await (await this.api('/api/admin/workspace/speaker-preview', { method: 'POST', body: JSON.stringify(value) })).json();
    if (input.broadcast_id !== this.id()) return;
    await this.api('/api/admin/workspace/speaker-confirm', { method: 'POST', body: JSON.stringify({ ...value, confirmation: preview.confirmation }) });
    await this.loadSpeakers(); await this.status(); this.message('확인한 발언자 이름을 저장했습니다.');
  }
  async saveRoster() {
    const roles = { 의원: 'member', 공무원: 'official', 기타: 'unknown' };
    const people = $('#speaker-roster').value.split('\n').filter(line => line.trim()).map(line => {
      const parts = line.split('|').map(part => part.trim());
      if (parts.length !== 5 || !roles[parts[1]]) throw new Error('각 줄에 이름 | 구분 | 직책 | 날짜 | 확인 근거를 입력해 주세요.');
      return { name: parts[0], role: roles[parts[1]], title: parts[2], as_of: parts[3], source: parts[4] };
    });
    await this.api('/api/admin/workspace/speaker-roster', { method: 'POST', body: JSON.stringify({ broadcast_id: this.id(), version: this.rosterView.version, people }) });
    await this.loadSpeakers(); this.message('회의 당시 참석자 명단을 저장했습니다. 전체 발언자 재검토에 반영합니다.');
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
    const final = value.final_speakers;
    const readiness = { transcribing: '전사 완료 대기', end_unverified: '수집 종료 확인 중 (마지막 입력 후 10분 대기)', incomplete: '누락·오류 기록 확인 필요',
      empty: '받아쓰기 없음', correcting: '문장 후보정 완료 대기', ready: '전체 발언자 검토 가능' };
    const finalPhases = { running: '발언자 검토 중', complete: '발언자 검토 완료', partial: '검토 완료·일부 발언자 미확인', failed: '검토 실패', interrupted: '검토 중단', paused: '검토 중지' };
    $('#final-speakers-status').textContent = (readiness[final?.readiness] ?? '기록을 선택해 주세요.')
      + (final?.job?.stage === 'acoustics' && final.job.phase === 'running' ? ' · 종료 후 원음 재분석 중' : '')
      + (final?.job?.acoustics?.phase === 'unconfigured' ? ' · 원음 분석 모델 미구성' : '')
      + (final?.job?.acoustics?.phase === 'unavailable' ? ' · 분석할 저장 원음 없음' : '')
      + (final?.job?.acoustics?.missing ? ' · 원음 미확보 ' + final.job.acoustics.missing + '세션' : '')
      + (final?.job ? ' · ' + finalPhases[final.job.phase] + ' · ' + final.job.completed + '/' + final.job.total + '묶음' : '')
      + (final?.result ? ' · 이름 확인 ' + final.result.assigned + '개 구간 · 미확인 ' + final.result.unresolved + '개 구간' : '');
    $('#final-speakers').disabled = final?.readiness !== 'ready' || final?.job?.phase === 'running';
    $('#pause-final-speakers').disabled = final?.job?.phase !== 'running';
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
