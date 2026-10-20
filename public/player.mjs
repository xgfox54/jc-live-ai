export function visibleAt(segment, clock) {
  if (!clock || segment.session_id !== clock.session || segment.timeline_epoch !== clock.epoch) return false;
  return Number.isFinite(segment.end_ms) && segment.end_ms <= clock.audioMs;
}
let apiReady;
function loadPlayerApi() {
  if (globalThis.YT?.Player) return Promise.resolve();
  if (!apiReady) apiReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { apiReady = null; reject(new Error('공식 플레이어 응답 시간이 초과됐습니다.')); }, 15000);
    globalThis.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { clearTimeout(timer); apiReady = null; reject(new Error('공식 플레이어를 불러오지 못했습니다.')); };
    document.head.append(script);
  });
  return apiReady;
}
export function evaluateSeek(observed, target) {
  const error = Math.abs(observed - target);
  return { supported: Number.isFinite(error) && error <= 2, error_s: error };
}
export class OfficialPlayer {
  constructor(container, message, options = {}) {
    this.container = container; this.message = message; this.options = options;
    this.anchor = null; this.player = null; this.muted = options.muted ?? false; this.ready = false;
  }
  dispose() {
    this.selection = (this.selection ?? 0) + 1; this.ready = false; this.anchor = null;
    if (this.player) this.player.destroy();
    this.player = null; this.container.replaceChildren();
  }
  setMuted(value) {
    this.muted = value;
    if (this.ready) { if (value) this.player.mute(); else this.player.unMute(); }
  }
  async select(stream) {
    this.dispose(); const selection = this.selection;
    this.anchor = null; this.stream = stream;
    if (this.player) { this.player.destroy(); this.player = null; }
    this.container.replaceChildren();
    if (!stream.video_id) { this.message('이 방송은 공식 영상 링크에서 시청해 주세요.'); return; }
    await loadPlayerApi(); if (selection !== this.selection) return;
    const host = document.createElement('div'); this.container.append(host);
    this.player = new globalThis.YT.Player(host, { videoId: stream.video_id,
      width: '100%', height: '300', playerVars: { origin: location.origin, playsinline: 1 },
      events: {
        onReady: () => {
          if (selection !== this.selection) return;
          this.ready = true; this.setMuted(this.muted);
          this.message(this.options.viewer ? '재생 버튼을 눌러 시청합니다.' : '동기화 확인 중: DVR와 음성·영상 시간 연결을 확인해야 합니다.');
        },
        onError: event => { if (selection !== this.selection) return; this.anchor = null;
          this.message(this.options.viewer ? '이 영상을 재생할 수 없습니다. 공식 영상 링크를 이용해 주세요.' : '재생 불가: 공식 플레이어 오류 ' + event.data); },
        onStateChange: event => {
          if (selection !== this.selection) return;
          if ([2, 3, -1, 0].includes(event.data)) {
            this.anchor = null;
            if (!this.options.viewer) this.message('동기화 확인 중: 재생 상태가 변경됐습니다.');
          }
        }
      } });
  }
  async probe(values) {
    if (!this.player?.seekTo) throw new Error('공식 플레이어가 준비되지 않았습니다.');
    if (![values.liveEdge, values.audioMs, values.playerSeconds].every(Number.isFinite)
      || values.liveEdge < 30 || values.audioMs < 0 || values.playerSeconds < 0) throw new Error('시간 값을 확인해 주세요.');
    const target = values.liveEdge - 30;
    this.anchor = null; this.player.seekTo(target, true); this.player.playVideo();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const result = evaluateSeek(this.player.getCurrentTime(), target + 1.5);
    if (!result.supported) { this.message('정밀 동기화 불가: 30초 전 탐색 위치를 확인하지 못했습니다.'); return result; }
    this.anchor = { ...values, checkedAt: Date.now(), lastTime: this.player.getCurrentTime(), lastWall: Date.now() };
    this.message('추정 지연 약 30초 · 탐색 오차 ' + result.error_s.toFixed(2) + '초 · 수동 시간 기준');
    return result;
  }
  clock(state) {
    const a = this.anchor;
    if (!a || !state || a.session !== state.session_id || a.epoch !== state.timeline_epoch
      || Date.now() - a.checkedAt > 300_000 || this.player.getPlayerState() !== 1) return null;
    const time = this.player.getCurrentTime(); const wall = Date.now();
    if (Math.abs((time - a.lastTime) - (wall - a.lastWall) / 1000) > 3) {
      this.anchor = null; this.message('동기화 확인 중: 탐색 또는 시간축 변경이 감지됐습니다.'); return null;
    }
    a.lastTime = time; a.lastWall = wall;
    return { session: a.session, epoch: a.epoch, audioMs: a.audioMs + (time - a.playerSeconds) * 1000 };
  }
  seek(segment) {
    if (!this.anchor || segment.session_id !== this.anchor.session || segment.timeline_epoch !== this.anchor.epoch) return;
    this.player.seekTo(this.anchor.playerSeconds + (segment.start_ms - this.anchor.audioMs) / 1000, true);
  }
}
