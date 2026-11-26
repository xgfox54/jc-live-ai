const $ = selector => document.querySelector(selector);
const element = (tag, text, className) => {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
};
const clock = ms => { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const providerNames = { anthropic: 'Claude · Anthropic 계정', 'anthropic-apikey': 'Claude · Anthropic API 키',
  'google-antigravity': 'Antigravity · Claude·Gemini', ollama: 'Ollama' };
const modelGroup = model => {
  const slash = model.indexOf('/'); if (slash < 0) return /^gpt-\d/.test(model) ? 'GPT · 기본 계정' : 'Ollama · 이 PC';
  const prefix = model.slice(0, slash);
  return providerNames[prefix] ?? (/^gpt-\d/.test(model.slice(slash + 1)) ? 'GPT · ' + prefix : prefix);
};
const fillModels = (select, models, selected) => {
  const groups = new Map();
  for (const model of models) { const name = modelGroup(model); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(model); }
  const nodes = [new Option(models.length ? '모델을 선택해 주세요' : '연결 저장 후 모델 목록 확인', '')];
  if (selected && !models.includes(selected)) nodes.push(new Option(selected + ' (저장된 모델 · 현재 목록에 없음)', selected));
  for (const [name, items] of groups) {
    const group = document.createElement('optgroup'); group.label = name + ' (' + items.length + ')';
    for (const model of items) group.append(new Option(model, model));
    nodes.push(group);
  }
  select.replaceChildren(...nodes); select.value = selected;
};
export class AITools {
  constructor({ api, message, refresh }) {
    Object.assign(this, { api, message, changed: refresh }); this.before = null; this.page = null; this.epoch = 0; this.checked = new Set();
    $('#ai-waiting').addEventListener('change', () => { this.page = null; this.candidates().catch(error => message(error.message)); });
    $('#ai-apply-checked').addEventListener('click', () => this.action('/apply-checked', { ids: [...this.checked] }, '확인 표시한 후보를 적용했습니다.')
      .then(ok => { if (ok) { this.checked.clear(); this.updateChecked(); } }));
    document.addEventListener('jc-ai-settings-changed', () => { this.loaded = false; });
    $('#ai-model-refresh').addEventListener('click', () => this.models());
    $('#ai-provider').addEventListener('change', () => { $('#ai-proxy-fields').hidden = $('#ai-provider').value !== 'proxy'; });
    $('#ai-broadcast').addEventListener('change', () => { this.before = null; this.checked.clear(); this.updateChecked(); this.select().catch(error => message(error.message)); });
    $('#ai-refresh').addEventListener('click', () => this.refresh().catch(error => message(error.message)));
    $('#ai-latest').addEventListener('click', () => { this.page = null; this.candidates().catch(error => message(error.message)); });
    $('#ai-older').addEventListener('click', () => { this.page = this.before; this.candidates().catch(error => message(error.message)); });
    $('#ai-settings').elements.automatic.addEventListener('change', event => {
      const safe = $('#ai-settings').elements.auto_apply_safe; safe.disabled = event.target.checked; if (event.target.checked) safe.checked = true;
    });
    $('#ai-settings').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target;
      this.action('/settings', { model: $('#ai-model').value, refine_model: $('#ai-refine-model').value,
        fallback_models: [$('#ai-fallback-1').value, $('#ai-fallback-2').value].filter(Boolean), automatic: form.elements.automatic.checked,
        auto_apply_safe: form.elements.auto_apply_safe.checked,
        provider: form.elements.provider.value, base: form.elements.base.value, api_key: form.elements.api_key.value,
        clear_key: form.elements.clear_key.checked }, 'AI 설정을 저장했습니다.').then(ok => {
          form.elements.api_key.value = ''; if (ok) { this.loaded = false; this.refresh().catch(error => message(error.message)); }
        });
    });
    $('#ai-field').addEventListener('submit', event => {
      event.preventDefault();
      this.action('/field', { broadcast_id: this.id(), pack_ids: [...$('#ai-packs').querySelectorAll('input:checked')].map(input => input.value),
        custom: event.target.elements.custom.value, auto_select: event.target.elements.auto_select.checked }, '단어장을 저장했습니다.').then(ok => ok && this.select()).catch(error => message(error.message));
    });
    for (const [selector, route, text] of [['#ai-start', '/start', '후보 생성을 시작했습니다.'], ['#ai-cancel', '/cancel', '후보 생성을 중단했습니다.'],
      ['#ai-apply-safe', '/apply-safe', '일괄 적용을 마쳤습니다.']])
      $(selector).addEventListener('click', () => this.action(route, { broadcast_id: this.id() }, text));
  }
  id() { return $('#ai-broadcast').value; }
  async json(path) { return (await this.api('/api/admin/ai' + path)).json(); }
  async action(path, body, text) {
    try {
      const response = await this.api('/api/admin/ai' + path, { method: 'POST', body: JSON.stringify(body) });
      const result = await response.json();
      await this.refresh(); await this.changed();
      this.message(text + (typeof result.applied === 'number' ? ' 적용 ' + result.applied + '개, 제외 ' + result.skipped + '개입니다.' : ''));
      return true;
    } catch (error) { this.message(error.message); return false; }
  }
  async models() {
    $('#ai-model-refresh').disabled = true;
    try {
      const value = await this.json('/models'); const selected = $('#ai-model').value || this.currentModel || '';
      fillModels($('#ai-model'), value.models, selected);
      fillModels($('#ai-refine-model'), value.models, $('#ai-refine-model').value || this.currentRefineModel || '');
      $('#ai-refine-model').options[0].textContent = '사용 안 함';
      for (const [index, select] of [$('#ai-fallback-1'), $('#ai-fallback-2')].entries()) {
        fillModels(select, value.models, select.value || this.currentFallback?.[index] || ''); select.options[0].textContent = '사용 안 함';
      }
      $('#ai-model-status').textContent = value.error ?? '모델 ' + value.models.length + '개를 확인했습니다. 저장한 연결의 목록입니다.';
    } catch (error) { this.message(error.message); } finally { $('#ai-model-refresh').disabled = false; }
  }
  async refresh() {
    const epoch = this.epoch; const value = await this.json('');
    if (epoch !== this.epoch) return;
    this.currentModel = value.settings.model;
    this.currentRefineModel = value.settings.refine_model ?? '';
    this.currentFallback = value.settings.fallback_models ?? [];
    const use = Object.entries(value.model_use?.models ?? {});
    $('#ai-fallback-status').textContent = use.length ? '엔진 시작 후 모델별 응답: ' + use.map(([model, item]) => model + ' ' + item.answered + '건'
      + (item.failed ? '(실패 ' + item.failed + '건)' : '')).join(', ') : '';
    if (!this.loaded) {
      this.fieldLoaded = false;
      $('#ai-settings').elements.automatic.checked = value.settings.automatic;
      $('#ai-settings').elements.auto_apply_safe.checked = value.settings.auto_apply_safe;
      $('#ai-settings').elements.auto_apply_safe.disabled = value.settings.automatic;
      $('#ai-provider').value = value.settings.provider;
      $('#ai-settings').elements.base.value = value.settings.base;
      $('#ai-settings').elements.clear_key.checked = false;
      $('#ai-proxy-fields').hidden = value.settings.provider !== 'proxy';
      $('#ai-key-status').textContent = value.settings.has_api_key ? '프록시 인증키가 저장되어 있습니다.' : '저장된 프록시 인증키가 없습니다.';
      $('#ai-packs').replaceChildren();
      for (const pack of value.catalog.packs) {
        const label = element('label', '', 'check'); const check = document.createElement('input'); check.type = 'checkbox'; check.value = pack.id;
        label.append(check, document.createTextNode(pack.label)); label.title = pack.scope; $('#ai-packs').append(label);
      }
      this.loaded = true; await this.models();
    }
    const selected = this.id();
    $('#ai-broadcast').replaceChildren(new Option('방송 기록을 선택해 주세요', ''));
    for (const record of value.broadcasts) $('#ai-broadcast').append(new Option(record.title, record.id));
    $('#ai-broadcast').value = value.broadcasts.some(record => record.id === selected) ? selected : value.broadcasts[0]?.id ?? '';
    const active = value.jobs.some(job => job.phase === 'running'); const job = value.jobs.find(job => job.id === this.id());
    const names = { running: '후보 생성 중', completed: '후보 생성 완료', cancelled: '생성 중단', failed: '후보 생성 실패', interrupted: '서버 재시작으로 중단' };
    $('#ai-job').textContent = (names[job?.phase] ?? (this.id() ? '후보 생성 대기' : '회의록 받아쓰기가 있는 방송 기록을 기다립니다.'))
      + (job ? ' · 생성 ' + (job.processed ?? 0) + '개' : '') + (job?.error ? ' · ' + job.error : '')
      + (value.collection_blocks ? ' · 로컬 후보정은 녹음·전사 종료 후 생성합니다.' : '');
    $('#ai-start').disabled = active || value.collection_blocks || !this.id() || !value.settings.model;
    $('#ai-cancel').disabled = job?.phase !== 'running';
    $('#ai-apply-safe').disabled = !this.id();
    if (selected !== this.id() || !this.fieldLoaded) await this.select(); else await this.candidates();
  }
  async select() {
    this.fieldLoaded = false; this.page = null;
    if (!this.id()) { $('#ai-candidates').textContent = '회의록 받아쓰기가 있는 방송 기록이 없습니다.'; $('#ai-older').disabled = true; return; }
    const id = this.id(); const field = await this.json('/field?broadcast=' + id);
    if (this.id() !== id) return;
    for (const input of $('#ai-packs').querySelectorAll('input')) input.checked = field.pack_ids.includes(input.value);
    $('#ai-field').elements.custom.value = field.custom;
    $('#ai-field').elements.auto_select.checked = field.auto_select === true;
    $('#ai-glossary').textContent = field.glossary.text;
    $('#ai-glossary-count').textContent = '참고어 ' + field.glossary.count + '개 · ' + field.glossary.text.length
      + '자 · 한도 밖 ' + field.glossary.omitted + '개는 전달하지 않습니다.';
    this.fieldLoaded = true; await this.candidates();
  }
  async candidates() {
    if (!this.id()) return;
    const id = this.id(); const epoch = this.epoch;
    const waiting = $('#ai-waiting').checked;
    const value = await this.json('/candidates?broadcast=' + id + (this.page && !waiting ? '&before=' + this.page : '') + (waiting ? '&waiting=1' : ''));
    if (epoch !== this.epoch || id !== this.id()) return;
    const signature = JSON.stringify([id, this.page, waiting, value]);
    if (signature === this.candidateSignature) return;
    this.candidateSignature = signature;
    this.before = value.before; const container = $('#ai-candidates'); container.replaceChildren();
    if (!value.items.length) container.append(element('p', waiting ? '확인을 기다리는 후보가 없습니다.' : '이 페이지에 후보가 없습니다.'));
    for (const item of value.items) {
      const card = element('article', '', 'discovery-record');
      card.append(element('h4', clock(item.start_ms) + ' ~ ' + clock(item.end_ms)));
      card.append(element('p', '원문: ' + item.source_text, 'preserve-lines'));
      card.append(element('p', '후보: ' + item.text, 'preserve-lines'));
      card.append(element('p', '모델: ' + item.model, 'help'));
      if (item.stale) card.append(element('p', '회의록 받아쓰기가 변경되어 적용할 수 없습니다. 최신 회의록 받아쓰기를 검토해 주세요.'));
      const status = { pending: '검토 대기', applied: '적용 완료', rejected: '적용 제외' };
      card.append(element('p', status[item.status], 'help'));
      let check;
      if (item.issue) {
        card.append(element('p', item.issue === 'numbers' ? '숫자가 바뀌었습니다. 원음을 확인해 주세요.' : item.issue === 'hallucination' ? '방송 대기 화면 등에서 생기는 환각 의심 문장이라 공개하지 않았습니다. 실제 발언이면 원음을 확인한 뒤 직접 수정해 주세요.' : item.issue === 'superseded' ? '후보를 만든 뒤 문장이 다시 바뀌어 적용하지 않았습니다.' : '문장 길이가 크게 바뀌었습니다. 원음을 확인해 주세요.'));
        const label = element('label', '', 'check'); check = document.createElement('input'); check.type = 'checkbox';
        label.append(check, document.createTextNode('원음과 변경 내용을 확인했습니다.')); card.append(label);
      }
      if (item.status === 'pending') {
        const row = element('div', '', 'row'); const apply = element('button', '이 후보 적용'); const reject = element('button', '적용 제외', 'secondary');
        apply.disabled = item.stale || Boolean(item.issue);
        check?.addEventListener('change', () => { apply.disabled = item.stale || !check.checked; });
        if (check && !item.stale) {
          check.checked = this.checked.has(item.id); apply.disabled = !check.checked;
          check.addEventListener('change', () => { if (check.checked) this.checked.add(item.id); else this.checked.delete(item.id); this.updateChecked(); });
        }
        apply.addEventListener('click', () => this.action('/apply', { id: item.id, acknowledge: check?.checked ?? false }, '후보를 적용했습니다.'));
        reject.addEventListener('click', () => this.action('/reject', { id: item.id }, '후보를 적용에서 제외했습니다.'));
        row.append(apply, reject); card.append(row);
      }
      container.append(card);
    }
    $('#ai-older').disabled = value.before === null || value.items.length < 50;
  }
  updateChecked() {
    $('#ai-apply-checked').disabled = !this.checked.size;
    $('#ai-apply-checked').textContent = '확인 표시한 후보 적용' + (this.checked.size ? ' (' + this.checked.size + '개)' : '');
  }
  clear() {
    this.epoch++; this.loaded = false; this.fieldLoaded = false; this.currentModel = ''; this.before = null; this.page = null; this.candidateSignature = null;
    this.checked.clear(); this.updateChecked();
    $('#ai-settings').reset(); $('#ai-field').reset(); $('#ai-broadcast').replaceChildren(); $('#ai-candidates').replaceChildren();
  }
}
