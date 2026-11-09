import { benchWasm } from "./bench.js";

const log = document.getElementById("log");
const print = (s) => { log.textContent += s + "\n"; };
const fetchBytes = async (name) => new Uint8Array(await (await fetch(`./wasm/${name}`)).arrayBuffer());

/** Everything the automated driver reads back. */
const results = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated };
window.spikeResults = results;

async function mainThreadBench() {
  for (const name of ["mixer.wasm", "mixer-simd.wasm"]) {
    try {
      const r = await benchWasm(await fetchBytes(name), () => performance.now());
      results[name] = r;
      print(`${name} (main thread, budget ${r.budgetMs} ms/quantum)`);
      for (const row of r.rows) print(`  logical ${String(row.logical).padStart(4)} real ${String(row.real).padStart(4)}: ${row.ms} ms (${row.budgetPct}%)`);
    } catch (e) {
      results[name] = { error: String(e) };
      print(`${name}: ${e}`);
    }
  }
}

/**
 * Proof that the wasm runs inside AudioWorkletGlobalScope, timed end to end: render 10 s offline through
 * the worklet and divide the wall time by the quanta. Includes Web Audio's own overhead.
 */
async function offlineWorkletBench(logical, real) {
  const sr = 48000, seconds = 10;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sr * seconds, sampleRate: sr });
  await ctx.audioWorklet.addModule("./processor.js");
  const wasm = await fetchBytes("mixer.wasm");
  const node = new AudioWorkletNode(ctx, "myco-mixer", { outputChannelCount: [2], processorOptions: { wasm, logical, real } });
  node.connect(ctx.destination);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const wall = performance.now() - t0;
  const ch = buf.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < ch.length; i += 7) sum += ch[i] * ch[i];
  const rms = Math.sqrt(sum / (ch.length / 7));
  const quanta = (sr * seconds) / 128;
  return { logical, real, msPerQuantum: +(wall / quanta).toFixed(4), budgetPct: +((wall / quanta) / (128 / sr * 1000) * 100).toFixed(1), rms: +rms.toFixed(4) };
}

async function offlineBench() {
  results.offlineWorklet = [];
  for (const [l, r] of [[64, 64], [256, 256], [1024, 1024], [4096, 512]]) {
    try {
      const row = await offlineWorkletBench(l, r);
      results.offlineWorklet.push(row);
      print(`offline worklet logical ${l} real ${r}: ${row.msPerQuantum} ms/quantum (${row.budgetPct}%), rms ${row.rms}`);
    } catch (e) {
      results.offlineWorklet.push({ logical: l, real: r, error: String(e) });
      print(`offline worklet ${l}/${r}: ${e}`);
    }
  }
}

/**
 * Start-up cost: main-thread async compile of modules of several sizes, AudioContext creation,
 * addModule, and node creation → processor ready (sync compile + instantiate inside the worklet).
 */
async function startupBench() {
  const modules = [
    ["mixer 55 KB", "./wasm/mixer.wasm"],
    ["spatial 406 KB", "./spatial/wasm/spatial-simd.wasm"],
    ["decode+fundsp 1.1 MB", "./decode/wasm/all-o3.wasm"],
  ];
  const rows = [];
  for (const [name, url] of modules) {
    const row = { name };
    try {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      row.kb = Math.round(bytes.length / 1024);
      let t = performance.now();
      await WebAssembly.compile(bytes);
      row.mainCompileMs = +(performance.now() - t).toFixed(1);
      t = performance.now();
      const ctx = new AudioContext({ latencyHint: "interactive" });
      row.contextMs = +(performance.now() - t).toFixed(1);
      t = performance.now();
      await ctx.audioWorklet.addModule("./processor.js");
      row.addModuleMs = +(performance.now() - t).toFixed(1);
      t = performance.now();
      // Port messages queue until onmessage is set, so the ready message can't be missed.
      const node = new AudioWorkletNode(ctx, "myco-mixer", { outputChannelCount: [2], processorOptions: { wasm: bytes, logical: 64, real: 64 } });
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ready message (context state ${ctx.state})`)), 5000);
        node.port.onmessage = (e) => { if (e.data.type === "ready") { clearTimeout(timer); resolve(e.data); } };
      });
      node.connect(ctx.destination);
      ctx.resume().catch(() => {});
      const msg = await ready;
      row.nodeToReadyMs = +(performance.now() - t).toFixed(1);
      row.workletCompileMs = msg.compileMs;
      row.contextState = ctx.state;
      await ctx.close();
    } catch (e) {
      row.error = String(e);
    }
    rows.push(row);
    print(`startup ${JSON.stringify(row)}`);
  }
  results.startup = rows;
}

let live = null;
async function playLive() {
  if (live) { await live.ctx.close(); live = null; print("stopped"); return; }
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("./processor.js");
  const logical = +document.getElementById("logical").value, real = +document.getElementById("real").value;
  const node = new AudioWorkletNode(ctx, "myco-mixer", { outputChannelCount: [2], processorOptions: { wasm: await fetchBytes("mixer.wasm"), logical, real } });
  node.port.onmessage = (e) => { if (e.data.type !== "tick") print(`worklet: ${JSON.stringify(e.data)}`); };
  node.connect(ctx.destination);
  live = { ctx, node };
  print(`playing ${logical} logical / ${real} real at ${ctx.sampleRate} Hz, base latency ${(ctx.baseLatency * 1000).toFixed(1)} ms, output latency ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms`);
  // outputLatency is only filled in once the device has run for a moment.
  setTimeout(() => {
    if (live?.ctx !== ctx) return;
    const ts = ctx.getOutputTimestamp?.();
    results.liveLatency = { baseMs: ctx.baseLatency * 1000, outputMs: (ctx.outputLatency || 0) * 1000, contextTime: ts?.contextTime, currentTime: ctx.currentTime };
    print(`after 2 s: base ${(ctx.baseLatency * 1000).toFixed(1)} ms, output ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms, currentTime - outputTimestamp ${(((ctx.currentTime - (ts?.contextTime ?? ctx.currentTime))) * 1000).toFixed(1)} ms`);
  }, 2000);
}

document.getElementById("play").onclick = playLive;
document.getElementById("run").onclick = async () => {
  results.done = false;
  log.textContent = "";
  print(navigator.userAgent);
  await mainThreadBench();
  await offlineBench();
  await startupBench();
  results.done = true;
  print("done");
};
