// ADR 0351 spike A0/S1: a module Worker that runs encoder jobs on the reactor through wasi-shim.js.
// message in: { wasm: ArrayBuffer | WebAssembly.Module, input: ArrayBuffer, jobs: ["vorbis:0.4", ...] }
// message out: { results: [stats...] } or { error }
import { wasiShim } from "./wasi-shim.js";

const CODECS = ["pcm", "adpcm", "vorbis", "opus", "sinc", "fft", "opus-fft"];

self.onmessage = async ({ data }) => {
  try {
    const module = data.wasm instanceof WebAssembly.Module ? data.wasm : await WebAssembly.compile(data.wasm);
    const input = new Uint8Array(data.input);
    const results = [];
    for (const job of data.jobs) {
      const [codec, q = "0.5", rate = "0", cx = "10"] = job.split(":");
      const shim = wasiShim();
      const t0 = performance.now();
      const instance = await WebAssembly.instantiate(module, shim.imports);
      shim.bind(instance);
      const x = instance.exports;
      const p = x.spike_alloc(input.length);
      new Uint8Array(x.memory.buffer, p, input.length).set(input);
      x.spike_encode(p, input.length, CODECS.indexOf(codec), Number(q), Number(rate), Number(cx));
      const outLen = x.spike_out_len();
      const stats = JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.spike_stats_ptr(), x.spike_stats_len())));
      stats.wallMs = +(performance.now() - t0).toFixed(1);
      stats.outBytes = outLen;
      stats.memoryMB = +(x.memory.buffer.byteLength / 1048576).toFixed(1);
      results.push(stats);
    }
    self.postMessage({ results });
  } catch (e) {
    self.postMessage({ error: String(e && e.stack || e) });
  }
};
