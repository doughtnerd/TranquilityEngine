// node make-readme.mjs : fills README.template.md from results.json -> README.md
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tables, load } from './tables.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = load();
let t = readFileSync(path.join(here, 'README.template.md'), 'utf8');
const m = R.meta;
const rust = R.rustCrateWasmCheck;
const simple = {
  META: `${m.cpu}, ${m.cores} cores, ${m.platform}, Node ${m.node}, ${R.speed.chromium?.env ?? 'Chromium n/a'}, load average at start ${m.loadavgAtStart.join(' / ')}`,
  DETERMINISM: R.determinism ? (R.determinism.every((d) => d.same) ? `identical for all ${R.determinism.length} models, all modes` : 'NOT identical: ' + R.determinism.filter((d) => !d.same).map((d) => d.model).join(', ')) : 'not compared',
  RUNS: String(m.runsPerTask),
  RUST_NPM_MS: rust ? `${rust.npmMedianMs} ms median (npm)` : 'n/a',
  RUST_MS: rust ? `${rust.rustMedianMs} ms median` : 'n/a',
};
t = t.replace(/\{\{T:(\w+)(?::(\w+))?\}\}/g, (_, name, arg) => tables[name](R, arg));
t = t.replace(/\{\{(\w+)\}\}/g, (_, k) => simple[k] ?? `{{${k}}}`);
writeFileSync(path.join(here, 'README.md'), t);
console.log('README.md written', t.length, 'bytes');
