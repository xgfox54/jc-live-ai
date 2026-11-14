const SPEAKER_COLORS = ['#005f9d', '#965100', '#006f51', '#7a2e8a', '#9b1b1b', '#1b5e72', '#6b5a00', '#3b3f8a'];
const ids = item => item.speaker_ids ?? [...new Set((item.speaker_turns ?? []).filter(turn => turn.end_ms - turn.start_ms >= 200).map(turn => turn.speaker_id))];
// Stable key for one participant within a broadcast: analysis scope plus temporary number.
export const speakerKey = item => item.speaker_key ?? (item.speaker_id ? (item.speaker_scope ?? item.session_id ?? '') + ':' + item.speaker_id : null);
export function speakerText(item, participants = {}) {
  if (item.speaker_name) return item.speaker_name;
  if (item.speaker_final) return participants[speakerKey(item)] ?? '발언자 미확인';
  if (item.speaker_id) return participants[speakerKey(item)] ?? '참여자 ' + item.speaker_id;
  switch (item.speaker_state) {
    case 'pending': return '참여자 분석 중';
    case 'unknown': return '참여자 미확인';
    case 'unavailable': return '참여자 분석 불가';
    case 'multiple': return '참여자 ' + ids(item).join('·') + ' (구간 내 교대·겹침)';
    default: return '';
  }
}
export const speakerColor = id => id ? SPEAKER_COLORS[(id - 1) % SPEAKER_COLORS.length] : null;
