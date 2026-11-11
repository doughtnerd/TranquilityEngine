// Turns bench JSON files into grouped markdown tables, one column set per runner.
//   node tables.mjs native=results/native.json wasm=results/wasm-node.json [chromium=results/chromium-main.json]
import { readFileSync } from 'node:fs';
const runners = process.argv.slice(2).map((a) => { const [label, path] = a.split('='); return { label, d: JSON.parse(readFileSync(path, 'utf8')) }; });
const q = runners[0].d.meta.quantum_us;
const groups = { single: 'Single convolver (M1 as is)', zones: 'Several zones', blend: 'Zone blending (two convolvers, crossfaded sends)', switch: 'Zone switch: preparing an IR', event: 'Event effects (all instances per quantum)' };
const f = (v) => (v >= 1000 ? v.toFixed(0) : v.toFixed(1));
for (const [g, title] of Object.entries(groups)) {
  console.log(`\n#### ${title}\n`);
  const head = ['case', ...runners.flatMap((r) => [`${r.label} p50`, 'p99', 'p99.9', 'max', 'p99.9 %', 'max %'])];
  console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
  for (const c of runners[0].d.cases.filter((c) => c.group === g)) {
    const cells = runners.flatMap((r) => {
      const x = r.d.cases.find((y) => y.name === c.name);
      if (!x) return ['-', '-', '-', '-', '-', '-'];
      const pct = (v) => (c.name.includes('atonce') ? '-' : ((v / q) * 100).toFixed(1));
      return [f(x.p50_us), f(x.p99_us), f(x.p999_us), f(x.max_us), pct(x.p999_us), pct(x.max_us)];
    });
    console.log(`| ${c.name} | ${cells.join(' | ')} |`);
  }
}
