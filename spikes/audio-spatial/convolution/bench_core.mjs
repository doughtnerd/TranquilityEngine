// Shared by the Node and browser runners: drives the spike wasm's C ABI and reports
// p50 / p99 / p99.9 / max per quantum, pooled over runs.
export const QUANTUM_US = (128 / 48000) * 1e6;

export async function load(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const text = (len) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.text_ptr(), len));
  return {
    x,
    text,
    catalog: () => JSON.parse(text(x.catalog())),
    note: (h) => text(x.note(h)),
  };
}

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1;
  return sorted[i];
}

export function clockOverheadUs(now) {
  const t = [];
  for (let i = 0; i < 20000; i++) {
    const a = now();
    t.push(now() - a);
  }
  t.sort((a, b) => a - b);
  return t[t.length >> 1];
}

export function runBench(api, cat, { runs, quanta, filter, now, log = () => {} }) {
  const { x } = api;
  const rows = [];
  for (const spec of cat) {
    if (filter.length && !filter.some((f) => spec.name.includes(f))) continue;
    const pooled = [], runP999 = [], runMax = [];
    let mem = 0, note = '';
    for (let run = 0; run < runs; run++) {
      const h = x.make_case(spec.id, run);
      const n = x.samples(h, quanta);
      let sink = 0;
      for (let i = 0; i < (n < 500 ? 3 : 300); i++) { x.prepare(h); sink += x.step(h); }
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        x.prepare(h);
        const s = now();
        sink += x.step(h);
        t[i] = now() - s;
      }
      if (sink === 1.2345) log('');
      mem = x.mem_bytes(h);
      note = api.note(h);
      const sorted = Float64Array.from(t).sort();
      runP999.push(quantile(sorted, 0.999));
      runMax.push(sorted[sorted.length - 1]);
      for (const v of t) pooled.push(v);
      x.free_case(h);
    }
    pooled.sort((a, b) => a - b);
    log(`  ${spec.name.padEnd(28)} p50 ${quantile(pooled, 0.5).toFixed(1).padStart(8)} us  p99.9 ${quantile(pooled, 0.999).toFixed(1).padStart(8)}  max ${pooled[pooled.length - 1].toFixed(1).padStart(8)}`);
    rows.push({ spec, pooled, runP999, runMax, mem, note });
  }
  return rows;
}

export function tableMarkdown(rows, meta) {
  const f1 = (v) => v.toFixed(1);
  const out = [
    '| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const p = r.pooled;
    const [p50, p99, p999, max] = [quantile(p, 0.5), quantile(p, 0.99), quantile(p, 0.999), p[p.length - 1]];
    const pct = (v) => (r.spec.per_quantum ? ((v / QUANTUM_US) * 100).toFixed(2) : '-');
    out.push(`| ${r.spec.name} | ${r.spec.units} | ${p.length} | ${f1(p50)} | ${f1(p99)} | ${f1(p999)} | ${f1(max)} | ${pct(p50)} | ${pct(p999)} | ${pct(max)} | ${f1(Math.max(...r.runP999))} | ${r.mem ? Math.round(r.mem / 1024) : '-'} | ${r.note} |`);
  }
  out.push('', `(${meta.runner}: ${meta.runs} runs, >= ${meta.quanta} quanta per run; % of a ${QUANTUM_US.toFixed(1)} us quantum; samples pooled over runs; clock pair overhead ${meta.clock_overhead_us.toFixed(2)} us included)`);
  return out.join('\n');
}

export function toJson(rows, meta) {
  return JSON.stringify({
    meta: { ...meta, quantum_us: QUANTUM_US },
    cases: rows.map((r) => ({
      name: r.spec.name, group: r.spec.group, units: r.spec.units, samples: r.pooled.length,
      p50_us: quantile(r.pooled, 0.5), p99_us: quantile(r.pooled, 0.99), p999_us: quantile(r.pooled, 0.999), max_us: r.pooled[r.pooled.length - 1],
      run_p999_us: r.runP999, run_max_us: r.runMax, mem_bytes: r.mem, note: r.note,
    })),
  });
}

export function parseArgs(argv) {
  const get = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  return {
    runs: +get('--runs', 7), quanta: +get('--quanta', 4000),
    filter: get('--filter', '') ? get('--filter', '').split(',') : [],
    json: get('--json', ''), stride: +get('--stride', 24), secs: +get('--secs', 3),
    mode: argv[0] ?? 'bench',
  };
}
