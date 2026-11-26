// Candidate phrases alone never establish silence; retain short utterances and uncertain diarization.
const FILLER = '(?:감사합니다|고맙습니다|수고하셨습니다|네|예|아|어|음)';
const FILLER_ONLY = new RegExp('^(?:\\s*' + FILLER + '[.,!?…~\\s]*)+$');
// Hesitation sounds alone carry no content; over music or silence Whisper emits them every chunk ("그.").
const HESITATION_ONLY = /^(?:\s*(?:그|저|어|음|아|으|흠|자|이)[.,!?…~\s]*)+$/;
// Whole-segment outros Whisper learned from video endings; observed 528 times in the 2026-10-21 council broadcasts.
const OUTROS = [/^(?:[A-Za-z가-힣]{2,10}\s*)?뉴스\s*[가-힣]{2,4}(?:\s*기자)?입니다\.?$/,
  /^(?:\s*(?:끝까지\s*)?(?:시청|청취)해\s*주셔서\s*(?:정말\s*)?감사합니다[.!~\s]*)+$/, /^구독과\s*좋아요/];
const REPEATED_RUN = /((?:감사합니다|고맙습니다)[.,!?…~]?)(?:\s*(?:감사합니다|고맙습니다)[.,!?…~]?){2,}/g;
// During a recess Whisper repeats one courtesy phrase over room noise or music in every chunk ("감사합니다." five times)
// while the speaker check is still pending, or even reports voice. Three or more such phrases alone are not speech.
const COURTESY_LOOP = /^\s*(?:(?:감사합니다|고맙습니다|수고하셨습니다)[.,!?…~\s]*){3,}$/;
// Phrases Whisper invents over music, applause or silence that no council speaker says. In the 2026-11-10 1차 본회의
// the anthem and the silent-tribute music became '아멘 아멘 아멘', '찬송가 5장' and '한글자막 by 한효정' while the
// speaker check was still pending. A news anchor's sign-off ("MBC 뉴스 김지경입니다", 561 whole segments by 2026-11-10)
// also followed real sentences ("…상정합니다. MBC 뉴스 김성현입니다."). They are cut out of any segment, and a segment
// left with nothing else is not speech. '찬송가' alone stays in sentences ("찬송가 소음 민원") and only a hymn number or
// a bare segment counts. The sign-off needs a broadcaster and a three-syllable name, so "연합뉴스 변지철 기자입니다" stays.
// A YouTube sponsorship notice and a sign-off were invented over the 2026-11-26 recess noise as well.
const INVENTED_PHRASE = '(?:아멘|찬송가\\s*\\d+\\s*장|(?:한글\\s*)?자막\\s*by\\s*[^\\s.,!?…~]+|다음\\s*(?:영상|시간)에서?\\s*만나요'
  + '|(?:자막\\s*제공\\s*및\\s*)+광고를\\s*포함하고\\s*있습니다'
  + '|구독과\\s*좋아요(?:\\s*부탁\\s*(?:드립니다|드려요|해요))?|(?:MBC|KBS|SBS)\\s*뉴스\\s*[가-힣]{3}입니다)';
const EDGE_BEFORE = '(?<=^|[\\s.,!?…~])'; const EDGE_AFTER = '(?=$|[\\s.,!?…~])';
const INVENTED = new RegExp(EDGE_BEFORE + INVENTED_PHRASE + EDGE_AFTER + '[.,!?…~]*', 'giu');
const HAS_INVENTED = new RegExp(EDGE_BEFORE + INVENTED_PHRASE + EDGE_AFTER, 'iu');
// Whole segments of this kind are invented as well: a sound tag ("박수", "(음악)", "♪"), a bare hymn mention or a
// subtitle credit ("자막제공자").
const INVENTED_WHOLE = [/^(?:\s*(?:[(\[]\s*)?(?:박수|음악|웃음)(?:\s*[)\]])?[.!~\s]*|\s*♪+\s*)+$/, /^(?:\s*찬송가[.!~\s]*)+$/,
  /^\s*(?:한글\s*)?자막\s*제공자?[.!\s]*$/];
