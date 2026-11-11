#!/usr/bin/env node
// Q4: memory per stream and decoded-clip memory. Deterministic (does not depend on machine load).
// node q4_memory.mjs
import { readFileSync } from 'node:fs';
import { f, saveJson, loadEngine, DEC_WASM, DEC_AAC_WASM, CORE_WASM, CHUNK } from './common.mjs';
import { ensureFixtures } from './fixtures.mjs';

const E = await loadEngine();
const MB = 1 << 20;
const fixtures = ensureFixtures();
const out = { decoderState: [], rings: {}, core: [], clips: {} };

// --- decoder state per open stream: wasm memory growth for M open streams of the same file, less each stream's own copy of
// the encoded file (lib.rs:270: `open` keeps the whole allocation for the stream's life) and its 4,096-frame f32 scratch
// (streams.ts: scratchBytes = chunkFrames * channels * 4).
const M = 32;
for (const c of fixtures) {
  const w = await E.DecoderWasm.load(readFileSync(c.aac ? DEC_AAC_WASM : DEC_WASM));
  const wi = w.fork();
  const bytes = new Uint8Array(readFileSync(c.path));
  const mem = () => wi.x.memory.buffer.byteLength;
  // warm: one open+read+close so allocator and tables exist
  { const h = wi.open(bytes, c.hint); const s = wi.alloc(CHUNK * 8); wi.readF32(h, s, CHUNK); wi.free(s, CHUNK * 8); wi.close(h); }
  const base = mem();
  const hs = [];
  for (let i = 0; i < M; i++) {
    const h = wi.open(bytes, c.hint); const s = wi.alloc(CHUNK * 8);
    for (let k = 0; k < 4; k++) wi.readF32(h, s, CHUNK);
    hs.push(h);
  }
  const grown = mem() - base;
  const perStream = grown / M;
  out.decoderState.push({ codec: c.id, fileBytes: c.bytes, perStreamTotal: perStream, perStreamStateEst: Math.max(0, perStream - c.bytes - CHUNK * 8), M, wasmMemMB: mem() / MB });
  for (const h of hs) wi.close(h);
}

// --- rings: constants from stream.rs (RING_FRAMES 32768, MAX_CHUNK 4096, FADE_TAIL 1536, 2 ch, f32).
const RING_STORAGE_FRAMES = 32768 + 4096 + 1536;
const RING_BYTES = RING_STORAGE_FRAMES * 2 * 4;
out.rings = { ringBytes: RING_BYTES, perPreset: { low: 4 * RING_BYTES, default: 8 * RING_BYTES, high: 16 * RING_BYTES }, chunkBufferBytes: E.STREAM_CHUNK_BUFFER_BYTES, poolMaxBuffersPerClass: 16, workerPoolMaxBytes: 16 * E.STREAM_CHUNK_BUFFER_BYTES };

// --- core memory after init per preset (all fixed regions incl. the stream rings); the delta mixed 64 -> 256 is not the rings alone.
const coreWasm = readFileSync(CORE_WASM);
for (const [name, mixed, logical, clipMB] of [['low', 64, 1024, 64], ['default', 128, 4096, 128], ['high', 256, 4096, 256]]) {
  const preset = { maxLogical: logical, maxMixed: mixed, maxBuses: 32, arenaInitialBytes: Math.min(16 * MB, clipMB * MB), clipCeilingBytes: clipMB * MB, limiterLookaheadMs: 1.5, maxBeds: name === 'low' ? 0 : name === 'default' ? 2 : 4, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 1 };
  const core = E.instantiateCore(coreWasm, preset, 48000);
  out.core.push({ preset: name, memoryAfterInitMB: core.memory.buffer.byteLength / MB, maximumMB: E.memoryMaximumPages(preset, 48000) * 65536 / MB, rings: Math.min(16, Math.max(4, Math.floor(mixed / 16))) });
}

// --- decoded clip memory for a 3-minute track, as stored in the arena: int16 default (settings.ts:237), blocks rounded up to the
// arena size class (4 per doubling from 4 KB: coreDriver.ts arenaBlockBytes = arena.rs size_class).
const SECONDS = 180;
const cases = [['stereo 48 kHz i16', 48000, 2, 2], ['stereo 44.1 kHz i16', 44100, 2, 2], ['mono 48 kHz i16', 48000, 1, 2], ['stereo 48 kHz f32 (clipFormat f32)', 48000, 2, 4]];
out.clips = cases.map(([name, rate, ch, bps]) => {
  const bytes = SECONDS * rate * ch * bps;
  const block = E.arenaBlockBytes(bytes);
  const fit = (ceilMB) => ({ byRegistry: Math.floor((ceilMB * MB) / bytes), byArenaBlocks: Math.floor((ceilMB * MB) / block) });
  return { name, bytes, blockBytes: block, waste: block / bytes - 1, low64: fit(64), high256: fit(256), default128: fit(128) };
});
saveJson('q4.json', out);

console.log('\nQ4 memory\n');
console.log(`Ring: ${RING_BYTES} B per stream (${RING_STORAGE_FRAMES} frames x 2 ch x 4 B; stream.rs RING_STORAGE_FRAMES). Region: low ${f(out.rings.perPreset.low / MB, 2)} MB, default ${f(out.rings.perPreset.default / MB, 2)} MB, high ${f(out.rings.perPreset.high / MB, 2)} MB. Worker chunk-buffer pool: up to ${out.rings.poolMaxBuffersPerClass} x ${E.STREAM_CHUNK_BUFFER_BYTES} B = ${f(out.rings.workerPoolMaxBytes / MB, 2)} MB shared (streams.ts POOL_MAX), ~8 in flight per stream.\n`);
console.log(`Decoder worker, per open stream (wasm memory growth over ${M} opens of the 82 s file; includes the stream's own copy of the encoded file):\n`);
console.log('| codec | file (MB) | total per stream (MB) | state beyond file+scratch (KB) |\n|---|---|---|---|');
for (const r of out.decoderState) console.log(`| ${r.codec} | ${f(r.fileBytes / MB, 2)} | ${f(r.perStreamTotal / MB, 2)} | ${f(r.perStreamStateEst / 1024, 0)} |`);
console.log('\nCore memory after init (every fixed region incl. rings, before any clip):\n');
console.log('| preset | rings | memory after init (MB) | memory maximum (MB) |\n|---|---|---|---|');
for (const r of out.core) console.log(`| ${r.preset} | ${r.rings} | ${f(r.memoryAfterInitMB, 1)} | ${f(r.maximumMB, 1)} |`);
console.log('\nDecoded 3-minute track in the arena:\n');
console.log('| format | bytes (MB) | arena block (MB) | waste | fit in low 64 MB (registry / blocks) | default 128 MB | high 256 MB |\n|---|---|---|---|---|---|---|');
for (const r of out.clips) console.log(`| ${r.name} | ${f(r.bytes / MB, 2)} | ${f(r.blockBytes / MB, 2)} | ${f(100 * r.waste, 0)}% | ${r.low64.byRegistry} / ${r.low64.byArenaBlocks} | ${r.default128.byRegistry} / ${r.default128.byArenaBlocks} | ${r.high256.byRegistry} / ${r.high256.byArenaBlocks} |`);
