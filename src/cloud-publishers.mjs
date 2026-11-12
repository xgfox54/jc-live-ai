import { CloudPublisher } from './cloud-publisher.mjs';

export class CloudPublishers {
  constructor(context) {
    const config = context.config;
    if (!Array.isArray(config.cloudSyncFiles ?? [])) throw new Error('Invalid cloud publication targets');
    const paths = [config.cloudSyncFile, ...(config.cloudSyncFiles ?? [])].filter(Boolean);
    if (paths.length > 3 || paths.some(p => typeof p !== 'string'))
      throw new Error('Invalid cloud publication targets');
    this.publishers = [...new Set(paths)].map(cloudSyncFile => new CloudPublisher({ ...context, config: { ...config, cloudSyncFile } }));
    const endpoints = this.publishers.filter(p => p.settings).map(p => p.settings.endpoint);
    if (new Set(endpoints).size !== endpoints.length) throw new Error('Duplicate cloud publication endpoint');
  }
  view() {
    const targets = this.publishers.map(p => ({ host: p.settings ? new URL(p.settings.endpoint).host : null, ...p.view() }));
    const primary = targets.find(p => p.enabled && p.phase === 'published' && !p.blocked_reason)
      ?? targets.find(p => p.enabled) ?? targets[0] ?? { enabled: false, phase: 'disabled' };
    return { ...primary, targets };
  }
  start() { for (const publisher of this.publishers) publisher.start(); }
  async flush(options) { await Promise.allSettled(this.publishers.map(p => p.flush(options))); }
  async close() { await Promise.allSettled(this.publishers.map(p => p.close())); }
}
