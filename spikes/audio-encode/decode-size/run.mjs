// ADR 0337 spike A0/S2: decodes an Ogg Opus file through the libopus build of the decoder wasm and reports the frame
// count (pre-skip and end trimming applied) and the speed.
//   node spikes/audio-encode/decode-size/run.mjs <decoder.wasm> <file.opus> [repeat]
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const [wasmPath, opusPath, repeat = "3"] = process.argv.slice(2);
const module = await WebAssembly.compile(readFileSync(wasmPath));
const input = readFileSync(opusPath);
for (let r = 0; r < Number(repeat); r++) {
  const { exports: x } = await WebAssembly.instantiate(module, {});
  const p = x.spike_alloc(input.length);
  new Uint8Array(x.memory.buffer, p, input.length).set(input);
  const t0 = performance.now();
  const frames = Number(x.spike_opus_decode_ogg(p, input.length));
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ frames, seconds: +(frames / 48000).toFixed(3), ms: +ms.toFixed(1), xRealtime: +((frames / 48) / ms).toFixed(1) }));
}
