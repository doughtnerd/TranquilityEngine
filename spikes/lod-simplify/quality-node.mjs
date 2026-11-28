// node quality-node.mjs [--only a,b] > quality.json
import { runQuality } from './quality.mjs';
import { loadAll } from './lib/models.mjs';
import { nodeRead } from './lib/node-read.mjs';
const i = process.argv.indexOf('--only');
const only = i >= 0 ? process.argv[i + 1].split(',') : undefined;
const models = await loadAll(nodeRead, { only });
const t0 = performance.now();
const res = await runQuality(models, { log: (s) => process.stderr.write(`[${((performance.now() - t0) / 1000).toFixed(0)}s] ${s}\n`) });
process.stdout.write(JSON.stringify(res));
