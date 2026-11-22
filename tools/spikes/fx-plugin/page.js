// Spike B0 (ADR 0338): the scratch page. Runs the benches on the main thread, then inside an AudioWorklet
// (processor.js), and leaves everything in window.spikeResults for run.mjs.
import { glueCost, fuelOverhead, compileTimes, faultIsolation, hasMultiMemory } from "./bench.js";

const NAMES = ["plain", "count32", "segment32", "loop32", "segment64", "loop64", "segload32", "loopload32", "host", "large", "largeSeg", "core", "coreBig", "huge", "scan", "mm"];
const log = (m) => {
  document.getElementById("log").textContent += `${m}\n`;
  console.log(m);
};

const R = { done: false };
window.spikeResults = R;

async function main() {
  const bins = {};
  for (const n of NAMES) bins[n] = new Uint8Array(await (await fetch(`bins/${n}.wasm`)).arrayBuffer());
  const now = () => performance.now();
  R.env = { userAgent: navigator.userAgent, multiMemory: hasMultiMemory(bins), crossOriginIsolated: self.crossOriginIsolated };

  // Synchronous compile of a module over 8 MB on the main thread (Chromium refuses those).
  try {
    const t0 = now();
    new WebAssembly.Module(bins.huge);
    R.env.mainSyncCompile9MB = `ok ${(now() - t0).toFixed(1)} ms`;
  } catch (e) {
    R.env.mainSyncCompile9MB = `refused: ${e.message}`;
  }

  log("main: glue");
  R.glue = glueCost(bins, now);
  log("main: fuel");
  R.fuel = fuelOverhead(bins, now);
  log("main: compile");
  R.compile = compileTimes(bins, now, { seed: 2 });
  log("main: faults");
  R.faults = ["wasmscan", ...(R.env.multiMemory ? ["multimemory"] : [])].map((s) => faultIsolation(bins, now, s));

  log("worklet");
  try {
    R.worklet = await inWorklet(bins);
  } catch (e) {
    R.worklet = { error: String(e) };
  }
  R.done = true;
  log("done");
}

async function inWorklet(bins) {
  const ctx = new AudioContext();
  const env = { state0: ctx.state };
  await ctx.audioWorklet.addModule("processor.js");
  // A compiled module in processorOptions: does the node's constructor accept it, and does it arrive?
  let viaOptions = "not tried";
  try {
    const probe = new AudioWorkletNode(ctx, "spike-b0", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { module: new WebAssembly.Module(bins.plain) } });
    viaOptions = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("no reply in 5 s"), 5000);
      probe.port.onmessage = (e) => {
        if (e.data.type === "options" || e.data.type === "module") {
          clearTimeout(t);
          resolve(e.data.result);
        }
      };
    });
  } catch (e) {
    viaOptions = `constructor threw: ${e.name}: ${e.message}`;
  }
  env.moduleViaProcessorOptions = viaOptions;
  const node = new AudioWorkletNode(ctx, "spike-b0", { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(ctx.destination);
  try {
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 2000))]);
  } catch {}
  env.state1 = ctx.state;
  const messages = [];
  const waitFor = (type, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`worklet: no ${type} in ${ms} ms`)), ms);
      const check = () => {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) {
          clearTimeout(t);
          resolve(messages.splice(i, 1)[0]);
        } else setTimeout(check, 50);
      };
      check();
    });
  node.port.onmessage = (e) => {
    if (e.data.type === "log") log(`worklet: ${e.data.msg}`);
    else messages.push(e.data);
  };

  // 1. Can a compiled WebAssembly.Module be posted to the worklet and instantiated there?
  let posted;
  try {
    node.port.postMessage({ type: "module", module: new WebAssembly.Module(bins.plain) });
    posted = (await waitFor("module", 10_000)).result;
  } catch (e) {
    posted = `postMessage refused: ${e.message}`;
  }
  // 2. The benches inside the worklet (bytes copied in; they compile there).
  node.port.postMessage({ type: "run", bins });
  const res = await waitFor("done", 900_000);
  await ctx.close();
  return { ...res.results, env: { ...env, ...res.results.env, postedModule: posted } };
}

main().catch((e) => {
  R.error = String(e?.stack ?? e);
  R.done = true;
});
