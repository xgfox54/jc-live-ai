import { createHash } from 'node:crypto';
import { publicUpdate } from './model.mjs';

export function stableStringify(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function publicationContentHash(value) {
  const { published_ms, publication, sent_ms, ...content } = publicUpdate(value);
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}
