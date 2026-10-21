import { committees, committeeForChannel } from '../public/committees.mjs';

const normalize = value => String(value ?? '').replace(/[\s·.ㆍ]/g, '');
export function matchCommittee(record) {
  const exact = committees.find(c => normalize(c.name) === normalize(record.committee));
  if (exact) return exact;
  const matches = committees.filter(c => normalize(record.title).includes(normalize(c.name)));
  return matches.length === 1 ? matches[0] : null;
}
export function initializeCommitteeChannels(store) {
  const existing = new Map(store.streams().map(stream => [stream.stream_id, stream]));
  for (const committee of committees) {
    if (existing.has(committee.stream_id)) continue;
    const stream = { stream_id: committee.stream_id, name: committee.name, committee_id: committee.id,
      kind: 'pending', approved: false, auto_start: false, page_url: '', video_id: null };
    store.saveStream(stream); store.event('stream', stream);
  }
}
export function namedCommitteeStream(stream) {
  const committee = committeeForChannel(stream.stream_id);
  return committee ? { ...stream, name: committee.name, committee_id: committee.id } : stream;
}
