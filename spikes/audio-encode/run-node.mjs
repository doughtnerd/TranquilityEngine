// ADR 0351 spike A0/S1: runs the wasm32-wasip1 encoder reactor under Node's built-in WASI (node:wasi).
//
//   node spikes/audio-encode/run-node.mjs <encoder.wasm> <in.wav> <outDir|-> <job>... [--workers=N] [--repeat=R]
//   job = codec[:quality[:rate[:complexity]]], codec one of pcm adpcm vorbis opus sinc fft opus-fft
//
// Bytes cross through linear memory (spike_alloc / spike_encode / spike_out_*), never through WASI fds: Node 22.23's
// node:wasi segfaults (a GC inside the fd_read fast-API call, uvwasi's realloc reporting external memory) on a
// multi-MB fd_read. With --workers=N, N worker_threads run the same jobs at once (one fresh instance per job each) and
// the aggregate throughput is reported, which is the export pool's case (workers = cores - 1).
import { WASI } from "node:wasi";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const CODECS = ["pcm", "adpcm", "vorbis", "opus", "sinc", "fft", "opus-fft"];

async function runJobs(module, input, jobs, outDir) {
  const results = [];
  for (const job of jobs) {
    const [codec, q = "0.5", rate = "0", cx = "10"] = job.split(":");
    const wasi = new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true });
    const t0 = performance.now();
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    wasi.initialize(instance);
    const x = instance.exports;
    const p = x.spike_alloc(input.length);
    new Uint8Array(x.memory.buffer, p, input.length).set(input);
    x.spike_encode(p, input.length, CODECS.indexOf(codec), Number(q), Number(rate), Number(cx));
    const out = new Uint8Array(x.memory.buffer, x.spike_out_ptr(), x.spike_out_len()).slice();
    const stats = JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.spike_stats_ptr(), x.spike_stats_len())));
    stats.wallMs = +(performance.now() - t0).toFixed(1);
    stats.memoryMB = +(x.memory.buffer.byteLength / 1048576).toFixed(1);
    if (outDir && outDir !== "-") writeFileSync(`${outDir}/${job.replaceAll(":", "_")}.${{ vorbis: "ogg", opus: "opus", "opus-fft": "opus", adpcm: "ima" }[codec] ?? "wav"}`, out);
    results.push(stats);
  }
  return results;
}

if (isMainThread) {
  const argv = process.argv.slice(2);
  const opts = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
  const [wasmPath, inPath, outDir, ...jobs] = argv.filter((a) => !a.startsWith("--"));
  const workers = Number(opts.workers ?? 0);
  const bytes = readFileSync(wasmPath);
  const input = readFileSync(inPath);
  const t0 = performance.now();
  const module = await WebAssembly.compile(bytes);
  const compileMs = +(performance.now() - t0).toFixed(1);
  console.log(JSON.stringify({ host: "node", node: process.version, wasmBytes: bytes.length, compileMs }));
  if (!workers) {
    for (let r = 0; r < Number(opts.repeat ?? 1); r++) for (const s of await runJobs(module, input, jobs, outDir)) console.log(JSON.stringify(s));
  } else {
    const t1 = performance.now();
    const all = await Promise.all(
      Array.from({ length: workers }, () => new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { module, input, jobs } });
        w.once("message", resolve);
        w.once("error", reject);
      })),
    );
    const wall = performance.now() - t1;
    const audioS = all.flat().reduce((s, r) => s + r.seconds, 0);
    console.log(JSON.stringify({ workers, jobs, wallMs: +wall.toFixed(0), aggregateXRealtime: +((audioS * 1000) / wall).toFixed(1), perWorker: all.map((rs) => rs.map((r) => r.xRealtime)) }));
  }
} else {
  parentPort.postMessage(await runJobs(workerData.module, workerData.input, workerData.jobs, null));
}
