import data from './glossary-packs.json' with { type: 'json' };
import { HttpError } from './validate.mjs';

export const glossaryCatalog = data;
export function chooseGlossary(value) {
  const text = value.replace(/감사(?:합니다|드립니다|드리|하고|하겠|해요|해)/g, ' ').replace(/제주특별자치도의회|제주특별자치도/g, '').replace(/\s+/g, '');
  const ranked = data.packs.filter(pack => !['council', 'jeju'].includes(pack.id)).map(pack => {
    const hits = pack.selectionTerms.filter(term => term.length >= 2 && text.includes(term.replace(/\s+/g, '')));
    return { id: pack.id, hits: hits.length, score: hits.reduce((sum, term) => sum + Math.min(term.length, 6), 0) };
  }).filter(pack => pack.hits >= 2).sort((a, b) => b.score - a.score);
  return ranked.filter(pack => pack.score >= ranked[0].score * .5).slice(0, 2).map(pack => pack.id);
}
export function glossaryText(packIds, custom) {
  if (!Array.isArray(packIds) || packIds.length > 11 || new Set(packIds).size !== packIds.length
    || packIds.some(id => !data.packs.some(pack => pack.id === id))
    || typeof custom !== 'string' || custom.length > 3000)
    throw new HttpError(400, '단어장 분야와 참고어를 확인해 주세요.');
  const packs = packIds.map(id => data.packs.find(pack => pack.id === id));
  // Put custom words and each field's anchors before expansion vocabulary.
  const terms = [...new Set([...custom.split(/[,\n]/), ...packs.flatMap(pack => pack.selectionTerms),
    ...packs.flatMap(pack => pack.terms)].map(word => word.trim()).filter(Boolean))];
  const kept = []; let size = 0;
  for (const term of terms) {
    const next = size + term.length + (kept.length ? 2 : 0);
    if (next > 3000) break;
    kept.push(term); size = next;
  }
  return { text: kept.join(', '), omitted: terms.length - kept.length, count: kept.length };
}
