#!/usr/bin/env node
// Q1: decode cost of one stream per codec, in the real decode wasm under Node, read exactly as the stream decoder reads
// (src/plugins/audio/runtime/decoder/streams.ts:527: readF32, 4,096 frames per call, into one scratch).
// node q1_decode.mjs [--runs 5] [--codecs id,id] [--out q1.json] [--passes N]
import { readFileSync } from 'node:fs';
import { args, opt, flag, stats, median, f, saveJson, loadEngine, ffmpegF32, DEC_WASM, DEC_AAC_WASM, CHUNK, CHUNK_MS } from './common.mjs';
import { ensureFixtures } from './fixtures.mjs';

const runs = +opt('--runs', 5);
const passes = +opt('--passes', 1); // full-file passes per run (each ~82 s of audio)
const only = opt('--codecs', '');
const E = await loadEngine();
const fixtures = ensureFixtures().filter((c) => !only || only.split(',').includes(c.id));
const wasm = { std: await E.DecoderWasm.load(readFileSync(DEC_WASM)), aac: await E.DecoderWasm.load(readFileSync(DEC_AAC_WASM)) };

function decodeAll(w, bytes, hint, kind) {
  const times = [];
  let t0 = process.hrtime.bigint();
  const h = w.open(bytes, hint);
  const info = w.info(h);
  const openUs = Number(process.hrtime.bigint() - t0) / 1000;
  const bps = kind === 'f32' ? 4 : 2;
  const scratch = w.alloc(CHUNK * info.channels * bps);
  const out = [];
  let frames = 0;
  for (;;) {
    t0 = process.hrtime.bigint();
    const n = kind === 'f32' ? w.readF32(h, scratch, CHUNK) : w.readI16(h, scratch, CHUNK);
    const dt = Number(process.hrtime.bigint() - t0) / 1000;
    if (n === 0) break;
    times.push(dt);
    if (out && frames < 60 * 48000) out.push(kind === 'f32' ? w.f32(scratch, n * info.channels).slice() : null);
    frames += n;
  }
  w.free(scratch, CHUNK * info.channels * bps);
  w.close(h);
  return { times, frames, openUs, info, pcm: kind === 'f32' ? out : null };
}

const results = [];
for (const c of fixtures) {
  const bytes = new Uint8Array(readFileSync(c.path));
  const w = c.aac ? wasm.aac : wasm.std;
  // Correctness (not load dependent): frames and error against ffmpeg's decode of the same file.
  const first = decodeAll(w.fork(), bytes, c.hint, 'f32');
  const ref = ffmpegF32(c.path);
  const got = new Float32Array(first.pcm.reduce((a, p) => a + p.length, 0));
  { let o = 0; for (const p of first.pcm) { got.set(p, o); o += p.length; } }
  const refFrames = ref.length / 2;
  const cmp = Math.min(got.length, ref.length, 2 * 48000 * 20);
  let se = 0, sr = 0, maxd = 0;
  for (let i = 0; i < cmp; i++) { const d = got[i] - ref[i]; se += d * d; sr += ref[i] * ref[i]; if (Math.abs(d) > maxd) maxd = Math.abs(d); }
  const check = { frames: first.frames, ffmpegFrames: refFrames, rate: first.info.rate, channels: first.info.channels, snrDb: 10 * Math.log10(sr / Math.max(se, 1e-30)), maxAbsDiff: maxd };
  // Timing: `runs` runs, each a fresh instance and `passes` full passes.
  const perRun = [];
  for (let r = 0; r < runs; r++) {
    const wi = w.fork();
    const times = [];
    let openUs = 0;
    for (let p = 0; p < passes; p++) { const d = decodeAll(wi, bytes, c.hint, 'f32'); for (const t of d.times) times.push(t); openUs = d.openUs; }
    const s = stats(times);
    const i16 = decodeAll(wi, bytes, c.hint, 'i16').times;
    perRun.push({ ...s, openUs, rtf: CHUNK_MS * 1000 / s.mean, i16p50: stats(i16).p50, totalMs: times.reduce((a, b) => a + b, 0) / 1000, audioS: times.length * CHUNK / 48000 });
  }
  const row = { id: c.id, bytes: c.bytes, kbps: c.bytes * 8 / 82.34 / 1000, check, runs: perRun, median: { p50: median(perRun.map((r) => r.p50)), p99: median(perRun.map((r) => r.p99)), p999: median(perRun.map((r) => r.p999)), max: Math.max(...perRun.map((r) => r.max)), mean: median(perRun.map((r) => r.mean)), rtf: median(perRun.map((r) => r.rtf)), openUs: median(perRun.map((r) => r.openUs)), i16p50: median(perRun.map((r) => r.i16p50)) } };
  results.push(row);
  console.error(`${c.id}: p50 ${f(row.median.p50)} us/chunk, rtf ${f(row.median.rtf, 0)}x, snr ${f(check.snrDb, 1)} dB, frames ${check.frames}/${refFrames}`);
}
saveJson(opt('--out', 'q1.json'), { date: new Date().toISOString(), node: process.version, runs, passes, chunkMs: CHUNK_MS, results });
console.log(`\nQ1 decode cost, one stream, 48 kHz stereo, readF32 x 4,096 frames (us per chunk; median over ${runs} runs of the per-run statistic; max = worst run). Chunk = ${CHUNK_MS.toFixed(2)} ms of audio.\n`);
console.log('| codec | kbps | p50 | p99 | p99.9 | max | mean | real-time factor (x) | % of 1 core per stream | i16 read p50 | open (us) | frames vs ffmpeg | SNR vs ffmpeg (dB) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const m = r.median;
  console.log(`| ${r.id} | ${f(r.kbps, 0)} | ${f(m.p50)} | ${f(m.p99)} | ${f(m.p999)} | ${f(m.max)} | ${f(m.mean)} | ${f(m.rtf, 0)} | ${f(100 / m.rtf, 2)} | ${f(m.i16p50)} | ${f(m.openUs, 0)} | ${r.check.frames} / ${r.check.ffmpegFrames} | ${f(r.check.snrDb, 1)} |`);
}
