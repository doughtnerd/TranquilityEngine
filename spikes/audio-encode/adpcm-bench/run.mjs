// ADR 0337 spike A0/S3: meters adpcm_bench.wasm with the metered gate's instrumenter (tools/audio-bench/meter.mjs:
// every wasm instruction counts 1) and prints wasm instructions per quantum for int16 vs IMA ADPCM voices.
//   node spikes/audio-encode/adpcm-bench/run.mjs <adpcm_bench.wasm>
import { readFileSync } from "node:fs";
import { meter, COUNTER_EXPORT } from "../../../tools/audio-bench/meter.mjs";

const { bytes, stats } = meter(new Uint8Array(readFileSync(process.argv[2])));
const module = await WebAssembly.compile(bytes);
const WARMUP = 400;
const QUANTA = 750; // 2 s at 48 kHz, as the gate
const MODES = ["int16", "block", "incremental", "incremental-fast"];

async function run(mode, voices, pitch, stagger) {
  const { exports: x } = await WebAssembly.instantiate(module, {});
  const count = () => x[COUNTER_EXPORT].value;
  x.bench_setup(mode, voices, pitch, stagger);
  for (let i = 0; i < WARMUP; i++) x.bench_quantum();
  const per = [];
  let probe = 0;
  for (let i = 0; i < QUANTA; i++) {
    const a = count();
    x.bench_quantum();
    per.push(Number(count() - a));
    if (i === 100) probe = x.bench_probe();
  }
  per.sort((p, q) => p - q);
  const mean = per.reduce((s, v) => s + v, 0) / per.length;
  return { mode: MODES[mode], voices, pitch, stagger: !!stagger, mean: Math.round(mean), p99: per[Math.floor(per.length * 0.99)], max: per[per.length - 1], perVoice: Math.round(mean / voices), maxPerVoice: Math.round(per[per.length - 1] / voices), probe: +probe.toFixed(3) };
}

if (process.argv[3] === "--wall") {
  // Wall time on the unmetered module (shared VM: indicative only), 256 voices at pitch 1, staggered.
  const plain = await WebAssembly.compile(readFileSync(process.argv[2]));
  for (let rep = 0; rep < 3; rep++) {
    for (const mode of [0, 1, 2, 3]) {
      const { exports: x } = await WebAssembly.instantiate(plain, {});
      x.bench_setup(mode, 256, 1, 1);
      for (let i = 0; i < 1000; i++) x.bench_quantum();
      const t0 = performance.now();
      for (let i = 0; i < 3000; i++) x.bench_quantum();
      const us = ((performance.now() - t0) * 1000) / 3000;
      console.log(JSON.stringify({ wall: true, mode: MODES[mode], voices: 256, pitch: 1, usPerQuantum: +us.toFixed(1), usPerVoice: +(us / 256).toFixed(3) }));
    }
  }
  process.exit(0);
}
console.log(JSON.stringify({ meteredFunctions: stats.functions, segments: stats.segments, warmup: WARMUP, quanta: QUANTA }));
for (const voices of [32, 128, 256]) {
  for (const pitch of [1, 1.5]) {
    const base = await run(0, voices, pitch, 1);
    console.log(JSON.stringify(base));
    for (const [mode, stagger] of [[1, 1], [1, 0], [2, 1], [2, 0], [3, 1], [3, 0]]) {
      const r = await run(mode, voices, pitch, stagger);
      r.extraPerVoiceMean = Math.round((r.mean - base.mean) / voices);
      r.extraPerVoiceMax = Math.round((r.max - base.max) / voices);
      r.ratioMean = +(r.mean / base.mean).toFixed(2);
      console.log(JSON.stringify(r));
    }
  }
}