export const fillerOnly = text => FILLER_ONLY.test(String(text ?? '').trim());
export function voicedMs(speakers) {
  return (speakers?.speaker_turns ?? []).reduce((sum, turn) => sum + Math.max(0, turn.end_ms - turn.start_ms), 0);
}
// Cuts invented phrases out of recognized text. Text without them is returned unchanged.
export function stripInvented(text) {
  const value = String(text ?? '').trim();
  if (!HAS_INVENTED.test(value)) return value;
  return value.replace(INVENTED, ' ').replace(/\s+(?=[.,!?…~])/g, '').replace(/\s{2,}/g, ' ').trim();
}
// Whisper repeats its prompt (the agenda terms of the meeting, agenda-prompt.mjs) over noise: on 2026-11-26 '환경도시위원회,
// 계수조정' 23 times in the recess of 환경도시위원회. A text made only of two or more prompt terms is that echo. One term
// alone can be spoken ('제주특별자치도경제통상진흥원.'), so it counts only when `single` is set (in a recess).
export function promptEcho(text, prompt, single = false) {
  const terms = String(prompt ?? '').split(',').map(term => term.replace(/[\s.,·]/g, '')).filter(Boolean);
  const value = String(text ?? '').replace(/[\s.,!?…~·]/g, '');
  if (!value || !terms.length) return false;
  const count = new Array(value.length + 1).fill(-1); count[0] = 0;
  for (let i = 0; i < value.length; i++) if (count[i] >= 0)
    for (const term of terms) if (value.startsWith(term, i)) count[i + term.length] = Math.max(count[i + term.length], count[i] + 1);
  return count[value.length] >= 2 || (single && count[value.length] === 1 && value.length >= 4);
}
// Text made of invented phrases, alone or around filler words ("아멘 아멘 감사합니다."), is not speech.
export function inventedOnly(text) {
  const value = String(text ?? '').trim();
  if (INVENTED_WHOLE.some(pattern => pattern.test(value))) return true;
  if (!HAS_INVENTED.test(value)) return false;
  const rest = stripInvented(value);
  return !rest || fillerOnly(rest) || HESITATION_ONLY.test(rest) || COURTESY_LOOP.test(rest) || INVENTED_WHOLE.some(pattern => pattern.test(rest));
}
// Phrases Whisper also produces over silence or music. Short ones can be real speech, so they count as silence only
// when the speaker check found no voice, and they wait for that check before they are shown or corrected.
export function suspectText(text) {
  const value = String(text ?? '').trim();
  return Boolean(value) && (fillerOnly(value) || HESITATION_ONLY.test(value) || OUTROS.some(pattern => pattern.test(value))
    || COURTESY_LOOP.test(value) || inventedOnly(value));
}
// Missing or failed diarization is unknown. Positive speech evidence takes precedence over everything but a courtesy
// loop and invented phrases.
export function nonSpeech(text, speakers) {
  const trimmed = String(text ?? '').trim();
  if (COURTESY_LOOP.test(trimmed) || inventedOnly(trimmed)) return true;
  if (voicedMs(speakers) > 0 || speakers?.speech_activity?.state === 'speech') return false;
  if (speakers?.speech_activity?.state === 'silence') return true;
  return Boolean(suspectText(trimmed) && speakers?.speaker_state === 'unknown' && Array.isArray(speakers.speaker_turns) && speakers.speaker_turns.length === 0);
}
// 제주 4.3 is read "사삼" and written 4.3 (2026-11-11 request). Recognized "사삼" and the "4·3" spelling are shown as 4.3;
// "사삼" inside a word ("검사삼") and digits around the dot ("14·3", "4·30") stay.
const FOUR_THREE = /(?:(?<![가-힣])|(?<=제주\s*))사삼|(?<!\d)4\s*[·ㆍ・∙]\s*3(?!\d)/g;
// Public sentences lose invented phrases and write 제주 4.3 the same way everywhere.
export const publicText = text => stripInvented(text).replace(FOUR_THREE, '4.3');
// "...입니다. 감사합니다. 감사합니다. 감사합니다." keeps one closing courtesy phrase.
export const collapseRepeats = text => String(text ?? '').replace(REPEATED_RUN, '$1').trim();
// Public filter for stored rows: hides silence hallucinations that were recorded before this filter existed. The recognized
// text is checked too, so a correction written from invented phrases ("아멘 아멘" corrected to "(애국가 제창)") stays hidden.
export const publicSpeech = row => !nonSpeech(row.corrected_text ?? row.raw_text, row) && !inventedOnly(row.raw_text);
