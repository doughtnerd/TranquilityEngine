// AudioWorkletProcessor running one case: one process() call = one 128-frame quantum of the core
// thread's work. AudioWorkletGlobalScope has no `performance`, so time comes from a spinning
// worker that writes performance.now() (ms, f64) into a SharedArrayBuffer (see clock.js).
class BedProc extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.done = true;
    try { this.init(o); } catch (e) { this.port.postMessage({ error: String(e && e.stack || e) }); }
  }
  init(o) {
    const p = o.processorOptions;
    this.p = p;
    this.clk = new Float64Array(p.sab);
    const mod = new WebAssembly.Module(p.wasm);
    this.x = new WebAssembly.Instance(mod, {}).exports;
    const x = this.x;
    const ptr = x.alloc(p.hrir.byteLength);
    new Uint8Array(x.memory.buffer, ptr, p.hrir.byteLength).set(new Uint8Array(p.hrir));
    x.init_shared(ptr, p.hrir.byteLength);
    if (x.case_init(p.caseId) !== 0) throw new Error('case_init');
    // Calibrate the batch size k: the shared clock ticks in ~5 us steps, so a cheap case is timed
    // as the mean of k quanta (reported as one sample).
    x.case_reset();
    for (let i = 0; i < 40; i++) x.case_quantum();
    const t0 = this.clk[0];
    for (let i = 0; i < 40; i++) x.case_quantum();
    const per = ((this.clk[0] - t0) * 1000) / 40;
    this.k = per < 60 ? Math.ceil(300 / Math.max(per, 0.2)) : 1;
    this.run = 0;
    this.i = 0;
    this.t = new Float64Array(p.quanta);
    this.out = [];
    this.sink = 0;
    this.done = false;
  }
  process() {
    const p = this.p, x = this.x;
    if (this.done) return true;
    if (this.i === 0) x.case_reset();
    if (this.i < p.warm) {
      this.sink += x.case_quantum();
    } else {
      const a = this.clk[0];
      for (let j = 0; j < this.k; j++) this.sink += x.case_quantum();
      const b = this.clk[0];
      this.t[this.i - p.warm] = ((b - a) * 1000) / this.k;
    }
    this.i++;
    if (this.i === p.warm + p.quanta) {
      this.out.push(this.t.slice());
      this.i = 0;
      this.run++;
      if (this.run === p.runs) {
        x.case_reset();
        let cs = 0;
        for (let i = 0; i < 50; i++) cs += x.case_quantum();
        this.done = true;
        this.port.postMessage({ runs: this.out, k: this.k, checksum50: cs, sink: this.sink });
      }
    }
    return true;
  }
}
registerProcessor('bed', BedProc);
