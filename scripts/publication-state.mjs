import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicationControl, validatePublicationSettings } from '../src/publication-control.mjs';

export function publicationState(db, settings, { resume = false, reviewPeriod = false } = {}) {
  const key = createHash('sha256').update(settings.endpoint).digest('hex');
  const row = db.prepare('SELECT document FROM cloud_control WHERE endpoint=?').get(key);
  if (!row) throw new Error('Publication control has not been initialized');
  if (resume || reviewPeriod) {
    const store = { db, transaction(action) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } };
    const control = new PublicationControl(store, key, validatePublicationSettings(settings), Date.now);
    if (reviewPeriod) control.reviewBudgetPeriod();
    if (resume) control.resume();
  }
  const state = JSON.parse(db.prepare('SELECT document FROM cloud_control WHERE endpoint=?').get(key).document);
  return { publisher_id: state.publisher_id, sequence: state.sequence,
    blocked_reason: state.blocked ?? (settings.budget && settings.budget.period_id !== state.budget_period ? 'budget_period_review' : null),
    budget_period: state.budget_period, budget_attempts: state.budget_attempts, metrics: state.metrics,
    queued: db.prepare('SELECT count(*) AS n FROM cloud_outbox WHERE endpoint=?').get(key).n };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let db;
  try {
    const args = process.argv.slice(2); const option = flag => args[args.indexOf(flag) + 1];
    if (!args.includes('--db') || !args.includes('--settings')) throw new Error('Required arguments missing');
    const path = resolve(option('--db')); if (!existsSync(path)) throw new Error('Database does not exist');
    const settings = validatePublicationSettings(JSON.parse(readFileSync(resolve(option('--settings')), 'utf8')));
    const resume = args.includes('--resume'); const reviewPeriod = args.includes('--review-budget-period');
    db = new DatabaseSync(path, { readOnly: !resume && !reviewPeriod });
    console.log(JSON.stringify(publicationState(db, settings, { resume, reviewPeriod }), null, 2));
  } catch { console.error('Publication state command failed. Check arguments, initialized database and verified budget settings.'); process.exitCode = 1; }
  finally { db?.close(); }
}
