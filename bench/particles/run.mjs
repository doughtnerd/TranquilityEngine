// Particle kernel parity check and benchmark (ADR 0094): `npm run bench:particles [-- --parity-only]`.
// Starts Vite on a free port, opens bench/particles/parity.html (JavaScript vs WebGPU vs WebGL2 on the
// same kernels) and bench/particles/index.html (frame time against particle count) in headless
// Chromium with WebGPU on SwiftShader, and prints the results. Exits non-zero when the executors disagree.
import { chromium } from "playwright";
import { createServer } from "vite";

const parityOnly = process.argv.includes("--parity-only");
// WebGPU on SwiftShader in headless Chromium; canvases present only with the Vulkan surface off.
const ARGS = ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--enable-features=Vulkan", "--disable-vulkan-surface", "--use-vulkan=swiftshader"];

const server = await createServer({ configFile: "vite.config.ts", server: { port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
// The project's Playwright browser (`npm run test:e2e:install`), or another Chromium through CHROMIUM_PATH.
const browser = await chromium.launch({ args: ARGS, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
let failed = false;
try {
  const page = await browser.newPage();
  await page.goto(`${base}bench/particles/parity.html`);
  await page.waitForFunction(() => window.__parity, null, { timeout: 300_000 });
  const parity = await page.evaluate(() => window.__parity);
  console.log("Parity (JavaScript vs GPU executors, 90 frames):");
  for (const r of parity) {
    const ok = !r.available || (r.errors.length === 0 && r.alive[0] === r.alive[1] && r.mismatched === 0 && r.maxError < 0.01);
    if (!ok) failed = true;
    console.log(`  ${r.backend.padEnd(7)} ${r.system.padEnd(10)} ${r.available ? `alive ${r.alive[0]}/${r.alive[1]}  max rel. error ${r.maxError.toExponential(2)}  ${ok ? "ok" : "MISMATCH"}` : "not available"}${r.errors.length ? `\n${r.errors.join("\n")}` : ""}`);
  }
  if (!parityOnly) {
    const runs = [
      ["webgpu", "gpu", "1000,10000,100000,1000000", ""],
      ["webgpu", "js", "1000,10000,100000", ""],
      ["webgpu", "cpu", "1000,10000,50000", ""],
      ["webgl2", "gpu", "1000,10000,100000", "&nodraw=1"],
      ["webgl2", "js", "1000,10000,100000", "&nodraw=1"],
      ["webgl2", "cpu", "1000,10000,50000", ""],
    ];
    console.log("\nFrame time (ms, simulation + draw; nodraw = simulation only):");
    for (const [engine, backend, counts, extra] of runs) {
      const p = await browser.newPage();
      await p.goto(`${base}bench/particles/index.html?engine=${engine}&backend=${backend}&counts=${counts}&frames=30${extra}`);
      await p.waitForFunction(() => window.__bench, null, { timeout: 900_000 });
      for (const r of await p.evaluate(() => window.__bench)) console.log(`  ${engine.padEnd(7)} ${backend.padEnd(4)} ${extra ? "nodraw" : "      "} ${String(r.particles).padStart(8)}  ${String(r.msPerFrame).padStart(8)} ms  (${r.executor})`);
      await p.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
