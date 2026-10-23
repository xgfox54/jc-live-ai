// Digital silence is safe to skip without interpreting a transcript. Quiet speech remains eligible.
export function digitalSilence(pcm) {
  if (!pcm?.length || pcm.length % 2) return false;
  for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 1) return false;
  return true;
}

export function speechActivity(pcm, speakers, job) {
  if (digitalSilence(pcm)) return { state: 'silence', method: 'digital-silence' };
  const turns = speakers?.speaker_turns;
  if (Array.isArray(turns) && turns.some(t => Number.isFinite(t.start_ms) && Number.isFinite(t.end_ms) && t.end_ms > t.start_ms))
    return { state: 'speech', method: 'nemotron' };
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
