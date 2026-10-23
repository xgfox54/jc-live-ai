// Rescores saved recognition or correction results after a metric change.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cer, referenceText } from './metrics.mjs';

const [set, ...files] = process.argv.slice(2);
const manifest = new Map(JSON.parse(await readFile(join(set, 'manifest.json'), 'utf8')).map(item => [item.fidx, item]));
for (const file of files) {
  const data = JSON.parse(await readFile(file, 'utf8')); let errors = 0; let chars = 0;
  data.results = data.results.map(result => {
    const score = cer(referenceText(manifest.get(result.fidx).minutes), result.corrected ?? result.hypothesis);
    errors += score.substitutions + score.insertions + score.deletions; chars += score.reference_chars - score.excluded_deletions;
    return { ...result, ...score };
  });
  data.summary.accuracy = 1 - errors / chars; data.summary.rescored = true;
  await writeFile(file, JSON.stringify(data, null, 2));
  console.log(file.split(/[\\/]/).at(-1), data.summary.accuracy.toFixed(4), data.results.length);
}
