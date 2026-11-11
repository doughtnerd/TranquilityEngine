// Node runner for the wasm build. Usage:
//   node run_wasm.mjs bench [--runs 7] [--quanta 4000] [--filter a,b] [--json out.json]
//   node run_wasm.mjs check [--stride 24] [--secs 3]     (secs is a bitmask: 1 = 1 s IR, 2 = 2 s, 4 = 4 s)
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, runBench, tableMarkdown, toJson, parseArgs, clockOverheadUs } from './bench_core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const a = parseArgs(process.argv.slice(2));
const api = await load(await readFile(join(here, 'wasm/convolution_spike.wasm')));
const now = () => Number(process.hrtime.bigint()) / 1000;

if (a.mode === 'check') {
  const t = performance.now();
  const fails = api.x.run_checks(a.stride, a.secs);
  console.log(api.text(api.x.text_len()));
  console.log(`(wasm, ${((performance.now() - t) / 1000).toFixed(1)} s, ${fails} failure(s))`);
  process.exit(fails ? 1 : 0);
}
const meta = { runner: `node ${process.version} wasm (+simd128)`, runs: a.runs, quanta: a.quanta, clock_overhead_us: clockOverheadUs(now) };
console.error(`${meta.runner}, ${a.runs} runs x ${a.quanta} quanta per case, clock pair overhead ${meta.clock_overhead_us.toFixed(2)} us`);
const rows = runBench(api, api.catalog(), { runs: a.runs, quanta: a.quanta, filter: a.filter, now, log: (s) => console.error(s) });
console.log(tableMarkdown(rows, meta));
if (a.json) { await writeFile(a.json, toJson(rows, meta)); console.error(`wrote ${a.json}`); }
const sizes = [];
for (const n of ['probe_empty', 'probe_m1', 'probe_zone', 'convolution_spike']) sizes.push(`${n}.wasm ${(await stat(join(here, 'wasm', n + '.wasm'))).size} B`);
console.error('wasm sizes: ' + sizes.join(', '));
