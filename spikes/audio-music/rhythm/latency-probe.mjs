// Reports AudioContext.baseLatency / outputLatency / getOutputTimestamp for each latencyHint in Playwright Chromium.
// No audio device in this container: Chromium falls back to a fake/null sink, so values describe that sink, not hardware.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto("about:blank");
const out = await page.evaluate(async () => {
  const hints = ["interactive", "balanced", "playback", 0.005, 0.02, 0];
  const rows = [];
  for (const h of hints) {
    try {
      const ctx = new AudioContext({ latencyHint: h });
      await ctx.resume().catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      rows.push({ hint: h, state: ctx.state, sr: ctx.sampleRate, baseLatencyMs: +(ctx.baseLatency * 1000).toFixed(3),
        outputLatencyMs: ctx.outputLatency === undefined ? "undefined" : +(ctx.outputLatency * 1000).toFixed(3),
        hasGetOutputTimestamp: typeof ctx.getOutputTimestamp === "function", ts: ts && { contextTime: ts.contextTime, performanceTime: ts.performanceTime },
        lagMs: ts ? +((ctx.currentTime - ts.contextTime) * 1000).toFixed(2) : null });
      await ctx.close();
    } catch (e) { rows.push({ hint: h, error: String(e) }); }
  }
  const perf = { res: (() => { let m = 1e9, p = performance.now(); for (let i = 0; i < 2e5; i++) { const n = performance.now(); if (n > p) { m = Math.min(m, n - p); p = n; } } return m * 1000; })(), crossOriginIsolated };
  return { rows, perf, ua: navigator.userAgent };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
