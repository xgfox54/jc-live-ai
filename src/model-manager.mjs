import { HttpError } from './validate.mjs';

export class ModelManager {
  constructor(ai, fetcher = fetch) { this.ai = ai; this.fetcher = fetcher; this.status = { phase: 'idle' }; }
  check(model) {
    if (typeof model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(model)) throw new HttpError(400, '모델 이름을 확인해 주세요.');
    if (this.pending || this.ai.pending || this.ai.externalBusy || this.ai.busy()) throw new HttpError(409, '모든 음성·AI 작업 종료 후 모델을 관리합니다.');
  }
  start(model) {
    this.check(model); this.controller = new AbortController(); this.status = { model, phase: 'downloading', completed: 0, total: null };
    this.ai.externalBusy = true;
    this.pending = this.pull(model, this.controller.signal).finally(() => { this.pending = null; this.ai.externalBusy = false; });
    return this.status;
  }
  async pull(model, signal) {
    try {
      const response = await this.fetcher('http://127.0.0.1:11434/api/pull', { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3600000)]),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
      if (!response.ok) throw new Error('request');
      const decoder = new TextDecoder(); let line = ''; let succeeded = false;
      const update = text => {
        if (!text.trim()) return; const value = JSON.parse(text); if (value.error) throw new Error('download');
        if (value.status === 'success') succeeded = true;
        this.status = { model, phase: 'downloading', completed: Number.isFinite(value.completed) ? value.completed : 0,
          total: Number.isFinite(value.total) ? value.total : null };
      };
      for await (const part of response.body) {
        line += decoder.decode(part, { stream: true });
        for (let end = line.indexOf('\n'); end >= 0; end = line.indexOf('\n')) { update(line.slice(0, end)); line = line.slice(end + 1); }
        if (line.length > 16384) throw new Error('response');
      }
      update(line + decoder.decode()); if (!succeeded) throw new Error('incomplete'); this.status = { model, phase: 'completed' };
    } catch { this.status = { model, phase: signal.aborted ? 'cancelled' : 'failed', error: '모델 다운로드가 중단됐거나 실패했습니다. Ollama 연결과 저장 공간을 확인해 주세요.' }; }
  }
  async cancel() { this.controller?.abort(); await this.pending; return this.status; }
  async remove(model) {
    this.check(model); if (model === this.ai.settings().model) throw new HttpError(409, '다른 모델을 선택한 뒤 삭제해 주세요.');
    this.ai.externalBusy = true;
    try {
    const response = await this.fetcher('http://127.0.0.1:11434/api/delete', { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      if (!response.ok) throw new HttpError(502, 'Ollama 모델 삭제에 실패했습니다.'); return { deleted: true };
    } finally { this.ai.externalBusy = false; }
  }
  async close() { await this.cancel(); }
}
