// Whisper's initial prompt biases spelling toward committee names and the official minutes style.
export function recognitionPrompt({ committee, previous = '', glossary = true, speakers = [] }) {
  const members = committee ? committee.members.map(member => member.name + ' 위원') : [];
  const names = glossary && (committee || speakers.length)
    ? (committee ? committee.name + ' 회의. ' : '') + [...new Set([...speakers, ...members])].join(', ').slice(0, 330) + '. ' : '';
  return (names + previous.slice(-120)).slice(-500);
}
