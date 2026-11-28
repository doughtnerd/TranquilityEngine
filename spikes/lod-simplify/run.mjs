#!/usr/bin/env node
// Mesh LOD simplification spike: ONE COMMAND  ->  node spikes/lod-simplify/run.mjs   (run from anywhere)
//
// EXPECTED DURATION: about 2.5 minutes on a 4-core machine (measured 2 min on a loaded one; Node speed ~0.5 min, Chromium speed ~0.5 min, quality/size/skin
// experiments ~1.2 min, distribution check ~5 s). Flags: --runs N (timing runs per task, default 7, min 5), --skip-quality (speed only, ~1.3 min),
// --skip-chromium. Needs: node 22, spikes/lod-simplify/node_modules (npm ci inside this folder), the downloaded models (fetched automatically
// with fetch-models.sh into $LOD_MODELS, default /tmp/claude-0/lod-models), Playwright + its Chromium for the browser run.
//
// Writes results.json next to this file and prints the summary tables. Timings are wall-clock ms; p50/p99/max over --runs runs after 1 warm-up.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const runs = Math.max(5, +arg('--runs', 7));
const started = Date.now();
const log = (s) => console.error(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${s}`);
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: here, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });

if (!existsSync(path.join(process.env.LOD_MODELS || '/tmp/claude-0/lod-models', 'Sponza.bin'))) { log('fetching models'); sh('sh', ['fetch-models.sh']); }
if (!existsSync(path.join(here, 'node_modules', 'meshoptimizer'))) { log('npm ci'); sh('npm', ['ci']); }

const load = os.loadavg();
const meta = {
  date: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
  loadavgAtStart: load.map((x) => +x.toFixed(2)), runsPerTask: runs,
  note: 'loadavg well above ~0.5 at start means the machine was not idle; timings are then a smoke test only',
};

log('distribution (sizes, Node 22 + Chromium smoke)');
const distribution = JSON.parse(sh('node', ['distribution.mjs']));
let rust = null;
if (existsSync('/tmp/claude-0/cargo-target/wasm32-unknown-unknown/release/mw.wasm')) { try { rust = JSON.parse(sh('node', ['rust-wasm/check.mjs']).trim().split('\n').pop()); } catch (e) { rust = { error: String(e.message).slice(0, 200) }; } }

log('speed: Node');
const speedNode = JSON.parse(sh('node', ['bench-node.mjs', '--runs', String(runs), '--json']));
let speedChromium = null;
if (!process.argv.includes('--skip-chromium')) {
  log('speed: Chromium');
  try { speedChromium = JSON.parse(sh('node', ['bench-chromium.mjs', '--runs', String(runs), '--json'])); } catch (e) { speedChromium = { error: String(e.message).slice(0, 300) }; }
}
let quality = null;
if (!process.argv.includes('--skip-quality')) { log('quality / size / skinning (long)'); quality = JSON.parse(sh('node', ['quality-node.mjs'])); }

const determinism = speedChromium && !speedChromium.error ? speedNode.rows.map((a, i) => ({ model: a.name, same: JSON.stringify(a.hash) === JSON.stringify(speedChromium.rows[i].hash) })) : null;
const results = { meta, determinism, distribution, rustCrateWasmCheck: rust, speed: { node: speedNode, chromium: speedChromium }, quality, elapsedSec: Math.round((Date.now() - started) / 1000) };
writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 1));

// ---- summary ----
const f = (x, d = 1) => (x === undefined || x === null ? '-' : x.toFixed(d));
for (const [label, sp] of [['Node', speedNode], ['Chromium', speedChromium]]) {
  if (!sp || sp.error) { console.log(`\n${label}: ${sp ? sp.error : 'skipped'}`); continue; }
  console.log(`\n${label} (${sp.env}); ms p50 / p99 / max over ${sp.runs} runs; tri/s = LOD0 tris / p50`);
  console.log('model'.padEnd(14) + 'tris'.padStart(8) + '  chain3(attr)'.padEnd(26) + 'chain3(pos)'.padEnd(26) + 'sloppy 5%,2%'.padEnd(24) + 'optimise'.padEnd(24) + 'whole pipeline'.padEnd(26) + 'kTri/s(attr)');
  for (const r of sp.rows) {
    const c = (t) => `${f(r.timings[t].p50)} / ${f(r.timings[t].p99)} / ${f(r.timings[t].max)}`.padEnd(24);
    console.log(r.name.padEnd(14) + String(r.tris).padStart(8) + '  ' + c('chainAttr') + '  ' + c('chainPos') + '  ' + c('sloppy') + c('optimize') + c('total') + f(r.timings.chainAttr.trisPerSec / 1000, 0));
  }
}
if (determinism) console.log(`\nNode vs Chromium output identical (index buffers of all levels): ${determinism.every((d) => d.same) ? 'YES for all models' : 'NO: ' + determinism.filter((d) => !d.same).map((d) => d.model)}`);
console.log(`\nresults.json written (${results.elapsedSec}s). npm meshoptimizer ${distribution.npm.version} (${distribution.npm.license}); simplifier min+gzip ${distribution.modules[0].minGzip} B`);
