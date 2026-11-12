// Digital silence is safe to skip without interpreting a transcript. Quiet speech remains eligible.
export function digitalSilence(pcm) {
  if (!pcm?.length || pcm.length % 2) return false;
  for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 1) return false;
  return true;
}
// Broadcast audio before a meeting, between speakers and in a recess keeps a faint noise floor instead of digital
// silence, and Whisper invents sentences over it ("MBC 뉴스 김지경입니다", "여러분, 한나 고아치님께 전하는데 하는
// 말씀 해 줘요"). In the 6,963 segments recorded from 2026-10-21 to 2026-11-10, 1,243 of the 1,433 segments made only of
// invented or filler phrases had their loudest 20 ms frame below -65 dBFS. Of the 5,530 other segments only that
// invented sentence did; the rest peaked at -61.7 dBFS or louder. Such a chunk is skipped like digital silence.
export const NEAR_SILENCE_DBFS = -65;
export function loudestFrameDbfs(pcm) {
  let loudest = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 640) {
    const end = Math.min(pcm.length - (pcm.length % 2), offset + 640); let sum = 0;
    for (let i = offset; i < end; i += 2) { const value = pcm.readInt16LE(i); sum += value * value; }
    loudest = Math.max(loudest, sum / ((end - offset) / 2));
  }
  return 10 * Math.log10(loudest / 32768 ** 2 + 1e-12);
}
export const nearSilence = pcm => Boolean(pcm?.length >= 640) && loudestFrameDbfs(pcm) < NEAR_SILENCE_DBFS;

export function speechActivity(pcm, speakers, job) {
  if (digitalSilence(pcm)) return { state: 'silence', method: 'digital-silence' };
  if (nearSilence(pcm)) return { state: 'silence', method: 'near-silence' };
  const turns = speakers?.speaker_turns;
  if (Array.isArray(turns) && turns.some(t => Number.isFinite(t.start_ms) && Number.isFinite(t.end_ms) && t.end_ms > t.start_ms))
    return { state: 'speech', method: 'nemotron' };
  // Without speaker diarization (the standby laptop) the optional Silero detector decides speech or silence.
  if (job.acoustic_activity?.state === 'speech' || job.acoustic_activity?.state === 'silence') return job.acoustic_activity;
  if (speakers?.speaker_state === 'unknown' && Array.isArray(turns) && turns.length === 0)
    return { state: 'silence', method: 'nemotron' };
  // Streaming Nemotron retains 640 ms of lookahead. Only trust an empty result when the uncovered tail is digital silence.
  const frontier = speakers?.processed_until_ms - 640;
  if (speakers?.speaker_state === 'pending' && Array.isArray(turns) && turns.length === 0
    && Number.isFinite(frontier) && frontier >= job.start_ms && frontier < job.end_ms) {
    const offset = Math.max(0, Math.floor((frontier - job.start_ms) * 16) * 2);
    if (digitalSilence(pcm.subarray(offset))) return { state: 'silence', method: 'nemotron-digital-tail' };
  }
  return { state: 'unknown', method: 'unavailable-or-pending' };
}
