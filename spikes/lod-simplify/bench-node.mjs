// Node side of the speed benchmark: node bench-node.mjs [--runs N] [--only a,b]  (prints JSON to stdout when --json)
import { runSpeed } from './bench.mjs';
import { loadAll } from './lib/models.mjs';
import { nodeRead } from './lib/node-read.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const runs = +arg('--runs', 7);
const only = arg('--only', '') ? arg('--only').split(',') : undefined;
const models = await loadAll(nodeRead, { only });
const rows = await runSpeed(models, { runs, log: (s) => process.stderr.write(s + '\n') });
const res = { env: 'node ' + process.version, runs, rows };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(res));
else for (const r of rows) console.log(r.name.padEnd(14), String(r.tris).padStart(7), Object.entries(r.timings).map(([k, v]) => `${k} ${v.p50.toFixed(1)}`).join('  '));
