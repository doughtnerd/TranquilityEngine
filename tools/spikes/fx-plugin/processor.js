// Spike B0 (ADR 0338): the AudioWorkletProcessor. Everything runs in the port's onmessage, on the audio thread,
// inside AudioWorkletGlobalScope. The scope has no `performance`, so every timing uses Date.now (1 ms) over long
// trials.
import { glueCost, fuelOverhead, compileTimes, faultIsolation, hasMultiMemory } from "./bench.js";

const now = () => Date.now();

class SpikeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.onmessageerror = () => this.port.postMessage({ type: "module", result: "messageerror: the posted message could not be deserialized here" });
    // A compiled module handed over in processorOptions (structured clone at node creation).
    const m = options?.processorOptions?.module;
    if (m !== undefined) {
      let result;
      try {
        const inst = new WebAssembly.Instance(m, {});
        result = `ok (abi 0x${inst.exports.myco_fx_abi().toString(16)})`;
      } catch (e) {
        result = `received ${Object.prototype.toString.call(m)} but failed: ${e.message}`;
      }
      this.port.postMessage({ type: "options", result });
    }
  }

  log(msg) {
    this.port.postMessage({ type: "log", msg });
  }

  onMessage(d) {
    if (d.type === "module") {
      let result;
      try {
        const ok = d.module instanceof WebAssembly.Module;
        const inst = new WebAssembly.Instance(d.module, {});
        result = `ok (instanceof Module: ${ok}, abi 0x${inst.exports.myco_fx_abi().toString(16)})`;
      } catch (e) {
        result = `failed: ${e.message}`;
      }
      this.port.postMessage({ type: "module", result });
      return;
    }
    if (d.type === "run") this.run(d.bins);
  }

  async run(bins) {
    const R = { env: {} };
    const env = R.env;
    env.hasPerformance = typeof globalThis.performance;
    env.hasWebAssembly = typeof WebAssembly;
    env.hasCompileStreaming = typeof WebAssembly.compileStreaming;
    env.multiMemory = hasMultiMemory(bins);
    env.sampleRate = sampleRate;

    // Synchronous compile and instantiate from bytes.
    for (const [label, b] of [["plugin", bins.plain], ["plugin+fuel", bins.segment32], ["100 KB", bins.large], ["core 472 KB", bins.core], ["decoder 1.1 MB", bins.coreBig], ["9 MB", bins.huge]]) {
      try {
        const t0 = now();
        const m = new WebAssembly.Module(b);
        const t1 = now();
        let inst = "";
        if (WebAssembly.Module.imports(m).length === 0) {
          new WebAssembly.Instance(m, {});
          inst = ` + instance ${now() - t1} ms`;
        }
        env[`syncCompile ${label}`] = `ok ${t1 - t0} ms${inst}`;
      } catch (e) {
        env[`syncCompile ${label}`] = `refused: ${e.message}`;
      }
    }
    // Asynchronous compile: do promises resolve in this scope?
    try {
      const t0 = now();
      const m = await WebAssembly.compile(bins.large);
      const { instance } = await WebAssembly.instantiate(bins.plain, {});
      env.asyncCompile = `ok ${now() - t0} ms (${m instanceof WebAssembly.Module}, abi 0x${instance.exports.myco_fx_abi().toString(16)})`;
    } catch (e) {
      env.asyncCompile = `failed: ${e.message}`;
    }
    // How long does the asynchronous compile of the 9 MB module hold this thread (the call itself), against its total?
    try {
      const t0 = now();
      const p = WebAssembly.compile(bins.huge);
      const t1 = now();
      await p;
      env.asyncCompile9MB = `call ${t1 - t0} ms, resolved after ${now() - t0} ms`;
    } catch (e) {
      env.asyncCompile9MB = `failed: ${e.message}`;
    }

    try {
      this.log("glue");
      R.glue = glueCost(bins, now, { ms: 150, quick: true });
      this.log("fuel");
      R.fuel = fuelOverhead(bins, now, { ms: 150 });
      this.log("compile");
      R.compile = compileTimes(bins, now, { ms: 600, seed: 3 });
      this.log("faults");
      R.faults = ["wasmscan", ...(env.multiMemory ? ["multimemory"] : [])].map((s) => faultIsolation(bins, now, s, 400));
    } catch (e) {
      R.error = String(e?.stack ?? e);
    }
    this.port.postMessage({ type: "done", results: JSON.parse(JSON.stringify(R, (k, v) => (typeof v === "bigint" ? Number(v) : v))) });
  }

  process() {
    return true;
  }
}

registerProcessor("spike-b0", SpikeProcessor);
