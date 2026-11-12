import { assertSupportedRuntime } from './runtime.mjs';
import { BlobStore } from './blob-store.mjs';
import { syncRequest as sync, viewerRequest as view } from './http-core.mjs';
export { edgeCache } from './http-core.mjs';

const defaultStorage = new BlobStore();
export function syncRequest(request, options = {}) {
  return sync(request, { storage: defaultStorage, secret: process.env.JC_SYNC_SECRET,
    publisherId: process.env.JC_PUBLISHER_ID, ...options, runtimeCheck: assertSupportedRuntime });
}
export function viewerRequest(request, options = {}) {
  return view(request, { storage: defaultStorage, ...options, runtimeCheck: assertSupportedRuntime });
}
