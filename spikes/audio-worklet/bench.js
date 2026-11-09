// Shared by the page (main.js) and Node (bench-node.mjs): time the mixer wasm outside any audio context.
export const CASES = [
  [16, 16], [64, 64], [128, 128], [256, 256], [512, 512], [1024, 1024], [4096, 256], [4096, 512],
];

/** Raw DSP cost: ms per 128-frame quantum for each case, calling process_many inside wasm. */
export async function benchWasm(bytes, now, sampleRate = 48000) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const budget = (128 / sampleRate) * 1000;
  const rows = [];
  for (const [logical, real] of CASES) {
    x.spike_init(sampleRate);
    x.spike_set_voices(logical, real);
    x.spike_process_many(300); // warm up the JIT tiers
    const n = 2000;
    const t0 = now();
    x.spike_process_many(n);
    const ms = (now() - t0) / n;
    rows.push({ logical, real, ms: +ms.toFixed(4), budgetPct: +((ms / budget) * 100).toFixed(1) });
  }
  return { budgetMs: +budget.toFixed(3), rows };
}
