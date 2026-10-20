const active = new Map();
export async function startCapture(id, api, message) {
  if (active.has(id)) throw new Error('이미 수집 중입니다.');
  const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true,
    systemAudio: 'exclude', selfBrowserSurface: 'exclude' });
  if (!media.getAudioTracks().length) {
    media.getTracks().forEach(track => track.stop());
    throw new Error('방송 탭과 탭 오디오 공유를 선택해 주세요.');
  }
  // Require a browser tab; whole-screen/system capture can mix unrelated broadcasts.
  if (media.getVideoTracks()[0].getSettings().displaySurface !== 'browser') {
    media.getTracks().forEach(track => track.stop()); throw new Error('전체 화면 대신 방송 탭을 선택해 주세요.');
  }
  let audio; let state;
  try {
    state = await (await api('/api/admin/streams/' + id + '/start', { method: 'POST' })).json();
    audio = new AudioContext({ sampleRate: 16000 });
    await audio.audioWorklet.addModule('/pcm-worklet.mjs');
    const node = new AudioWorkletNode(audio, 'pcm-capture');
    const source = audio.createMediaStreamSource(new MediaStream(media.getAudioTracks()));
    const mute = audio.createGain(); mute.gain.value = 0;
    source.connect(node).connect(mute).connect(audio.destination);
    const capture = { media, audio, source, node, state, seq: 0, queued: 0, chain: Promise.resolve(), stopping: false, failure: false };
    active.set(id, capture);
    node.port.onmessage = event => {
      if (event.data === 'flushed') { capture.flushed?.(); return; }
      if (capture.queued >= 3) {
        capture.failure = true;
        message('전송이 밀려 수집을 중지합니다. 다시 시작하면 새 세션을 만듭니다.');
        stopCapture(id, api).catch(error => message(error.message)); return;
      }
      capture.queued++;
      const seq = capture.seq++;
      capture.chain = capture.chain.then(async () => {
        const headers = { 'Content-Type': 'application/octet-stream', 'X-Session': state.session_id,
          'X-Epoch': String(state.timeline_epoch), 'X-Sequence': String(seq) };
        // Retrying the same sequence is safe if a response was lost after commit.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await api('/api/admin/streams/' + id + '/pcm', { method: 'POST', headers,
              body: event.data, signal: AbortSignal.timeout(5000) }); break;
          } catch (error) { if (attempt === 1) throw error; }
        }
      }).catch(error => {
        capture.failure = true;
        message('입력 연결이 끊겼습니다: ' + error.message);
        queueMicrotask(() => stopCapture(id, api).catch(failure => message(failure.message)));
      }).finally(() => capture.queued--);
    };
    media.getVideoTracks()[0].addEventListener('ended', () => stopCapture(id, api).catch(error => message(error.message)));
    await audio.resume(); message('탭 음성을 수집합니다. 선택한 탭이 등록한 방송인지 확인해 주세요.');
  } catch (error) {
    active.delete(id);
    media.getTracks().forEach(track => track.stop()); if (audio) await audio.close();
    if (state) await api('/api/admin/streams/' + id + '/stop', { method: 'POST' });
    throw error;
  }
}
export async function stopCapture(id, api) {
  const capture = active.get(id);
  if (capture) {
    if (capture.stopping) return;
    capture.stopping = true;
    await new Promise(resolve => {
      const timer = setTimeout(() => { capture.failure = true; resolve(); }, 1000);
      capture.flushed = () => { clearTimeout(timer); resolve(); };
      capture.node.port.postMessage('flush');
    });
    capture.node.port.onmessage = null; capture.node.disconnect(); capture.source.disconnect();
    capture.media.getTracks().forEach(track => track.stop());
    await capture.audio.close(); await capture.chain; active.delete(id);
  }
  await api('/api/admin/streams/' + id + '/stop', {
    method: 'POST', headers: capture?.failure ? { 'X-Capture-Gap': '1' } : {}
  });
}
export function captureCount() { return active.size; }
