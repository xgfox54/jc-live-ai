import { OfficialPlayer } from './player.mjs';
import { transcriptNodes } from './transcripts.mjs';

const $ = selector => document.querySelector(selector);
export class AdminTools {
  constructor(context) {
    this.context = context; this.previewId = null;
    this.player = new OfficialPlayer($('#admin-player'), value => { $('#sync-status').textContent = value; });
    $('#settings-form').addEventListener('submit', event => this.saveSettings(event));
    $('#review-channel').addEventListener('change', () => this.renderReview());
    $('#review-refresh').addEventListener('click', () => context.refresh().catch(error => context.message(error.message)));
    $('#correct').addEventListener('submit', event => this.correct(event));
    $('#preview').addEventListener('click', async () => {
      const stream = context.streams().find(value => value.stream_id === $('#sync-channel').value);
      if (!stream) { context.message('먼저 방송을 등록해 주세요.'); return; }
      this.previewId = stream.stream_id;
      try { await this.player.select(stream); } catch (error) { context.message(error.message); }
    });
    $('#sync-channel').addEventListener('change', () => this.stopPreview());
    $('#sync-form').addEventListener('submit', async event => {
      event.preventDefault(); const status = context.state.status.get(this.previewId);
      if (!status || this.previewId !== $('#sync-channel').value) { context.message('수집 이력이 있는 방송의 점검 영상을 먼저 열어 주세요.'); return; }
      const data = Object.fromEntries(new FormData(event.target));
      try { await this.player.probe({ audioMs: Number(data.audio) * 1000, playerSeconds: Number(data.video),
        liveEdge: Number(data.edge), session: status.session_id, epoch: status.timeline_epoch }); }
      catch (error) { context.message(error.message); }
    });
  }
  showSettings(value) {
    const form = $('#settings-form');
    for (const key of ['chunkSeconds', 'queueChunks', 'silenceRms']) form.elements[key].value = value.editable[key];
    form.elements.recordAudio.checked = value.editable.recordAudio;
    form.elements.maxRecordingMB.value = value.editable.maxRecordingBytes / 1000000;
    $('#engine-info').textContent = (value.engine.device === 'gpu' ? 'GPU' : 'CPU') + ' · ' + value.engine.model
      + ' · 탐색 수 ' + value.engine.beam + ' · 배치 ' + value.engine.batch;
  }
  async saveSettings(event) {
    event.preventDefault(); const form = event.target; const button = form.querySelector('button'); button.disabled = true;
    const data = Object.fromEntries(new FormData(form));
    try {
      const response = await this.context.api('/api/admin/settings', { method: 'POST', body: JSON.stringify({
        chunkSeconds: Number(data.chunkSeconds), queueChunks: Number(data.queueChunks), silenceRms: Number(data.silenceRms),
        recordAudio: data.recordAudio === 'on', maxRecordingBytes: Math.round(Number(data.maxRecordingMB) * 1000000)
      }) });
      this.showSettings(await response.json()); this.context.message('설정을 저장했습니다. 다음 수집부터 적용합니다.');
    } catch (error) { this.context.message(error.message); }
    finally { button.disabled = false; }
  }
  renderReview() {
    const items = [...this.context.state.segments.values()].filter(item => item.stream_id === $('#review-channel').value);
    const container = $('#review-transcripts'); const top = container.scrollTop;
    container.replaceChildren(transcriptNodes(items, { select: item => {
      const form = $('#correct'); form.elements.id.value = item.segment_id; form.elements.version.value = item.version;
      form.elements.text.value = item.corrected_text ?? item.raw_text; form.elements.text.focus();
    } }));
    container.scrollTop = top;
  }
  async correct(event) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
    if (!data.id) { this.context.message('수정할 문장을 먼저 선택해 주세요.'); return; }
    try {
      const saved = await (await this.context.api('/api/admin/segments/' + encodeURIComponent(data.id), {
        method: 'POST', body: JSON.stringify({ version: Number(data.version), text: data.text })
      })).json();
      event.target.elements.version.value = saved.version; await this.context.refresh();
      this.context.message('검토문을 저장했습니다. 이용자 전사문에도 반영됩니다.');
    } catch (error) { this.context.message(error.message); }
  }
  stopPreview() { this.player.dispose(); this.previewId = null; $('#sync-status').textContent = '점검할 영상을 선택해 주세요.'; }
}
