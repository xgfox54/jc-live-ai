import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACOUSTIC_METHOD = 'offline-pyannote-wespeaker-v1';
export const SPEAKER_MODELS = Object.freeze({
  segmentation: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  embedding: '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94',
});
export const cosine = (a, b) => {
  if (!a?.length || a.length !== b?.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
};
export function acousticFeatures(raw, rows) {
  if (!raw || raw.method !== ACOUSTIC_METHOD || !Array.isArray(raw.features) || raw.features.length > rows.length) throw new Error('Invalid acoustic result');
  const known = new Map(rows.map(row => [row.segment_id, row])); const seen = new Set();
  return raw.features.map(item => {
    const row = known.get(item.segment_id);
    if (!row || seen.has(item.segment_id) || item.session_id !== row.session_id || (row.timeline_epoch ?? 0) !== 0
      || typeof item.cluster !== 'string' || !/^voice-[0-9]{1,5}$/.test(item.cluster)
      || !Number.isFinite(item.voiced_s) || item.voiced_s < 0 || item.voiced_s > (row.end_ms - row.start_ms) / 1000 + .1
      || !Number.isFinite(item.purity) || item.purity < 0 || item.purity > 1
      || !Array.isArray(item.vector) || item.vector.length !== 256 || item.vector.some(x => !Number.isFinite(x))
      || typeof item.mixed !== 'boolean') throw new Error('Invalid acoustic feature');
    seen.add(item.segment_id);
    return { ...item, cluster: row.session_id + ':' + item.cluster, version: row.version };
  });
}
export function acousticOverlay(rows, features) {
  const lookup = new Map(features.map(feature => [feature.segment_id, feature]));
  return rows.map(row => {
    const feature = lookup.get(row.segment_id);
    if (!feature) return row;
    return { ...row, acoustic_cluster: feature.cluster,
      speaker_scope: 'offline:' + row.session_id, speaker_id: feature.cluster,
      speaker_state: feature.mixed || feature.purity < .85 ? 'multiple' : 'assigned', speaker_turns: [] };
  });
}
// Enrollment is limited to evidence from this meeting. A cluster is never itself a person's identity.
export function voiceCandidates(rows, features, assignments, { threshold = .8, margin = .12 } = {}) {
  const known = new Map(rows.map(row => [row.segment_id, row])); const samples = new Map();
  const usable = feature => !feature.mixed && feature.voiced_s >= 3 && feature.purity >= .9;
  for (const feature of features.filter(usable)) {
    const identity = assignments[feature.segment_id];
    if (!identity?.name || !known.has(feature.segment_id) || identity.blocked) continue;
    const group = samples.get(identity.name) ?? [];
    group.push({ feature, identity }); samples.set(identity.name, group);
  }
  const profiles = [];
  for (const [name, samplesForName] of samples) {
    // Two separate source sentences must agree; one short introduction cannot enroll a voice alone.
    const stable = samplesForName.filter(a => samplesForName.some(b => a !== b && cosine(a.feature.vector, b.feature.vector) >= threshold));
    if (stable.length < 2) continue;
    profiles.push({ name, samples: stable });
  }
  const matches = {};
  for (const feature of features.filter(usable)) {
    const scored = profiles.map(profile => {
      const ranked = profile.samples.filter(sample => sample.feature.segment_id !== feature.segment_id)
        .map(sample => ({ ...sample, score: cosine(feature.vector, sample.feature.vector) })).sort((a, b) => b.score - a.score);
      // Average the best two independent examples, rather than accepting one accidental match.
      return { name: profile.name, ranked, score: ranked.length >= 2 ? (ranked[0].score + ranked[1].score) / 2 : -1 };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0]; const runnerUp = scored[1]?.score ?? 0;
    if (!best || best.score < threshold || best.score - runnerUp < margin) continue;
    // Conflicting direct evidence is preserved for administrator review, not silently overwritten.
    if (assignments[feature.segment_id]?.name && assignments[feature.segment_id].name !== best.name) continue;
    matches[feature.segment_id] = { ...best.ranked[0].identity, evidence_id: best.ranked[0].feature.segment_id,
      evidence_ids: best.ranked.slice(0, 2).map(sample => sample.feature.segment_id), method: 'same-meeting-voice',
      similarity: Math.round(best.score * 1000) / 1000, margin: Math.round((best.score - runnerUp) * 1000) / 1000 };
  }
  return matches;
}
const digest = async file => { const h = createHash('sha256'); for await (const part of createReadStream(file)) h.update(part); return h.digest('hex'); };
// Analysis after a meeting gives way to collection only while a channel is taking in speech. A running channel that has received
// QUIET_MS of audio since its last recognized sentence does not count: on 2026-11-24 the 교육위원회 broadcast stayed on through a
// recess from 12:05 into the evening, and every speaker review and video alignment waited for it. When speech comes back, an
// analysis in progress stops within 2 seconds and is tried again later.
export const QUIET_MS = 600_000;
export const speakingCapture = (scheduler, quietMs = QUIET_MS) => Boolean(scheduler?.states?.().some(s => ['draining', 'degraded', 'reconnecting'].includes(s.state)
  || (s.state === 'running' && !(s.audio_received_until - (s.last_speech_segment_end ?? 0) >= quietMs))));
const capturePriority = () => Object.assign(new Error('Live capture has priority'), { code: 'CAPTURE_PRIORITY' });

// The speaker-review environment (worker/speaker-review-requirements.txt) also provides numpy for the video alignment script.
export const speakerReviewPython = config =>
  resolve(config.speakerReviewPython ?? resolve(config.speakerReviewDirectory ?? 'bin/speaker-review') + '/venv/Scripts/python.exe');
export class SpeakerAcoustics {
  constructor({ registry, review, audioReview, config, scheduler }) { Object.assign(this, { registry, review, audioReview, config, scheduler }); }
  // True while a review that analyzes the recordings would be refused: the analysis models are installed and a channel is
  // taking in speech.
  deferred() { return this.config.speakerReview !== false && Object.values(this.paths()).every(existsSync) && speakingCapture(this.scheduler); }
  paths() {
    const root = resolve(this.config.speakerReviewDirectory ?? 'bin/speaker-review');
    return { python: speakerReviewPython(this.config),
      segmentation: resolve(root, 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx'), embedding: resolve(root, 'embedding.onnx') };
  }
  async prepare(id, rows, sourceHash, signal, progress = () => {}) {
    const previous = this.review.get('speaker-acoustics:' + id);
    const paths = this.paths();
    if (this.config.speakerReview === false || !Object.values(paths).every(existsSync)) return { phase: 'unconfigured', features: [] };
    if (speakingCapture(this.scheduler)) throw capturePriority();
    const sessions = this.registry.sessions(id); const recordings = []; const missing = [];
    for (const session of sessions) {
      signal.throwIfAborted();
      if (!rows.some(row => row.session_id === session.session_id)) continue;
      if ((session.timeline_epoch ?? 0) !== 0 || rows.some(row => row.session_id === session.session_id && (row.timeline_epoch ?? 0) !== 0)) { missing.push(session.session_id); continue; }
      try {
        const source = session.source_session ? { ...session, session_id: session.source_session } : session;
        const recording = await this.audioReview.recording(source);
        if (recording.bytes % 2 || recording.bytes < 32000 || recording.bytes > 32000 * 21600) throw new Error('Recording length limit');
        recordings.push({ ...recording, session_id: session.session_id, sha256: await digest(recording.file) });
      } catch { missing.push(session.session_id); }
    }
    const signature = createHash('sha256').update(JSON.stringify([ACOUSTIC_METHOD, sourceHash, recordings.map(r => [r.session_id, r.sha256])])).digest('hex');
    if (previous?.signature === signature && previous.phase === 'complete') return previous;
    if (!recordings.length) return { phase: 'unavailable', missing, features: [] };
    for (const key of ['segmentation', 'embedding']) if (await digest(paths[key]) !== SPEAKER_MODELS[key]) throw new Error('Speaker model integrity failed');
    signal.throwIfAborted();
    const directory = resolve(this.config.analysisDirectory ?? 'data/analysis'); await mkdir(directory, { recursive: true });
    const requestFile = resolve(directory, randomUUID() + '.json'); const outputFile = requestFile + '.result';
    await writeFile(requestFile, JSON.stringify({ ...paths, recordings, rows: rows.map(({ segment_id, session_id, start_ms, end_ms, timeline_epoch }) =>
      ({ segment_id, session_id, start_ms, end_ms, timeline_epoch: timeline_epoch ?? 0 })) }), { flag: 'wx' });
    try {
      await new Promise((done, reject) => {
        const child = spawn(paths.python, ['-B', '-u', '-s', fileURLToPath(new URL('../worker/speaker_offline.py', import.meta.url)), requestFile, outputFile],
          { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
        let tail = '', failure; const stop = (reason = new Error('Speaker analysis stopped')) => {
          if (failure) return;
          failure = reason;
          // Windows venv launchers spawn the interpreter; terminate only this owned process tree.
          if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
          else child.kill();
        };
        const interval = setInterval(() => { if (speakingCapture(this.scheduler)) stop(capturePriority()); }, 2000); interval.unref();
        const timeout = setTimeout(stop, 7_200_000); timeout.unref();
        signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
        child.stdout.on('data', part => {
          tail += part.toString(); if (tail.length > 4096) { stop(); return; }
          let at; while ((at = tail.indexOf('\n')) >= 0) {
            const line = tail.slice(0, at); tail = tail.slice(at + 1);
            try { const value = JSON.parse(line); if (Number.isFinite(value.completed) && Number.isFinite(value.total)) progress(value); }
            catch { stop(); }
          }
        });
        child.once('error', error => { failure = error; });
        child.once('close', code => { clearInterval(interval); clearTimeout(timeout); signal.removeEventListener('abort', stop);
          failure || code !== 0 ? reject(failure ?? new Error('Speaker analysis failed')) : done(); });
      });
      signal.throwIfAborted();
      const raw = JSON.parse(await readFile(outputFile, 'utf8'));
      const features = acousticFeatures(raw, rows);
      const result = { method: ACOUSTIC_METHOD, phase: 'complete', signature, source_hash: sourceHash, missing,
        features, stats: raw.stats, updated_ms: Date.now() };
      this.review.save('speaker-acoustics:' + id, result);
      return result;
    } finally { await unlink(requestFile).catch(() => {}); await unlink(outputFile).catch(() => {}); }
  }
}
