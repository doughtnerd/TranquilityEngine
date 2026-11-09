// Probe worklet: one processor, behaviours switched by messages / processorOptions. No mixer: the
// "apply" cost of a command is a copy of 8 floats into a state array.
const dateNow = typeof Date !== "undefined" && Date.now ? () => Date.now() : null;

class Probe extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions || {};
    this.frameView = p.frameSab ? new Int32Array(p.frameSab) : null; // worklet writes currentFrame here
    if (p.ringSab) {
      this.rh = new Int32Array(p.ringSab, 0, 4); // [head, tail] in floats, monotonic
      this.rd = new Float32Array(p.ringSab, 16);
      this.rmask = this.rd.length - 1;
      this.res = new Int32Array(p.resSab); // seq -> currentFrame at which the batch was seen
    }
    if (p.streamSab) {
      this.cap = p.cap;
      this.sh = new Int32Array(p.streamSab, 0, 4); // [written, read] in frames
      this.sL = new Float32Array(p.streamSab, 16, p.cap);
      this.sR = new Float32Array(p.streamSab, 16 + 4 * p.cap, p.cap);
    }
    this.state = new Float32Array(8192 * 8);
    this.pendingBatches = [];
    this.pendingPings = [];
    this.calls = 0;
    this.dur = { n: 0, ge1: 0, ge2: 0, ge5: 0, max: 0 };
    // stream state
    this.chunks = [];
    this.buffered = 0;
    this.started = false;
    this.target = 0;
    this.streamMode = null;
    this.s = { underruns: 0, silentFrames: 0, minLevel: Infinity, maxLevel: 0, quanta: 0, chunks: 0, startFrame: 0, reported: false, quantaLimit: 7500 };
    this.port.onmessage = (e) => this.onMsg(e.data);
    this.port.postMessage({ type: "ready", sampleRate, features: this.features() });
  }

  features() {
    const t = (f) => { try { return f(); } catch (e) { return "throws " + e.name; } };
    return {
      performance: t(() => typeof performance),
      performanceNow: t(() => (typeof performance !== "undefined" ? typeof performance.now : "n/a")),
      performanceMemory: t(() => (typeof performance !== "undefined" ? typeof performance.memory : "n/a")),
      dateNow: t(() => typeof Date.now),
      currentFrame: t(() => typeof currentFrame),
      currentTime: t(() => typeof currentTime),
      sampleRate: t(() => sampleRate),
      SharedArrayBuffer: t(() => typeof SharedArrayBuffer),
      Atomics: t(() => typeof Atomics),
      AtomicsWait: t(() => (typeof Atomics !== "undefined" ? typeof Atomics.wait : "n/a")),
      WebAssembly: t(() => typeof WebAssembly),
      TextDecoder: t(() => typeof TextDecoder),
      TextEncoder: t(() => typeof TextEncoder),
      setTimeout: t(() => typeof setTimeout),
      fetch: t(() => typeof fetch),
      MessageChannel: t(() => typeof MessageChannel),
      crossOriginIsolated: t(() => (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "undefined")),
      global: t(() => Object.prototype.toString.call(globalThis)),
    };
  }

  onMsg(m) {
    switch (m.type) {
      case "ping":
        this.port.postMessage({ type: "pong", id: m.id, cf: currentFrame });
        break;
      case "pingNext":
        this.pendingPings.push({ id: m.id, recv: currentFrame });
        break;
      case "batch":
        this.pendingBatches.push({ seq: m.seq, buf: m.buf, recv: currentFrame });
        break;
      case "stream-port":
        m.port.onmessage = (e) => {
          const d = e.data;
          this.chunks.push({ l: d.l, r: d.r, pos: 0 });
          this.buffered += d.l.length;
          this.s.chunks++;
        };
        break;
      case "stream-start":
        this.target = m.target;
        this.s.quantaLimit = m.quanta || 7500;
        this.streamMode = m.mode;
        break;
      case "report":
        this.report();
        break;
    }
  }

  report() {
    this.s.reported = true;
    this.port.postMessage({ type: "report", s: this.s, dur: this.dur, calls: this.calls });
  }

  process(_inputs, outputs) {
    const t0 = dateNow ? dateNow() : 0;
    this.calls++;
    if (this.frameView) Atomics.store(this.frameView, 0, currentFrame);

    if (this.rh) {
      const head = Atomics.load(this.rh, 0);
      let tail = this.rh[1];
      while (tail < head) {
        const o = tail & this.rmask;
        const seq = this.rd[o];
        const voice = this.rd[o + 1];
        const base = (voice & 8191) * 8;
        for (let k = 0; k < 8; k++) this.state[base + k] = this.rd[o + k];
        if (voice === 0) this.res[seq & 4095] = currentFrame;
        tail += 8;
      }
      Atomics.store(this.rh, 1, tail);
    }

    if (this.pendingBatches.length) {
      for (const b of this.pendingBatches) {
        const buf = b.buf;
        const n = buf.length >> 3;
        for (let v = 0; v < n; v++) {
          const base = (v & 8191) * 8;
          for (let k = 0; k < 8; k++) this.state[base + k] = buf[v * 8 + k];
        }
        this.port.postMessage({ type: "echo", seq: b.seq, recv: b.recv, apply: currentFrame });
      }
      this.pendingBatches.length = 0;
    }
    if (this.pendingPings.length) {
      for (const p of this.pendingPings) this.port.postMessage({ type: "pong", id: p.id, cf: currentFrame, recv: p.recv });
      this.pendingPings.length = 0;
    }

    if (this.streamMode) this.consume(outputs[0]);

    if (dateNow) {
      const d = dateNow() - t0;
      const D = this.dur;
      D.n++;
      if (d >= 1) D.ge1++;
      if (d >= 2) D.ge2++;
      if (d >= 5) D.ge5++;
      if (d > D.max) D.max = d;
    }
    return true;
  }

  consume(out) {
    const s = this.s;
    const L = out[0], R = out[1] || out[0];
    const sab = this.streamMode === "sab";
    const level = sab ? Atomics.load(this.sh, 0) - this.sh[1] : this.buffered;
    if (!this.started) {
      if (level >= this.target) { this.started = true; s.startFrame = currentFrame; } else return;
    }
    if (s.reported) return;
    if (level < s.minLevel) s.minLevel = level;
    if (level > s.maxLevel) s.maxLevel = level;
    const take = Math.min(128, level);
    if (take < 128) { s.underruns++; s.silentFrames += 128 - take; }
    if (sab) {
      const r = this.sh[1], m = this.cap - 1;
      for (let i = 0; i < take; i++) { L[i] = this.sL[(r + i) & m]; R[i] = this.sR[(r + i) & m]; }
      Atomics.store(this.sh, 1, r + take);
    } else {
      let i = 0;
      while (i < take) {
        const c = this.chunks[0];
        const n = Math.min(take - i, c.l.length - c.pos);
        for (let k = 0; k < n; k++) { L[i + k] = c.l[c.pos + k]; R[i + k] = c.r[c.pos + k]; }
        c.pos += n; i += n;
        if (c.pos >= c.l.length) this.chunks.shift();
      }
      this.buffered -= take;
    }
    if (++s.quanta >= s.quantaLimit) this.report();
  }
}
registerProcessor("probe", Probe);
