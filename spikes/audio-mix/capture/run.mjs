// Spike S3 runner: capture data rate, main-thread cost, editor-side cost.
//   node --experimental-strip-types --expose-gc spikes/audio-mix/capture/run.mjs            full: 5 runs (~3-4 min on an idle machine)
//   node --experimental-strip-types --expose-gc spikes/audio-mix/capture/run.mjs --smoke    ~15 s: 1 run, 30 s captures
// Output: tables on stdout and results.json beside this file.
import { performance, PerformanceObserver } from "node:perf_hooks";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Recorder, Reader, T, EV, writeFileHeader, readFileHeader } from "./codec.mjs";
import { SCENES, BLOCK_US, BLOCKS_PER_MIN, runScene, newBlock, wireWrite, rawBytes, RATE } from "./sim.mjs";
import { SCHEMA_HASH } from "../../../src/plugins/audio/runtime/wire.generated.ts";

const SMOKE = process.argv.includes("--smoke");
const ALLOC_CHILD = process.argv.includes("--alloc");
const RUNS = SMOKE ? 1 : 5;
const CAPTURE_S = SMOKE ? 30 : 600; // the "10-minute capture"
const SLICE_S = SMOKE ? 8 : 60; // the slice the per-op timing loops over
const RECON_N = SMOKE ? 300 : 2000;
const SCALES = [64, 256, 1024];
const fmt = (n, d = 1) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d));
const mb = (b) => (b / 1e6).toFixed(2);

