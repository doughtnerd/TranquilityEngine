#!/usr/bin/env node
// Q2: N concurrent streams in ONE decoder worker, scheduled as the real worker schedules them. The worker side is the
// engine's own handler/StreamDecoder (in a worker thread, as in the browser); the worklet side is a faithful simulation
// of CoreDriver + the core's stream rings, driven by the wall clock:
//   - STREAM_OPEN/CHUNK parsed with the wire readers; chunk buffers kept and handed back with the next credit
//     (coreDriver.ts:794-851); credit every 4,096 consumed frames (credit.ts:16);
//   - ring states WAITING -> PLAYING at START_FRAMES = 4,096 buffered (stream.rs:24-27); a PLAYING voice needs the
//     quantum plus a 5 ms fade (128 + 240 frames) ahead, else it starves (stream.rs header "STARVING"); a STARVED voice
//     resumes at 4,096 buffered.
// node q2_concurrency.mjs [--runs 5] [--seconds 15] [--codecs mp3-cbr192,vorbis-q5,flac] [--ns 4,8,16,24,32,48,64] [--ns2 4,16,32,64] [--clip]
import { Worker, MessageChannel } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { here, opt, flag, stats, median, f, saveJson, loadEngine, DEC_WASM, DEC_AAC_WASM, CHUNK } from './common.mjs';
import { ensureFixtures } from './fixtures.mjs';

const E = await loadEngine();
const runs = +opt('--runs', 5);
const seconds = +opt('--seconds', 15);
const codecIds = opt('--codecs', 'mp3-cbr192,vorbis-q5,flac').split(',');
const Ns = opt('--ns', '4,8,16,24,32,48,64').split(',').map(Number); // for the first codec
const Ns2 = opt('--ns2', '4,16,32,64').split(',').map(Number); // for the other codecs
const withClip = flag('--clip');
const fixtures = codecIds.map((id) => ensureFixtures().find((c) => c.id === id));
const Q = 128, FADE = 240, START = CHUNK;

async function runScenario(codec, N, clipLoad) {
  const bytes = new Uint8Array(readFileSync(codec.path));
  const wasmBytes = readFileSync(codec.aac ? DEC_AAC_WASM : DEC_WASM);
  const worker = new Worker(join(here, 'src/nodeWorker.mjs'));
  const waitFor = (type) => new Promise((res) => { const h = (m) => { if (m.type === type) { worker.off('message', h); res(m); } }; worker.on('message', h); });
  worker.on('error', (e) => console.error('worker error', e));
  const ready = waitFor('ready');
  worker.postMessage({ type: 'init', wasmBytes: wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.length) });
  await ready;
  const ch = new MessageChannel();
  worker.postMessage({ type: 'connectWorklet', port: ch.port1 }, [ch.port1]);
  const port = ch.port2;
  worker.postMessage({ type: '__elu', reset: true });
  await waitFor('__elu');

  const S = []; // per stream state
  for (let i = 0; i < N; i++) S.push({ id: i + 1, buffered: 0, state: 'wait', pend: new E.CreditAccumulator(), returned: [], creditTimes: [], openAt: 0, startMs: NaN, starves: 0, starvedFrames: 0, open: false });
  const refill = [], levels = [];
  let t0 = 0, steady = false, chunks = 0, clipChunks = 0;
  port.onmessage = (ev) => {
    const data = ev.data;
    const now = performance.now();
    if (!(data instanceof ArrayBuffer)) return;
    const v = new DataView(data);
    const kind = v.getUint16(6, true);
    if (kind === E.Kind.STREAM_OPEN) { const o = E.readStreamOpen(v, 0); S[o.streamId - 1].open = true; return; }
    if (kind === E.Kind.STREAM_CHUNK) {
      const c = E.readStreamChunk(v, 0);
      const s = S[c.streamId - 1];
      s.buffered += c.frames; s.returned.push(data); chunks++;
      const ct = s.creditTimes.shift();
      if (ct !== undefined) refill.push({ t: now - t0, ms: now - ct });
    }
  };
  const postCredit = (s, frames, now) => {
    const bufs = s.returned.splice(0);
    const head = bufs.length && bufs[0].byteLength >= E.STREAM_CREDIT_FIXED_END ? bufs[0] : new ArrayBuffer(E.STREAM_CREDIT_FIXED_END);
    if (head !== bufs[0]) bufs.unshift(head);
    const v = new DataView(head);
    E.writeEnvelope(v, 0, { kind: E.Kind.STREAM_CREDIT, seq: 0, bodyBytes: E.STREAM_CREDIT_FIXED_END - 16 });
    E.writeStreamCredit(v, 0, { streamId: s.id, epoch: 1, consumedFrames: frames, returnedBuffers: bufs.length - 1 });
    s.creditTimes.push(now);
    port.postMessage(bufs, bufs);
  };
  const quantum = (now) => {
    for (const s of S) {
      if (s.state === 'wait' || s.state === 'starved') {
        if (s.state === 'starved') s.starvedFrames += Q;
        if (s.buffered >= START) { if (s.state === 'wait') s.startMs = now - s.openAt; s.state = 'play'; }
        else continue;
      }
      if (s.state === 'play') {
        if (s.buffered < Q + FADE) { s.state = 'starved'; s.starves++; continue; }
        s.buffered -= Q;
        if (steady) levels.push(s.buffered);
        if (s.pend.add(Q)) postCredit(s, s.pend.take(), now);
      }
    }
  };

  // Open all N at once (a music set starting together), then run the clock.
  const t = performance.now();
  t0 = t;
  for (const s of S) {
    s.openAt = t;
    const copy = bytes.slice().buffer;
    worker.postMessage({ type: 'streamOpen', streamId: s.id, asset: codec.id, bytes: copy, hint: codec.hint, startFrame: 0, epoch: 1, loop: true }, [copy]);
  }
  let clipTimer = null;
  if (clipLoad) {
    // A whole-clip decode of the same file in the same worker every 3 s (a stinger/segment preloading), replies dropped.
    let id = 1000;
    const sendClip = () => { const c = bytes.slice().buffer; worker.postMessage({ type: 'decodeClip', id: id++, asset: 'clip', bytes: c, hint: codec.hint }, [c]); };
    worker.on('message', (m) => { if (m.type === 'clipChunk') clipChunks++; });
    clipTimer = setInterval(sendClip, 3000);
    sendClip();
  }
  let qdone = 0;
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      const due = Math.floor(((now - t0) * 48) / Q);
      if (!steady && now - t0 > 3000) steady = true; // 3 s warm-up excluded from the ring-level statistics
      while (qdone < due) { quantum(t0 + (qdone * Q) / 48); qdone++; }
      if (now - t0 < seconds * 1000) setTimeout(tick, 1); else resolve();
    };
    tick();
  });
  if (clipTimer) clearInterval(clipTimer);
  worker.postMessage({ type: '__elu' });
  const elu = await waitFor('__elu');
  const steadyRefill = refill.filter((r) => r.t > 3000).map((r) => r.ms);
  const lv = levels.length ? levels.reduce((m, x) => Math.min(m, x), 1e9) : NaN;
  const out = {
    N, startMsP50: median(S.map((s) => s.startMs)), startMsMax: Math.max(...S.map((s) => s.startMs)), startSpread: Math.max(...S.map((s) => s.startMs)) - Math.min(...S.map((s) => s.startMs)), opened: S.filter((s) => s.open).length,
    starves: S.reduce((a, s) => a + s.starves, 0), starvedMs: S.reduce((a, s) => a + s.starvedFrames, 0) / 48, minRingFrames: lv,
    refill: stats(steadyRefill), eluPct: elu.utilization * 100, chunksWorker: elu.chunks, chunksSeen: chunks, allocatedBuffers: elu.allocated, clipChunks,
    wallS: (performance.now() - t0) / 1000,
  };
  port.close();
  await worker.terminate();
  return out;
}

