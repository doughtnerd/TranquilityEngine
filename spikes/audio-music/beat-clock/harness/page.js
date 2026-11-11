// Main-thread side: the engine's real ClockMap (transpiled from src/plugins/audio/runtime/core/clock.ts, unmodified),
// a 60 Hz rAF loop, and both beat-callback designs. Returns raw records; run.mjs analyses them.
import { ClockMap } from '/ts/clock.js';
import { beatFrame } from '/tempo.js';

export async function run({ durationS, limiterFrames, hitches, seed, inputEvents, latencyHint }) {
  const ctx = new AudioContext({ latencyHint });
  const sr = ctx.sampleRate, D = limiterFrames;
  await ctx.audioWorklet.addModule('/processor.js');
  const sab = new SharedArrayBuffer(8);
  const cw = new Worker('/clock.js');
  await new Promise((r) => { cw.onmessage = r; cw.postMessage(sab); });
  const sf = new Float64Array(sab); while (sf[0] === 0) await new Promise((r) => setTimeout(r, 5));
  const node = new AudioWorkletNode(ctx, 'beats', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { sr, sab } });
  node.connect(ctx.destination);
  await ctx.resume();

  // A HostClock like browserHostClock (hostClock.ts:42-80) but with rafTime() = the rAF callback's own timestamp.
  let rafP = performance.now();
  const clock = {
    rafTime: () => rafP,
    outputTimestamp() {
      if (ctx.state !== 'running') return null;
      const t = ctx.getOutputTimestamp();
      if (!t || (t.contextTime === 0 && t.performanceTime === 0)) return null;
      return { contextTime: t.contextTime, performanceTime: t.performanceTime };
    },
    currentTime: () => ctx.currentTime,
    dateNow: () => Date.now(),
    fake: false,
  };
  const cm = new ClockMap(clock, sr, D);

  // ---- state shared by both designs
  const epochs = [];           // main's view: { id, map, S|null, end|null, next }
  const rendered = [];         // filled from the worklet dump (truth)
  const fired = { A: [], A0: [], Braw_imm: [], Bheld_imm: [], Braw_status: [], Bheld_status: [] };
  const arrive = { imm: [], status: [] };
  const rawPend = { imm: [], status: [] };
  const heldPend = { imm: [], status: [] };
  const frames = { p: [], hcm: [], hot: [], hct: [], at: [], reanch: [] };
  let lastStatus = null, statusCount = 0, lastAt = 0;
  let epochId = 0;
  const log = [];              // scenario log: [name, p, detail]
  const sendSeg = (map, S) => { const id = ++epochId; node.port.postMessage({ type: 'seg', id, map, S }); return id; };

  node.port.onmessage = (e) => {
    const m = e.data, now = performance.now();
    if (m.type === 'beat') { const r = { id: m.id, n: m.n, frame: m.frame, arr: now }; arrive.imm.push(r); rawPend.imm.push(r); heldPend.imm.push(r); }
    else if (m.type === 'status') {
      statusCount++; lastStatus = m; cm.noteStatus(m.frame, m.dateMs);
      for (const b of m.beats) { const r = { id: b[0], n: b[1], frame: b[2], arr: now }; arrive.status.push(r); rawPend.status.push(r); heldPend.status.push(r); }
      for (const [id, S] of m.epochs) {
        const ep = epochs.find((x) => x.id === id);
        if (ep && ep.S === null) { ep.S = S; const prev = epochs[epochs.indexOf(ep) - 1]; if (prev) prev.end = S; log.push(['asap-confirmed', now, { id, S }]); }
      }
    }
  };

  // ---- scenario (fractions of durationS so the smoke run exercises the same events)
  const TOTAL_BEATS_120 = durationS * 2;
  const tempoBeat = Math.max(4, Math.floor(TOTAL_BEATS_120 * 0.25 / 4) * 4);
  const map1 = [{ beat: 0, bpm: 120 }, { beat: tempoBeat, bpm: 90 }];
  const map2 = [{ beat: 0, bpm: 100 }];
  const map3 = [{ beat: 0, bpm: 120 }];
  const t0 = performance.now();
  const T = (frac) => t0 + 1500 + frac * durationS * 1000;
  let started = false, stampedDone = false, seeks = 0;
  const SEEKS = 8;
  const hitchList = hitches.map(([frac, ms]) => ({ at: T(frac), ms, done: false }));

  // ---- the per-frame loop
  let nowFrame = 0;
  const frameP = [];
  const tick = (p) => {
    rafP = p; frameP.push(p);
    cm.beginFrame();
    const at = cm.audioTime(); lastAt = at;
    const dt = cm.frameIntervalMs / 1000;
    const winEnd = (at + dt) * sr;            // heard-frame window this display frame covers (A, design: predict-cover)
    const winStart = at * sr;
    const ts = clock.outputTimestamp();
    frames.p.push(p); frames.at.push(at);
    frames.hcm.push(at * sr + D);
    frames.hot.push(ts ? sr * (ts.contextTime + (p - ts.performanceTime) / 1000) : NaN);
    frames.hct.push(ctx.currentTime * sr);
    frames.reanch.push(cm.reanchors);

    // scenario commands
    if (!started && p >= t0 + 1500) {
      started = true;
      const S = cm.nextFirstFrame() + 2048;
      const id = sendSeg(map1, S); epochs.push({ id, map: map1, S, end: null, next: 0 });
      log.push(['start-stamped', p, { id, S }]);
    }
    if (started && !stampedDone && p >= T(0.5)) {
      stampedDone = true;
      // quantise to the next bar (4 beats) of the playing epoch whose frame is at least firstFrame away
      const e = epochs[epochs.length - 1], ff = cm.nextFirstFrame() + 2048;
      let n = 0; while (beatFrame(e.map, e.S, n, sr) < ff || n % 4) n++;
      const S = beatFrame(e.map, e.S, n, sr);
      const id = sendSeg(map2, S); e.end = S; epochs.push({ id, map: map2, S, end: null, next: 0 });
      log.push(['transition-stamped-at-bar', p, { id, S, bar: n / 4 }]);
    }
    if (started && stampedDone && seeks < SEEKS && p >= T(0.58 + 0.045 * seeks) && at * sr > epochs[1].S + sr) {
      const map = seeks % 2 ? map3 : map2;       // alternate 120 / 100 BPM so every seek changes the grid
      seeks++;
      const id = sendSeg(map, 0); epochs.push({ id, map, S: null, end: null, next: 0 });
      log.push(['seek-asap', p, { id }]);
    }

    // ---- design A: predict from the tempo map + heard clock; fire in the frame whose window covers the beat
    for (const e of epochs) {
      if (e.S === null) continue;
      for (;;) {
        const f = beatFrame(e.map, e.S, e.next, sr);
        if (e.end !== null && f >= e.end) break;
        if (f >= winEnd) break;
        fired.A.push({ id: e.id, n: e.next, frame: f, p, at });
        e.next++;
      }
    }
    // A0: reactive variant (fires once the heard clock has passed the beat: one frame later than A on average)
    for (const e of epochs) {
      if (e.S === null) continue;
      e.next0 = e.next0 ?? 0;
      for (;;) {
        const f = beatFrame(e.map, e.S, e.next0, sr);
        if (e.end !== null && f >= e.end) break;
        if (f >= winStart) break;
        fired.A0.push({ id: e.id, n: e.next0, frame: f, p, at });
        e.next0++;
      }
    }
    // ---- design B: raw = fire at the first frame after arrival; held = also wait until the beat is heard (A's rule)
    for (const k of ['imm', 'status']) {
      for (const r of rawPend[k]) fired['Braw_' + k].push({ id: r.id, n: r.n, frame: r.frame, p, arr: r.arr });
      rawPend[k].length = 0;
      const keep = [];
      for (const r of heldPend[k]) {
        if (r.frame < winEnd) fired['Bheld_' + k].push({ id: r.id, n: r.n, frame: r.frame, p, arr: r.arr });
        else keep.push(r);
      }
      heldPend[k] = keep;
    }

    // ---- hitches (a long frame): busy-wait at the end of the callback
    for (const h of hitchList) if (!h.done && p >= h.at) { h.done = true; h.start = performance.timeOrigin + performance.now(); const e = performance.now() + h.ms; while (performance.now() < e); log.push(['hitch', p, { ms: h.ms }]); }
    nowFrame++;
    if (p < t0 + 1500 + durationS * 1000 + 2500) requestAnimationFrame(tick); else finish();
  };

  // ---- input (rhythm mode, Q5): synthetic events at known times plus trusted CDP key events from node
  const inputs = [];
  const handler = (e) => {
    const now = performance.now(), tsEv = e.timeStamp;
    const o = clock.outputTimestamp();
    inputs.push({
      kind: e.isTrusted ? 'cdp' : 'synthetic', ts: tsEv, now,
      mapped: (tsEv * sr / 1000 + cm.offsetFrames - D) / sr,           // ClockMap offset applied to the event's own timestamp
      stale: lastAt,                                                  // Audio.time as of the last frame (what a script reads)
      raw: o ? (sr * (o.contextTime + (tsEv - o.performanceTime) / 1000) - D) / sr : NaN, // unfiltered getOutputTimestamp at the event
    });
  };
  window.addEventListener('tap', handler); window.addEventListener('keydown', handler);
  let rng = seed >>> 0 || 1; const rnd = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
  const inputTimer = setInterval(() => { if (inputEvents && started) setTimeout(() => window.dispatchEvent(new Event('tap')), rnd() * 40); }, 100);

  let done;
  const finished = new Promise((r) => (done = r));
  async function finish() {
    clearInterval(inputTimer);
    const dump = await new Promise((r) => { const prev = node.port.onmessage; node.port.addEventListener('message', function h(e) { if (e.data.type === 'dump') { node.port.removeEventListener('message', h); r(e.data); } }); node.port.postMessage({ type: 'dump' }); });
    done({
      sr, D, timeOrigin: performance.timeOrigin, durationS, tempoBeat, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency,
      rendered: dump.rendered, qf: dump.qf, qt: dump.qt, late: dump.late,
      fired, arrive, frames, frameP, log, inputs, statusCount,
      cm: { reanchors: cm.reanchors, rejected: cm.rejected },
      epochs: epochs.map((e) => ({ id: e.id, S: e.S, end: e.end, bpm0: e.map[0].bpm })),
      hitches: hitchList.map((h) => ({ ms: h.ms, startEpoch: h.start })),
    });
  }
  window.__ready = true;
  requestAnimationFrame(tick);
  return finished;
}
window.__run = run;
