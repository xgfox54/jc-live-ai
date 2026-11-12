// Keyword alerts run only in this browser: settings stay in localStorage and only AI-corrected sentences received
// after the page opened are matched, so past sentences and drafts never raise an alert.
export const KEYWORD_LIMIT = 20;
export const KEYWORD_LENGTH = 40;
const STORAGE_KEY = 'jc-keyword-alerts';
export const normalizeKeyword = value => String(value).normalize('NFC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');

export function parseKeywords(input) {
  const seen = new Set(); const keywords = [];
  for (const part of String(input).split(/[,\n]/)) {
    const keyword = part.trim(); if (!keyword) continue;
    if (keyword.length > KEYWORD_LENGTH) return { error: '키워드는 각각 ' + KEYWORD_LENGTH + '자 이내로 입력해 주세요.' };
    const key = normalizeKeyword(keyword);
    if ([...key].length < 2) return { error: '키워드는 띄어쓰기를 빼고 2자 이상 입력해 주세요.' };
    if (seen.has(key)) continue;
    seen.add(key); keywords.push(keyword);
  }
  if (keywords.length > KEYWORD_LIMIT) return { error: '키워드는 ' + KEYWORD_LIMIT + '개까지 입력할 수 있습니다.' };
  return { keywords };
}

// Spacing differences such as 제2 공항 and 제2공항 still match.
export function matchKeywords(text, keywords) {
  const body = normalizeKeyword(text ?? '');
  return keywords.filter(keyword => body.includes(normalizeKeyword(keyword)));
}

const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
const snippet = text => text.length > 120 ? text.slice(0, 119) + '…' : text;
const clock = ms => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

