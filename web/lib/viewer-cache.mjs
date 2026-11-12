import { publicUpdate } from './model.mjs';

const stores = new WeakMap();
const serialized = new WeakMap();
function state(storage) {
  if (!stores.has(storage)) stores.set(storage, { inflight: new Map(), models: new Map() });
  return stores.get(storage);
}
export function invalidateViewer(storage, path) {
  const cache = state(storage);
  cache.inflight.delete(path); cache.models.delete(path);
}
export async function readViewer(storage, path) {
  const cache = state(storage);
  if (cache.inflight.has(path)) return cache.inflight.get(path);
  const pending = Promise.resolve().then(() => storage.read(path));
  cache.inflight.set(path, pending);
  try { return await pending; }
  finally { if (cache.inflight.get(path) === pending) cache.inflight.delete(path); }
}
export function viewerModel(storage, path, stored) {
  const cache = state(storage); const entry = cache.models.get(path);
  if (stored.etag && entry?.etag === stored.etag) return entry.model;
  const model = publicUpdate(stored.value);
  if (stored.etag && JSON.stringify(model).length <= 2_000_000) {
    cache.models.delete(path);
    cache.models.set(path, { etag: stored.etag, model });
    while (cache.models.size > 16) cache.models.delete(cache.models.keys().next().value);
  }
  return model;
}
export function memoSnapshot(model, key, create) {
  if (!serialized.has(model)) serialized.set(model, new Map());
  const entries = serialized.get(model);
  if (entries.has(key)) return entries.get(key);
  const result = create();
  if (result.text.length <= 250_000) {
    entries.set(key, result);
    while (entries.size > 8) entries.delete(entries.keys().next().value);
  }
  return result;
}
