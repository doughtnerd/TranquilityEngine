#!/usr/bin/env node
// One command for every runner:
//   node run.mjs [--runs 5] [--quanta 2000] [--warm 300] [--cases a,b] [--targets native,node,chromium] [--no-build]
// Builds the crate (native and wasm32 with +simd128), runs the cases natively, in Node wasm and in
// Chromium inside an AudioWorklet, writes results/results.json and results/results.md.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromium } from './worklet/chromium.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runs = +opt('--runs', 5), quanta = +opt('--quanta', 2000), warm = +opt('--warm', 300);
const only = opt('--cases', '');
const targets = opt('--targets', 'native,node,chromium').split(',');
const QUANTUM_US = 128 / 48000 * 1e6;
const HRIR = join(here, '../../../src/plugins/audio/runtime/wasm/myco_hrir.bin');
const WASM = join(here, 'target/wasm32-unknown-unknown/release/bedspike.wasm');

function sh(cmd, a, env = {}) {
  const r = spawnSync(cmd, a, { cwd: here, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed`);
  return r.stdout.toString();
}

if (!args.includes('--no-build')) {
  sh('cargo', ['build', '--release', '--offline', '--bins']);
  sh('cargo', ['build', '--release', '--offline', '--target', 'wasm32-unknown-unknown', '--lib'], { RUSTFLAGS: '-C target-feature=+simd128' });
}
let wasmBytes = readFileSync(WASM);
const wasmOpt = spawnSync('wasm-opt', ['--version']).status === 0;
if (wasmOpt) { sh('wasm-opt', ['-O', WASM, '-o', WASM + '.opt']); wasmBytes = readFileSync(WASM + '.opt'); }

const pct = (s, p) => s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
function stats(times) {
  const s = Float64Array.from(times).sort();
  return { p50: pct(s, 0.5), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

async function nodeWasm(names) {
  const hrir = readFileSync(HRIR);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const x = instance.exports;
  const p = x.alloc(hrir.length);
  new Uint8Array(x.memory.buffer, p, hrir.length).set(hrir);
  const t0 = performance.now();
  x.init_shared(p, hrir.length);
  const initMs = performance.now() - t0;
  const oh = []; for (let i = 0; i < 20000; i++) { const a = performance.now(); oh.push(performance.now() - a); }
  oh.sort((a, b) => a - b);
  const out = { target: 'node-wasm', node: process.version, timer_overhead_us_p50: oh[oh.length / 2 | 0] * 1000, init_shared_ms: initMs, cases: {} };
  let sink = 0;
  for (const name of names) {
    const id = names0.indexOf(name);
    if (x.case_init(id) !== 0) throw new Error('case ' + name);
    const res = [];
    for (let r = 0; r < runs; r++) {
      x.case_reset();
      for (let i = 0; i < warm; i++) sink += x.case_quantum();
      const t = new Float64Array(quanta);
      for (let i = 0; i < quanta; i++) { const a = performance.now(); sink += x.case_quantum(); t[i] = (performance.now() - a) * 1000; }
      res.push(stats(t));
    }
    x.case_reset();
    let cs = 0; for (let i = 0; i < 50; i++) cs += x.case_quantum();
    res.push({ checksum50: cs });
    out.cases[name] = res;
    console.error(`node-wasm ${name}: p50 ${res[0].p50.toFixed(1)} us`);
  }
  out.sink = sink;
  return out;
}

// Case names come from the native binary's list (single source of truth: cases.rs NAMES).
const names0 = ['bed64', 'bed256', 'bed1024', 'bed256_spk', 'decode_sh', 'decode_spk', 'clip_foa_rot', 'clip_foa_dec', 'clip_o3_rot', 'clip_o3_dec', 'dop256_const', 'dop256_pitch', 'dop256_full', 'hrtf16', 'bed16', 'xfade16'];
const names = only ? only.split(',') : names0;
const results = { date: new Date().toISOString(), runs, quanta, warm, quantum_us: QUANTUM_US, wasm_bytes: statSync(WASM).size, wasm_opt: wasmOpt, wasm_bytes_used: wasmBytes.length, targets: {} };

if (targets.includes('native')) {
  const out = sh('./target/release/bench', ['--runs', runs, '--quanta', quanta, '--warm', warm, '--cases', names.join(',')].map(String));
  results.targets.native = JSON.parse(out);
}
if (targets.includes('node')) results.targets.node = await nodeWasm(names);
if (targets.includes('chromium')) {
  try { results.targets.chromium = await runChromium({ wasmBytes, hrir: readFileSync(HRIR), names, names0, runs, quanta, warm }); }
  catch (e) { console.error('chromium failed:', e.stack); results.targets.chromium = { error: e.message }; }
}

mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results/results.json'), JSON.stringify(results, null, 1));

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
let md = `Runs: ${runs} x ${quanta} quanta (+${warm} warm-up each). Per metric: median over runs of the per-run p50/p99/p99.9; max = worst run. Quantum = ${QUANTUM_US.toFixed(1)} us. Cells: us (% of quantum).\n\n`;
for (const [tname, t] of Object.entries(results.targets)) {
  if (!t.cases) continue;
  md += `### ${t.target || tname}${t.timer_overhead_us_p50 !== undefined ? ` (timer overhead p50 ${t.timer_overhead_us_p50.toFixed(2)} us per timed call)` : ''}${t.note ? ' - ' + t.note : ''}\n\n| case | p50 | p99 | p99.9 | max |\n|---|---|---|---|---|\n`;
  for (const n of names) {
    const rs = (t.cases[n] || []).filter((r) => r.p50 !== undefined);
    if (!rs.length) continue;
    const f = (v) => `${v.toFixed(v < 10 ? 2 : 1)} (${(100 * v / QUANTUM_US).toFixed(2)}%)`;
    md += `| ${n} | ${f(med(rs.map((r) => r.p50)))} | ${f(med(rs.map((r) => r.p99)))} | ${f(med(rs.map((r) => r.p999)))} | ${f(Math.max(...rs.map((r) => r.max)))} |\n`;
  }
  md += '\n';
}
// native vs wasm checksum
const cs = (t, n) => t?.cases?.[n]?.find((r) => r.checksum50 !== undefined)?.checksum50;
md += '### Checksums after 50 quanta (native / node wasm / chromium)\n\n';
for (const n of names) md += `- ${n}: ${[results.targets.native, results.targets.node, results.targets.chromium].map((t) => cs(t, n)?.toFixed?.(6) ?? '-').join(' / ')}\n`;
writeFileSync(join(here, 'results/results.md'), md);
console.log(md);