function pct(arr, p) { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
const stats = (arr) => ({ p50: pct(arr, 0.5), p99: pct(arr, 0.99), p999: pct(arr, 0.999), max: pct(arr, 1), n: arr.length });

function copyBlock(b) {
  return { ...b, ended: b.ended.slice(), demoted: b.demoted.slice(), starved: b.starved.slice(), playheads: b.playheads.map((x) => ({ ...x })), clipEvents: [], streamEvents: [], peaks: b.peaks.map((x) => ({ ...x })), beds: b.beds.map((x) => ({ ...x })), zones: b.zones.map((x) => ({ ...x })), zoneEvents: [], musicRings: b.musicRings.map((x) => ({ ...x })), groupStarts: [] };
}

// ---------------------------------------------------------------- alloc probe (child process: huge semi-space so no scavenge hides the delta)
if (ALLOC_CHILD) {
  const out = {};
  for (const N of SCALES) {
    const blocks = [], raws = [];
    const evs = [];
    const sc = SCENES[N];
    const { tbl } = runScene(sc, 20, { onStatus: (t, b) => { blocks.push(copyBlock(b)); }, onEvent: (t, ty, a, b, c, d, f) => evs.push([t, ty, a, b, c, d, f]) });
    const rec = new Recorder(1 << 22);
    const M = 1000;
    const probe = (name, fn) => {
      for (let i = 0; i < 3000; i++) fn(i); // warm the JIT
      global.gc(); const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < M; i++) fn(i);
      const h1 = process.memoryUsage().heapUsed;
      (out[N] ??= {})[name] = (h1 - h0) / M;
    };
    let t = 0;
    probe("status.delta", (i) => { t += BLOCK_US; rec.status(t, blocks[i % blocks.length]); });
    const arr = new Array(64);
    probe("status.json", (i) => { arr[i & 63] = JSON.stringify(blocks[i % blocks.length]); });
    probe("event.bin", (i) => { const e = evs[i % evs.length]; t += 1; rec.event(t, e[1], e[2], e[3], e[4], e[5], e[6]); });
    probe("event.json", (i) => { const e = evs[i % evs.length]; arr[i & 63] = JSON.stringify({ t: e[0], ty: e[1], a: e[2], b: e[3], c: e[4], d: e[5], f: e[6] }); });
    probe("keyframe.bin", (i) => { t += 1e6; rec.keyframe(t, N, tbl); });
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ---------------------------------------------------------------- 1. correctness checks (load independent)
function checks() {
  const res = [];
  const ok = (name, cond, extra = "") => { res.push([name, cond, extra]); if (!cond) throw new Error("CHECK FAILED: " + name + " " + extra); };
  for (const N of [64, 1024]) {
    for (const quant of [true, false]) {
      const rec = new Recorder(1 << 24, { quantPeaks: quant });
      const orig = [], evs = [];
      let kfs = 0;
      runScene(SCENES[N], 20, {
        onStatus: (t, b) => { orig.push(copyBlock(b)); rec.status(t, b); },
        onEvent: (t, ty, a, b, c, d, f) => { rec.event(t, ty, a, b, c, d, f); evs.push([ty, a, b, c, d, f]); },
        onKeyframe: (t, n, tbl) => { rec.keyframe(t, n, tbl); kfs++; },
      });
      const rd = new Reader(rec.linearise());
      let si = 0, ei = 0, kf = 0, maxPeakErrDb = 0;
      while (rd.p < rd.b.length) {
        const r = rd.next();
        if (r.rec === "status") {
          const o = orig[si++];
          for (const k of Object.keys(o)) {
            if (k === "peaks") {
              for (let i = 0; i < o.peaks.length; i++) for (const c of ["l", "r"]) {
                const a = o.peaks[i][c], d = r.b.peaks[i][c];
                if (quant) { if (a > 1e-6) maxPeakErrDb = Math.max(maxPeakErrDb, Math.abs(20 * Math.log10(d / a))); } else ok("peak lossless", a === d);
              }
            } else if (k === "dateMs") ok("dateMs", Math.abs(o.dateMs - r.b.dateMs) < 1e-6, `${o.dateMs} ${r.b.dateMs}`);
            else ok("field " + k, JSON.stringify(o[k]) === JSON.stringify(r.b[k]), `${N} ${k}`);
          }
        } else if (r.rec === "event") {
          const e = evs[ei++];
          ok("event", e[0] === r.type && e[1] === r.a && e[2] === r.b && e[3] === r.c && e[4] === r.d && (e[5] === r.f || e[5] === 0), JSON.stringify([e, r]));
        } else kf++;
      }
      ok(`roundtrip N=${N} quant=${quant}: ${si} statuses, ${ei} events, ${kf} keyframes`, si === orig.length && ei === evs.length && kf === kfs, quant ? `max peak error ${maxPeakErrDb.toFixed(4)} dB` : "");
    }
  }
  // ring eviction: tiny ring, tail must land on a keyframe and everything after must decode
  {
    const rec = new Recorder(1 << 20);
    runScene(SCENES[1024], 30, { onStatus: (t, b) => rec.status(t, b), onEvent: (t, ty, a, b, c, d, f) => rec.event(t, ty, a, b, c, d, f), onKeyframe: (t, n, tbl) => rec.keyframe(t, n, tbl) });
    const buf = rec.linearise();
    ok("ring wrapped", rec.head > rec.cap && rec.tail > 0, `head ${rec.head} cap ${rec.cap}`);
    ok("tail on a keyframe", buf[0] === T.KF);
    const rd = new Reader(buf); let n = 0; while (rd.p < buf.length) { rd.next(); n++; }
    ok("evicted ring decodes cleanly to the end", rd.p === buf.length, `${n} records, ${(buf.length / 1024).toFixed(0)} KiB kept`);
  }
  // header: accept, refuse on hash / magic / version
  {
    const h = writeFileHeader({ sampleRate: 48000, startDateMs: 1.7e12, flags: 1, tables: { clips: ["a", "b"], buses: ["master"] } });
    const r = readFileHeader(h);
    ok("header accepted", r.ok && r.sampleRate === 48000 && r.tables.clips[1] === "b" && r.hash === SCHEMA_HASH);
    ok("header refuses another schema", !readFileHeader(h, { schemaHash: "0".repeat(32) }).ok, readFileHeader(h, { schemaHash: "0".repeat(32) }).refused);
    const bad = h.slice(); bad[0] = 0; ok("header refuses bad magic", !readFileHeader(bad).ok);
    const v2 = h.slice(); v2[8] = 2; ok("header refuses newer format", !readFileHeader(v2).ok, readFileHeader(v2).refused);
  }
  return res;
}

// ---------------------------------------------------------------- 2. sizes per scale
async function sizes(N) {
  const sc = SCENES[N];
  const recD = new Recorder(1 << 27), recL = new Recorder(1 << 27, { quantPeaks: false }), recR = new Recorder(1 << 26);
  let rawStatusBytes = 0, jsonBytes = 0, jsonN = 0, nStat = 0, jsonEv = 0, evN = 0;
  const kfJson = { bytes: 0, n: 0 };
  runScene(sc, CAPTURE_S, {
    onStatus: (t, b) => {
      const n = wireWrite(b, nStat); rawStatusBytes += n + 7; // + record framing (type, len3, dt)
      recD.status(t, b); recL.status(t, b);
      if (t < 60e6) recR.statusRaw(t, rawBytes, n);
      if (nStat % 25 === 0) { jsonBytes += JSON.stringify(b).length + 1; jsonN++; }
      nStat++;
    },
    onEvent: (t, ty, a, b, c, d, f) => {
      recD.event(t, ty, a, b, c, d, f); recL.event(t, ty, a, b, c, d, f); if (t < 60e6) recR.event(t, ty, a, b, c, d, f);
      if (evN++ % 10 === 0) { jsonEv += JSON.stringify({ t, ty, a, b, c, d, f }).length + 1; }
    },
    onKeyframe: (t, n, tbl) => {
      recD.keyframe(t, n, tbl); recL.keyframe(t, n, tbl); if (t < 60e6) recR.keyframe(t, n, tbl);
      if (kfJson.n++ % 10 === 0) { const rows = []; for (let i = 0; i < n; i++) rows.push({ id: tbl.id[i], clip: tbl.clip[i], bus: tbl.bus[i], state: tbl.state[i], prio: tbl.prio[i], gain: tbl.gain[i], pitch: tbl.pitch[i], aud: tbl.aud[i], playhead: tbl.playhead[i] }); kfJson.bytes += JSON.stringify(rows).length; }
    },
  });
  const min = CAPTURE_S / 60;
  const jsonStatusPerMin = (jsonBytes / jsonN) * BLOCKS_PER_MIN;
  const jsonEvPerMin = (jsonEv * 10) / min;
  const jsonKfPerMin = (kfJson.bytes / Math.ceil(kfJson.n / 10)) * 60;
  const evPerMin = recD.stats.ev / min, kfPerMin = recD.stats.kf / min;
  const out = {
    N, minutes: min,
    perMin: {
      statusRaw: rawStatusBytes / min, statusDelta: recD.stats.status / min, statusDeltaLossless: recL.stats.status / min, statusJson: jsonStatusPerMin,
      events: evPerMin, keyframes: kfPerMin, eventsJson: jsonEvPerMin, keyframesJson: jsonKfPerMin,
    },
    eventsPerSec: evN / CAPTURE_S, bytesPerStatusRaw: rawStatusBytes / nStat, bytesPerStatusDelta: recD.stats.status / nStat,
  };
  out.perMin.totalRaw = out.perMin.statusRaw + evPerMin + kfPerMin;
  out.perMin.totalDelta = recD.head / min;
  out.perMin.totalDeltaLossless = recL.head / min;
  out.perMin.totalJson = jsonStatusPerMin + jsonEvPerMin + jsonKfPerMin;
  // Compression over a one-minute window (a raw minute is ~10 MB at 1,024 voices) and over the full capture for the delta stream.
  const minute = (rec) => { const full = rec.linearise(); const idx = new Reader(full).scanIndex(); const cut = idx.kfT.findIndex((t) => t >= 60e6); return cut < 0 ? full : full.subarray(0, idx.kfOff[cut]); };
  const winR = recR.linearise(), winD = minute(recD), winL = minute(recL);
  const comp = {};
  const timed = (fn) => { const t0 = performance.now(); const r = fn(); return [r.length, performance.now() - t0]; };
  for (const [name, buf] of [["raw", winR], ["delta", winD], ["deltaLossless", winL]]) {
    const [g, gt] = timed(() => zlib.gzipSync(buf)); const [d, dt] = timed(() => zlib.deflateRawSync(buf));
    // 10-second chunks, each independently deflate-raw (a streamable recorder: each chunk decodable alone, ring-friendly)
    let chunked = 0; const cs = Math.ceil(buf.length / 6); for (let o = 0; o < buf.length; o += cs) chunked += zlib.deflateRawSync(buf.subarray(o, o + cs)).length;
    comp[name] = { window: buf.length, gzip: g, deflateRaw: d, chunked10s: chunked, gzipMs: gt, deflateMs: dt };
  }
  // CompressionStream (browser API) must agree with zlib (same deflate); check once.
  const cs = new Blob([winD]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const csBytes = new Uint8Array(await new Response(cs).arrayBuffer());
  comp.compressionStreamDeflateRawDelta = csBytes.length;
  out.comp = comp;
  const full = recD.linearise();
  const gzFull = zlib.gzipSync(full);
  out.capture10 = { raw: full.length, gzip: gzFull.length };
  out._full = full; out._gz = gzFull;
  return out;
}

// ---------------------------------------------------------------- 3. per-op timing
async function opTimings(N) {
  const sc = SCENES[N];
  const blocks = [], raws = [], evs = [];
  const { tbl } = runScene(sc, SLICE_S, {
    onStatus: (t, b) => { blocks.push(copyBlock(b)); const n = wireWrite(b, 0); raws.push(rawBytes.slice(0, n)); },
    onEvent: (t, ty, a, b, c, d, f) => evs.push([t, ty, a, b, c, d, f]),
  });
  const rows = []; for (let i = 0; i < N; i++) rows.push({ id: tbl.id[i], clip: tbl.clip[i], bus: tbl.bus[i], state: tbl.state[i], prio: tbl.prio[i], gain: tbl.gain[i], pitch: tbl.pitch[i], aud: tbl.aud[i], playhead: tbl.playhead[i] });
  const gc = { count: 0, ms: 0 };
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { gc.count++; gc.ms += e.duration; } });
  obs.observe({ entryTypes: ["gc"] });
  const out = {};
  const run = async (name, count, fn) => {
    const samples = new Float64Array(count);
    for (let i = 0; i < Math.min(count, 300); i++) fn(i); // warm up
    await new Promise((r) => setImmediate(r)); gc.count = 0; gc.ms = 0;
    for (let i = 0; i < count; i++) { const t0 = performance.now(); fn(i); samples[i] = (performance.now() - t0) * 1000; }
    await new Promise((r) => setTimeout(r, 5));
    out[name] = { ...stats(samples), gcCount: gc.count, gcMs: gc.ms };
  };
  const nB = blocks.length * 2;
  const rec = new Recorder(1 << 20); // 1 MiB ring: small enough that eviction runs inside the timed loops at 1,024 voices
  let t = 0;
  await run("timer overhead", 20000, () => {});
  await run("STATUS raw copy", nB, (i) => { t += BLOCK_US; rec.statusRaw(t, raws[i % raws.length], raws[i % raws.length].length); });
  await run("STATUS delta (binary, q peaks)", nB, (i) => { t += BLOCK_US; rec.status(t, blocks[i % blocks.length]); });
  const recL = new Recorder(1 << 20, { quantPeaks: false });
  await run("STATUS delta (binary, lossless)", nB, (i) => { t += BLOCK_US; recL.status(t, blocks[i % blocks.length]); });
  const ring = new Array(256);
  await run("STATUS JSON.stringify", nB, (i) => { ring[i & 255] = JSON.stringify(blocks[i % blocks.length]); });
  const nE = Math.min(evs.length, 20000);
  const recE = new Recorder(1 << 20);
  await run("event binary", nE * 2, (i) => { const e = evs[i % nE]; t += 1; recE.event(t, e[1], e[2], e[3], e[4], e[5], e[6]); });
  await run("event JSON", nE * 2, (i) => { const e = evs[i % nE]; ring[i & 255] = JSON.stringify({ t: e[0], ty: e[1], a: e[2], b: e[3], c: e[4], d: e[5], f: e[6] }); });
  const recK = new Recorder(1 << 21);
  const nK = N >= 1024 ? 300 : 1000;
  await run("keyframe binary", nK, () => { t += 1e6; recK.keyframe(t, N, tbl); });
  await run("keyframe JSON", nK, (i) => { ring[i & 255] = JSON.stringify(rows); });
  obs.disconnect();
  return out;
}

// ---------------------------------------------------------------- 4. editor side
function editorCosts(sz) {
  const full = sz._full, gz = sz._gz;
  const out = {};
  let t0 = performance.now(); const un = zlib.gunzipSync(gz); out.gunzipMs = performance.now() - t0;
  if (un.length !== full.length) throw new Error("gunzip mismatch");
  t0 = performance.now(); const idx = new Reader(full).scanIndex(); out.scanIndexMs = performance.now() - t0; out.keyframes = idx.kfOff.length;
  // full decode with an overview pass (per second: min/max live voices, work units, peak of bus 0)
  t0 = performance.now();
  const rd = new Reader(full); let sCount = 0, evCount = 0; const ov = new Float32Array(Math.ceil(CAPTURE_S) + 2 * 4);
  while (rd.p < full.length) { const r = rd.next(); if (r.rec === "status") { sCount++; const s = Math.floor(r.t / 1e6); ov[s] = Math.max(ov[s], r.b.workUnits); } else if (r.rec === "event") evCount++; }
  out.fullDecodeMs = performance.now() - t0; out.statusBlocks = sCount; out.events = evCount;
  // random-time reconstruction: nearest keyframe at or before t, then replay statuses and events up to t
  const rnd = (() => { let s = 12345; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
  const durUs = CAPTURE_S * 1e6 - 2e6;
  const samples = new Float64Array(RECON_N);
  let sink = 0;
  for (let k = -20; k < RECON_N; k++) {
    const t = 1e6 + rnd() * durUs;
    const a = performance.now();
    let lo = 0, hi = idx.kfOff.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.kfT[mid] <= t) lo = mid; else hi = mid - 1; }
    const r2 = new Reader(full); r2.p = idx.kfOff[lo]; r2.t = lo === 0 ? idx.kfT[0] : idx.kfT[lo];
    // the keyframe's own dt is relative to the previous record; rebase: start the clock at the keyframe time minus its dt
    const first = r2.next(); r2.t = first.t;
    const table = new Map(); for (const row of first.rows) table.set(row.id, row);
    let last = null;
    while (r2.p < full.length) {
      const rec = r2.next();
      if (rec.t > t) break;
      if (rec.rec === "event") { if (rec.type === EV.VOICE_START) table.set(rec.a, { id: rec.a, clip: rec.b, bus: rec.c, state: 0 }); else if (rec.type === EV.VOICE_STOP || rec.type === EV.VOICE_STEAL) table.delete(rec.a); else if (rec.type === EV.VOICE_VIRT) { const v = table.get(rec.a); if (v) v.state = 1; } }
      else if (rec.rec === "status") last = rec.b;
      else if (rec.rec === "kf") break;
    }
    sink += table.size + (last ? last.workUnits : 0);
    if (k >= 0) samples[k] = (performance.now() - a) * 1000;
  }
  out.reconstructUs = stats(samples); out.sink = sink;
  return out;
}

// ---------------------------------------------------------------- main
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length / 2) | 0]; };
async function main() {
  const t00 = performance.now();
  console.log(`S3 capture spike. node ${process.version}, ${SMOKE ? "SMOKE" : "FULL"}: ${RUNS} run(s), capture ${CAPTURE_S}s, op slice ${SLICE_S}s`);
  const chk = checks();
  console.log(`checks: ${chk.length} passed`); for (const [n, , x] of chk) if (/roundtrip|ring|evicted|refuses/.test(n)) console.log("  ok:", n, x);
  const results = { smoke: SMOKE, node: process.version, wireSchemaHash: SCHEMA_HASH, sizes: {}, ops: {}, editor: {}, alloc: null };
  for (const N of SCALES) { const s = await sizes(N); results.sizes[N] = s; }
  for (const N of SCALES) {
    results.ops[N] = []; results.editor[N] = [];
    for (let r = 0; r < RUNS; r++) {
      results.ops[N].push(await opTimings(N));
      results.editor[N].push(editorCosts(results.sizes[N]));
      console.log(`  run ${r + 1}/${RUNS} N=${N} done (${((performance.now() - t00) / 1000).toFixed(0)} s)`);
    }
  }
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--expose-gc", "--max-semi-space-size=256", process.argv[1], "--alloc"], { encoding: "utf8", maxBuffer: 1 << 26 });
  try { results.alloc = JSON.parse(child.stdout); } catch { console.log("alloc probe failed", child.stderr.slice(0, 400)); }
  for (const N of SCALES) { delete results.sizes[N]._full; delete results.sizes[N]._gz; }

  // ---- tables
  console.log("\n== DATA RATE (per minute of capture; 10 min capture, compression on a 60 s window) ==");
  console.log("voices | STATUS raw | STATUS delta(q) | events | keyframes(1/s) | TOTAL raw | TOTAL delta | delta lossless | JSON total | events/s");
  for (const N of SCALES) { const p = results.sizes[N].perMin; console.log(`${String(N).padStart(6)} | ${mb(p.statusRaw)} MB | ${mb(p.statusDelta)} MB | ${mb(p.events)} MB | ${mb(p.keyframes)} MB | ${mb(p.totalRaw)} MB | ${mb(p.totalDelta)} MB | ${mb(p.totalDeltaLossless)} MB | ${mb(p.totalJson)} MB | ${fmt(results.sizes[N].eventsPerSec)}`); }
  console.log("\nCompressed per minute (60 s window): raw stream | delta(q) | delta lossless  [gzip / deflate-raw / 10s chunks of deflate-raw]");
  for (const N of SCALES) { const c = results.sizes[N].comp; const f = (x) => `${mb(x.gzip)}/${mb(x.deflateRaw)}/${mb(x.chunked10s)} MB`; console.log(`${String(N).padStart(6)} | ${f(c.raw)} | ${f(c.delta)} | ${f(c.deltaLossless)} | CompressionStream==zlib: ${c.compressionStreamDeflateRawDelta} vs ${c.delta.deflateRaw}`); }
  console.log("\n10-minute capture in memory / gzip'd:"); for (const N of SCALES) { const c = results.sizes[N].capture10; console.log(`${String(N).padStart(6)} | ${mb(c.raw)} MB | ${mb(c.gzip)} MB  (bytes per STATUS: raw ${fmt(results.sizes[N].bytesPerStatusRaw)}, delta ${fmt(results.sizes[N].bytesPerStatusDelta)})`); }
  console.log("\n== COST per operation, us (median over runs of p50 / p99 / p99.9 / max); GC events per loop ==");
  for (const N of SCALES) {
    console.log(`-- ${N} voices`);
    for (const name of Object.keys(results.ops[N][0])) {
      const g = (k) => med(results.ops[N].map((o) => o[name][k]));
      console.log(`  ${name.padEnd(34)} p50 ${fmt(g("p50"), 2)}  p99 ${fmt(g("p99"), 2)}  p99.9 ${fmt(g("p999"), 2)}  max ${fmt(g("max"), 1)}   gc ${fmt(g("gcCount"), 0)} (${fmt(g("gcMs"), 1)} ms)`);
    }
  }
  if (results.alloc) { console.log("\nAllocation, bytes per op (heapUsed delta, semi-space 256 MB so no scavenge hides it):"); for (const N of SCALES) console.log(`  ${N}: ` + Object.entries(results.alloc[N]).map(([k, v]) => `${k} ${fmt(v, 0)}`).join(", ")); }
  console.log("\n== EDITOR SIDE (10 min capture; median over runs) ==");
  for (const N of SCALES) {
    const g = (k) => med(results.editor[N].map((o) => o[k]));
    const rc = (k) => med(results.editor[N].map((o) => o.reconstructUs[k]));
    console.log(`${String(N).padStart(5)} voices: gunzip ${fmt(g("gunzipMs"))} ms | header-scan index ${fmt(g("scanIndexMs"), 2)} ms (${results.editor[N][0].keyframes} keyframes) | full decode+overview ${fmt(g("fullDecodeMs"), 0)} ms (${results.editor[N][0].statusBlocks} blocks) | reconstruct at random t: p50 ${fmt(rc("p50"))} us, p99 ${fmt(rc("p99"))} us, max ${fmt(rc("max"))} us`);
  }
  writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 1));
  console.log(`\ntotal ${((performance.now() - t00) / 1000).toFixed(0)} s; wrote results.json`);
}
main();
