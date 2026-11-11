// One spike case per process() call. id -1 is an empty processor (the graph's own cost).
class CaseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasm, id, run, quanta } = options.processorOptions;
    this.id = id;
    this.left = quanta;
    if (id >= 0) {
      this.x = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports;
      const t = Date.now();
      this.h = this.x.make_case(id, run);
      this.prepMs = Date.now() - t;
      for (let i = 0; i < 300; i++) { this.x.prepare(this.h); this.x.step(this.h); }
    }
    this.last = 0;
    this.maxGap = 0;
    this.sink = 0;
    this.port.postMessage({ type: 'ready' });
  }
  process() {
    if (this.id >= 0) {
      const now = Date.now();
      if (this.last) this.maxGap = Math.max(this.maxGap, now - this.last);
      this.last = now;
      this.x.prepare(this.h);
      this.sink += this.x.step(this.h);
    }
    if (--this.left === 0) this.port.postMessage({ type: 'done', maxGapMs: this.maxGap, prepMs: this.prepMs ?? 0, sink: this.sink });
    return true;
  }
}
registerProcessor('case-proc', CaseProcessor);
