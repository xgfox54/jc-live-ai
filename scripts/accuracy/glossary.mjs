// Builds speaker-name glossaries from official minutes published before each test meeting (no same-day leakage).
// Usage: node scripts/accuracy/glossary.mjs <set-dir> <speaker-labels.json> <out.json>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { speakerGlossary } from '../../src/speaker-glossary.mjs';

const [set, labelsFile, output] = process.argv.slice(2);
const meetings = JSON.parse(await readFile(labelsFile, 'utf8'));
const result = {};
for (const item of JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8'))) {
  const date = item.title.match(/\d{4}-\d{2}-\d{2}/)[0];
  result[item.fidx] = speakerGlossary(meetings.filter(meeting => meeting.date && meeting.date < date), item.title);
  console.log(item.fidx, result[item.fidx].length, result[item.fidx].slice(0, 6).join(', '));
}
await writeFile(output, JSON.stringify(result, null, 2));