export class KeywordAlerts {
  constructor({ open, channelName, header = document.querySelector('header .row') }) {
    Object.assign(this, { open, channelName }); this.seen = new Set(); this.detected = []; this.settings = this.load();
    this.button = node('button', '', 'secondary keyword-button'); this.button.type = 'button';
    this.button.addEventListener('click', () => this.show()); header.append(this.button);
    this.toasts = node('div', undefined, 'keyword-toasts'); this.toasts.setAttribute('aria-live', 'polite'); document.body.append(this.toasts);
    // Only the full-screen element is drawn during browser full screen, so alerts follow it there.
    document.addEventListener('fullscreenchange', () => (document.fullscreenElement ?? document.body).append(this.toasts));
    this.dialog = node('dialog', undefined, 'keyword-dialog'); this.dialog.setAttribute('aria-labelledby', 'keyword-title');
    this.dialog.innerHTML = '<form class="keyword-form"><h2 id="keyword-title">관심 키워드 알림</h2>'
      + '<p class="help">새로 올라오는 AI 후보정 문장에서 키워드를 찾아 알려 드립니다. 설정은 이 브라우저에만 저장되며 이 페이지가 열려 있을 때만 작동합니다. 받아쓰기 오류로 놓칠 수 있습니다.</p>'
      + '<label>키워드(쉼표나 줄바꿈으로 구분, 20개까지)<textarea rows="4" maxlength="1000" placeholder="예: 제2공항, 버스 준공영제, 애월"></textarea></label>'
      + '<label class="check"><input type="checkbox" name="notify"> 다른 창을 보고 있을 때 브라우저 알림 보내기</label>'
      + '<label class="check"><input type="checkbox" name="sound"> 알림 소리 켜기</label>'
      + '<p class="keyword-error" role="alert" hidden></p>'
      + '<div class="row"><button type="submit">저장</button><button type="button" class="secondary clear">모두 지우기</button><button type="button" class="secondary close">닫기</button></div>'
      + '<h3>최근 감지한 문장</h3><ul class="keyword-history"></ul></form>';
    document.body.append(this.dialog);
    const find = selector => this.dialog.querySelector(selector);
    this.input = find('textarea'); this.notify = find('[name=notify]'); this.sound = find('[name=sound]'); this.error = find('.keyword-error');
    if (!('Notification' in window)) { this.notify.disabled = true; this.notify.parentElement.append(' (이 브라우저는 지원하지 않습니다)'); }
    find('form').addEventListener('submit', event => { event.preventDefault(); this.save(); });
    find('.clear').addEventListener('click', () => { this.input.value = ''; this.save(); });
    find('.close').addEventListener('click', () => this.dialog.close());
    this.renderButton();
  }
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      const parsed = parseKeywords((value?.keywords ?? []).join('\n'));
      if (parsed.keywords) return { keywords: parsed.keywords, notify: value.notify === true, sound: value.sound !== false, stored: true };
    } catch { /* Fall through to defaults when storage is blocked or damaged. */ }
    return { keywords: [], notify: false, sound: true, stored: false };
  }
  show() {
    this.input.value = this.settings.keywords.join(', '); this.notify.checked = this.settings.notify; this.sound.checked = this.settings.sound;
    this.error.hidden = true; this.renderHistory(); this.dialog.showModal(); this.input.focus();
  }
  async save() {
    const parsed = parseKeywords(this.input.value);
    if (parsed.error) { this.error.textContent = parsed.error; this.error.hidden = false; return; }
    let notify = this.notify.checked && !this.notify.disabled; let note = '';
    if (notify && Notification.permission === 'default') notify = await Notification.requestPermission() === 'granted';
    if (notify && Notification.permission !== 'granted') notify = false;
    if (this.notify.checked && !notify) note = '브라우저 알림이 허용되지 않아 화면 알림만 표시합니다. 주소창 왼쪽의 사이트 설정에서 알림을 허용할 수 있습니다.';
    if (this.sound.checked) this.prepareSound();
    this.settings = { keywords: parsed.keywords, notify, sound: this.sound.checked, stored: true };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ keywords: this.settings.keywords, notify, sound: this.settings.sound })); }
    catch { note = (note ? note + ' ' : '') + '이 브라우저에서는 설정을 저장할 수 없어 이번 방문 동안만 적용합니다.'; }
    this.renderButton();
    if (note) { this.error.textContent = note; this.error.hidden = false; this.notify.checked = notify; return; }
    this.dialog.close();
  }
  renderButton() {
    const count = this.settings.keywords.length;
    this.button.textContent = count ? '키워드 알림 ' + count + '개' : '키워드 알림';
    this.button.setAttribute('aria-pressed', String(count > 0));
  }
  renderHistory() {
    const list = this.dialog.querySelector('.keyword-history');
    if (!this.detected.length) { list.replaceChildren(node('li', '아직 감지한 문장이 없습니다.', 'help')); return; }
    list.replaceChildren(...this.detected.map(item => {
      const row = node('li'); row.append(node('p', clock(item.at) + ' · ' + this.channelName(item.stream_id) + ' · ‘' + item.keywords.join('’, ‘') + '’', 'help'),
        node('p', snippet(item.text), 'keyword-snippet'));
      const open = node('button', '이 문장 보기', 'secondary'); open.type = 'button';
      open.addEventListener('click', () => { this.dialog.close(); this.open(item.stream_id, item.segment_id); });
      row.append(open); return row;
    }));
  }
  inspect(segment) {
    if (!this.settings.keywords.length || this.seen.has(segment.segment_id)) return;
    const keywords = matchKeywords(segment.text, this.settings.keywords); if (!keywords.length) return;
    if (this.seen.size > 5000) this.seen.clear();
    this.seen.add(segment.segment_id);
    const item = { stream_id: segment.stream_id, segment_id: segment.segment_id, text: segment.text, keywords, at: Date.now() };
    this.detected = [item, ...this.detected].slice(0, 20);
    if (this.dialog.open) this.renderHistory();
    this.toast(item); if (this.settings.sound) this.beep();
    if (this.settings.notify && document.visibilityState === 'hidden' && Notification.permission === 'granted') {
      const notice = new Notification('JC-LIVE · ‘' + keywords[0] + '’ 감지', { body: this.channelName(item.stream_id) + ': ' + snippet(item.text), tag: 'jc-keyword-' + item.segment_id });
      notice.addEventListener('click', () => { window.focus(); notice.close(); this.open(item.stream_id, item.segment_id); });
    }
  }
  toast(item) {
    const box = node('div', undefined, 'keyword-toast');
    const title = node('p', undefined, 'keyword-toast-title'); title.append(node('strong', '‘' + item.keywords.join('’, ‘') + '’'), ' · ' + this.channelName(item.stream_id));
    const actions = node('div', undefined, 'row');
    const open = node('button', '이 문장 보기', 'secondary'); open.type = 'button';
    const close = node('button', '닫기', 'secondary'); close.type = 'button';
    open.addEventListener('click', () => { box.remove(); this.open(item.stream_id, item.segment_id); }); close.addEventListener('click', () => box.remove());
    actions.append(open, close); box.append(title, node('p', snippet(item.text), 'keyword-snippet'), actions);
    this.toasts.prepend(box); while (this.toasts.children.length > 3) this.toasts.lastElementChild.remove();
    setTimeout(() => box.remove(), 30_000);
  }
  // A context created during the save click is allowed to play later alert sounds.
  prepareSound() {
    try { this.audio ??= new AudioContext(); this.audio.resume().catch(() => {}); } catch { this.audio = null; }
  }
  beep() {
    if (!this.audio || this.audio.state !== 'running') return;
    const tone = this.audio.createOscillator(); const gain = this.audio.createGain(); const start = this.audio.currentTime;
    tone.frequency.value = 880; gain.gain.setValueAtTime(0.08, start); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    tone.connect(gain).connect(this.audio.destination); tone.start(start); tone.stop(start + 0.2);
  }
}
