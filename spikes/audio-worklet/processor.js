// AudioWorklet side of the spike: instantiates the mixer wasm synchronously from bytes passed in
// processorOptions (posting a compiled WebAssembly.Module to a worklet has failed in WebKit before),
// renders one quantum per process() call, and reports the mixed voice count.
class MixerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasm, logical, real } = options.processorOptions;
    const t0 = Date.now();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), {});
    this.compileMs = Date.now() - t0; // 1 ms resolution: the worklet has no performance clock
    this.x = instance.exports;
    // Start-up timing passes other modules too; only the mixer has these exports.
    this.isMixer = typeof this.x.spike_init === "function";
    if (this.isMixer) {
      this.x.spike_init(sampleRate);
      this.x.spike_set_voices(logical, real);
    }
    this.calls = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "voices") this.x.spike_set_voices(e.data.logical, e.data.real);
    };
    this.port.postMessage({ type: "ready", sampleRate, hasPerformance: typeof performance !== "undefined", compileMs: this.compileMs });
  }

  process(_inputs, outputs) {
    if (!this.isMixer) return true;
    const ptr = this.x.spike_process();
    // Re-read memory each call: it can grow (detaching old views).
    const out = new Float32Array(this.x.memory.buffer, ptr, 256);
    const [l, r] = outputs[0];
    l.set(out.subarray(0, 128));
    if (r) r.set(out.subarray(128, 256));
    if (++this.calls % 375 === 0) this.port.postMessage({ type: "tick", calls: this.calls, mixed: this.x.spike_mixed_last() });
    return true;
  }
}
registerProcessor("myco-mixer", MixerProcessor);
