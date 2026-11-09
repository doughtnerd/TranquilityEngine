// Page side of the messaging probe. run.mjs calls window.probe.* and gets JSON back.
const SR = 48000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;

function pct(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (v) => Math.round(v * 1000) / 1000;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

function busy(ms) { const e = performance.now() + ms; while (performance.now() < e); }

async function makeNode(extra = {}) {
  const ctx = new AudioContext({ sampleRate: SR, latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("processor.js");
  await ctx.resume();
  const frameSab = isolated ? new SharedArrayBuffer(16) : null;
  const processorOptions = { frameSab, ...extra };
  const node = new AudioWorkletNode(ctx, "probe", { numberOfInputs: 0, outputChannelCount: [2], processorOptions });
  const waiters = new Map();
  let readyMsg;
  const ready = new Promise((r) => (readyMsg = r));
  const handlers = [];
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === "ready") readyMsg(d);
    else if (d.type === "pong" && waiters.has(d.id)) { waiters.get(d.id)(d); waiters.delete(d.id); }
    else for (const h of handlers) h(d);
  };
  node.connect(ctx.destination);
  const r = await ready;
  return {
    ctx, node, ready: r, frameView: frameSab ? new Int32Array(frameSab) : null,
    waitPong: (id) => new Promise((res) => waiters.set(id, res)),
    onMsg: (h) => handlers.push(h),
  };
}

function startJank(ms, every) {
  const id = setInterval(() => busy(ms), every);
  return () => clearInterval(id);
}

// Rolling heap sampler (main thread). performance.memory needs --enable-precise-memory-info.
function heapSampler() {
  const has = !!performance.memory;
  let last = has ? performance.memory.usedJSHeapSize : 0;
  const st = { has, allocated: 0, drops: 0, samples: 0, start: last };
  return {
    sample() {
      if (!has) return;
      const v = performance.memory.usedJSHeapSize;
      if (v >= last) st.allocated += v - last; else st.drops++;
      st.samples++; last = v;
    },
    result() { return { available: has, bytesGrowthSummed: st.allocated, gcDrops: st.drops, samples: st.samples }; },
  };
}

window.probe = {
  isolated,

  async features() {
    const w = await makeNode();
    const main = {
      crossOriginIsolated: isolated, performance: typeof performance, SharedArrayBuffer: typeof SharedArrayBuffer,
      performanceMemory: typeof performance.memory,
    };
    const out = { main, worklet: w.ready.features, sampleRate: w.ctx.sampleRate, baseLatency: w.ctx.baseLatency, outputLatency: w.ctx.outputLatency };
    // does the audio clock actually advance?
    const t0 = w.ctx.currentTime; await sleep(500);
    out.ctxAdvancedIn500ms = w.ctx.currentTime - t0;
    await w.ctx.close();
    return out;
  },

  // kind: "ping" (reply from onmessage) | "pingNext" (reply from the next process()).
  async rtt(kind, jank, n = 400) {
    const w = await makeNode();
    const stop = jank ? startJank(30, 100) : null;
    const rtts = [], qdelay = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const fa = w.frameView ? Atomics.load(w.frameView, 0) : null;
      const p = w.waitPong(i);
      w.node.port.postMessage({ type: kind, id: i });
      const d = await p;
      rtts.push(performance.now() - t0);
      if (fa !== null) qdelay.push((d.cf - fa) / 128);
      await sleep(15);
    }
    stop?.();
    await w.ctx.close();
    return { kind, jank, rttMs: pct(rtts), mainToWorkletQuanta: qdelay.length ? pct(qdelay) : "needs isolation (frame SAB)" };
  },

  // mode: "pm" (one transferable Float32Array via postMessage) | "ring" (SAB ring).
  async batch(mode, N, frames = 600) {
    const ringSab = mode === "ring" ? new SharedArrayBuffer(16 + 4 * (1 << 20)) : null;
    const resSab = mode === "ring" ? new SharedArrayBuffer(4 * 4096) : null;
    const w = await makeNode(mode === "ring" ? { ringSab, resSab } : {});
    const echoes = new Map();
    w.onMsg((d) => { if (d.type === "echo") echoes.set(d.seq, { ...d, at: performance.now() }); });
    const rh = ringSab ? new Int32Array(ringSab, 0, 4) : null;
    const rd = ringSab ? new Float32Array(ringSab, 16) : null;
    const mask = rd ? rd.length - 1 : 0;
    const res = resSab ? new Int32Array(resSab) : null;

    const cost = [], build = [], post = [], dt = [], frameAtSend = [], sendT = [];
    let dropped = 0, prev = 0;
    const heap = heapSampler();
    for (let seq = 0; seq < frames; seq++) {
      await raf();
      const t0 = performance.now();
      if (prev) dt.push(t0 - prev);
      prev = t0;
      if (mode === "pm") {
        const buf = new Float32Array(N * 8);
        for (let v = 0; v < N; v++) { const o = v * 8; buf[o] = seq; buf[o + 1] = v; for (let k = 2; k < 8; k++) buf[o + k] = v * 0.001 + k + seq * 0.01; }
        const t1 = performance.now();
        frameAtSend.push(w.frameView ? Atomics.load(w.frameView, 0) : null);
        sendT.push(t1);
        w.node.port.postMessage({ type: "batch", seq, buf }, [buf.buffer]);
        const t2 = performance.now();
        build.push(t1 - t0); post.push(t2 - t1); cost.push(t2 - t0);
      } else {
        const head = Atomics.load(rh, 0), tail = Atomics.load(rh, 1);
        const need = N * 8;
        let ok = rd.length - (head - tail) >= need;
        if (ok) {
          for (let v = 0; v < N; v++) {
            const o = (head + v * 8) & mask;
            rd[o] = seq; rd[o + 1] = v;
            for (let k = 2; k < 8; k++) rd[o + k] = v * 0.001 + k + seq * 0.01;
          }
          frameAtSend.push(Atomics.load(w.frameView, 0));
          Atomics.store(rh, 0, head + need);
        } else { dropped++; frameAtSend.push(null); }
        const t1 = performance.now();
        cost.push(t1 - t0);
      }
      heap.sample();
    }
    await sleep(500);
    const delay = [], rtMs = [];
    for (let seq = 0; seq < frames; seq++) {
      const fa = frameAtSend[seq];
      if (mode === "pm") {
        const e = echoes.get(seq);
        if (!e) continue;
        rtMs.push(e.at - sendT[seq]);
        if (fa !== null) delay.push((e.apply - fa) / 128);
      } else if (fa !== null) {
        const seen = res[seq & 4095];
        if (seen) delay.push((seen - fa) / 128);
      }
    }
    await w.ctx.close();
    return {
      mode, N, isolated, frames,
      frameIntervalMs: pct(dt),
      mainCostMs: pct(cost),
      buildMs: build.length ? pct(build) : undefined,
      postMessageMs: post.length ? pct(post) : undefined,
      applyDelayQuanta: delay.length ? pct(delay) : "needs isolation (frame SAB)",
      echoRoundTripMs: rtMs.length ? pct(rtMs) : undefined,
      received: mode === "pm" ? echoes.size : delay.length, dropped,
      mainHeap: heap.result(),
    };
  },

  // mode: "port" (worker -> worklet MessagePort) | "sab" (worker writes the SAB ring) | "relay" (worker -> main -> worklet).
  async stream({ mode, chunk, target, mainJank, workerJank, seconds = 20 }) {
    const cap = 1 << 17; // frames, power of two, > 32768 + chunk
    const streamSab = mode === "sab" ? new SharedArrayBuffer(16 + 8 * cap) : null;
    const w = await makeNode(mode === "sab" ? { streamSab, cap } : {});
    const worker = new Worker("worker.js");
    let report;
    const done = new Promise((r) => (report = r));
    w.onMsg((d) => { if (d.type === "report") report(d); });
    const cfg = { mode, chunk, target, workerJank, durationMs: seconds * 1000, cap, sab: streamSab };
    const quanta = Math.round((seconds * SR) / 128);
    w.node.port.postMessage({ type: "stream-start", target, mode: mode === "sab" ? "sab" : "port", quanta });
    let relayed = 0;
    if (mode === "port") {
      const mc = new MessageChannel();
      w.node.port.postMessage({ type: "stream-port", port: mc.port1 }, [mc.port1]);
      cfg.port = mc.port2;
      worker.postMessage(cfg, [mc.port2]);
    } else if (mode === "relay") {
      const mc = new MessageChannel();
      // Relay keeps main in the path: worker -> main -> worklet.
      w.node.port.postMessage({ type: "stream-port", port: mc.port1 }, [mc.port1]);
      worker.onmessage = (e) => { relayed++; mc.port2.postMessage(e.data, [e.data.l.buffer, e.data.r.buffer]); };
      worker.postMessage(cfg);
    } else worker.postMessage(cfg);

    let stopJank = null, stall = null;
    if (mainJank) { stopJank = startJank(50, 500); stall = setTimeout(() => busy(300), 10000); }
    const r = await Promise.race([done, sleep((seconds + 25) * 1000).then(() => ({ timeout: true }))]);
    stopJank?.(); clearTimeout(stall);
    worker.terminate();
    await w.ctx.close();
    if (r.timeout) return { mode, chunk, target, error: "timeout" };
    const s = r.s;
    return {
      mode, chunk, target, mainJank: !!mainJank, workerJank: !!workerJank, seconds,
      underruns: s.underruns, silentFrames: s.silentFrames, minLevel: s.minLevel, maxLevel: s.maxLevel,
      quanta: s.quanta, chunksReceived: s.chunks, relayed,
      processCalls: r.calls, longProcessCalls: r.dur,
    };
  },
};
