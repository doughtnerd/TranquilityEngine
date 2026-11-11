// Runs the same code compiled to wasm32 in Node (V8's wasm, like the worklet) and prints ns per quantum.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const target = process.env.CARGO_TARGET_DIR || join(here, 'target');
const wasm = readFileSync(join(target, 'wasm32-unknown-unknown/release/beatcost.wasm'));
const { instance } = await WebAssembly.instantiate(wasm, {});
const run = instance.exports.run;
const quanta = +(process.argv[2] || 2_000_000), reps = +(process.argv[3] || 7);
console.log(`wasm32 in Node ${process.version}: ${quanta} quanta per rep, ${reps} reps`);
for (const force of [0, 1]) for (const n of [1, 4, 16, 64]) {
  run(n, quanta / 10, force);
  const t = []; for (let i = 0; i < reps; i++) { const s = process.hrtime.bigint(); run(n, quanta, force); t.push(Number(process.hrtime.bigint() - s) / quanta); }
  t.sort((a, b) => a - b);
  console.log(`mode=${force ? 'worst(every quantum crosses)' : 'normal(120/90 BPM)'} n=${String(n).padStart(2)}: p50 ${t[reps >> 1].toFixed(2)} ns/quantum  min ${t[0].toFixed(2)}  max ${t[reps - 1].toFixed(2)}`);
}
