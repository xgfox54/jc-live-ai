// Candidate phrases alone never establish silence; retain short utterances and uncertain diarization.
const FILLER = '(?:감사합니다|고맙습니다|수고하셨습니다|네|예|아|어|음)';
const FILLER_ONLY = new RegExp('^(?:\\s*' + FILLER + '[.,!?…~\\s]*)+$');
// Hesitation sounds alone carry no content; over music or silence Whisper emits them every chunk ("그.").
const HESITATION_ONLY = /^(?:\s*(?:그|저|어|음|아|으|흠|자|이)[.,!?…~\s]*)+$/;
// Whole-segment outros Whisper learned from video endings; observed 528 times in the 2026-10-21 council broadcasts.
const OUTROS = [/^(?:[A-Za-z가-힣]{2,10}\s*)?뉴스\s*[가-힣]{2,4}(?:\s*기자)?입니다\.?$/,
  /^(?:\s*(?:시청|청취)해\s*주셔서\s*(?:정말\s*)?감사합니다[.!~\s]*)+$/, /^구독과\s*좋아요/];
const REPEATED_RUN = /((?:감사합니다|고맙습니다)[.,!?…~]?)(?:\s*(?:감사합니다|고맙습니다)[.,!?…~]?){2,}/g;
export const fillerOnly = text => FILLER_ONLY.test(String(text ?? '').trim());
export function voicedMs(speakers) {
  return (speakers?.speaker_turns ?? []).reduce((sum, turn) => sum + Math.max(0, turn.end_ms - turn.start_ms), 0);
}
// Missing or failed diarization is unknown. Positive speech evidence takes precedence.
export function nonSpeech(text, speakers) {
  if (voicedMs(speakers) > 0 || speakers?.speech_activity?.state === 'speech') return false;
  if (speakers?.speech_activity?.state === 'silence') return true;
  const trimmed = String(text ?? '').trim();
  const suspect = fillerOnly(trimmed) || HESITATION_ONLY.test(trimmed) || OUTROS.some(pattern => pattern.test(trimmed));
  return Boolean(suspect && speakers?.speaker_state === 'unknown' && Array.isArray(speakers.speaker_turns) && speakers.speaker_turns.length === 0);
}
// "...입니다. 감사합니다. 감사합니다. 감사합니다." keeps one closing courtesy phrase.
export const collapseRepeats = text => String(text ?? '').replace(REPEATED_RUN, '$1').trim();
// Public filter for stored rows: hides silence hallucinations that were recorded before this filter existed.
export const publicSpeech = row => !nonSpeech(row.corrected_text ?? row.raw_text, row);