const all = [];
for (const [ci, codec] of fixtures.entries()) {
  for (const N of ci === 0 ? Ns : Ns2) {
    const rs = [];
    for (let r = 0; r < runs; r++) rs.push(await runScenario(codec, N, withClip));
    const row = { codec: codec.id, N, clip: withClip, runs: rs, median: { startP50: median(rs.map((x) => x.startMsP50)), startMax: median(rs.map((x) => x.startMsMax)), startSpread: median(rs.map((x) => x.startSpread)), refillP50: median(rs.map((x) => x.refill.p50)), refillP99: median(rs.map((x) => x.refill.p99)), refillP999: median(rs.map((x) => x.refill.p999)), refillMax: Math.max(...rs.map((x) => x.refill.max)), elu: median(rs.map((x) => x.eluPct)), minRing: Math.min(...rs.map((x) => x.minRingFrames)), starves: rs.reduce((a, x) => a + x.starves, 0), opened: Math.min(...rs.map((x) => x.opened)) } };
    all.push(row);
    const m = row.median;
    console.error(`${codec.id} N=${N}${withClip ? '+clip' : ''}: worker busy ${f(m.elu, 2)}% start p50 ${f(m.startP50, 0)} ms (max ${f(m.startMax, 0)}, spread ${f(m.startSpread, 0)}), refill p50 ${f(m.refillP50, 1)} p99 ${f(m.refillP99, 1)} max ${f(m.refillMax, 1)} ms, min ring ${m.minRing} fr, starves ${m.starves}`);
  }
}
saveJson(opt('--out', withClip ? 'q2_clip.json' : 'q2.json'), { date: new Date().toISOString(), node: process.version, runs, seconds, all });
console.log(`\nQ2 concurrency${withClip ? ' + a whole-clip decode of the same file every 3 s in the same worker' : ''}: ${runs} runs x ${seconds} s each. Worker busy % = event-loop utilisation of the worker thread (= fraction of one core); refill = credit posted -> its chunk received (the worker's response time); start = open -> first sample played (needs ${CHUNK} frames); min ring = fewest frames buffered after a 3 s warm-up (starve below ${Q + FADE}). Median over runs, max = worst run, starves = total over runs.\n`);
console.log('| codec | N | worker busy % | start p50 (ms) | start max (ms) | start spread max-min (ms) | refill p50 (ms) | p99 | p99.9 | max | min ring (frames) | starves | opened (min over runs) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of all) { const m = r.median; console.log(`| ${r.codec} | ${r.N} | ${f(m.elu, 2)} | ${f(m.startP50, 0)} | ${f(m.startMax, 0)} | ${f(m.startSpread, 0)} | ${f(m.refillP50, 1)} | ${f(m.refillP99, 1)} | ${f(m.refillP999, 1)} | ${f(m.refillMax, 1)} | ${m.minRing} | ${m.starves} | ${m.opened} |`); }
