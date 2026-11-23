// Spike B0 (ADR 0352): drives every measurement. Node (V8) first, then a scratch page in each Playwright browser
// that is installed (main thread and inside an AudioWorkletGlobalScope), served from memory on E2E_PORT (default
// 4391; no COOP/COEP). Never touches the e2e suite.
// Usage (from the repository root): node tools/spikes/fx-plugin/run.mjs [--node-only] [--only glue,fuel,compile,faults] [--out FILE]
// Playwright is resolved from the repository's node_modules (or NODE_PATH).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";
import { fuel } from "./fuel.mjs";
import { largeModule, scanModule, multiMemoryModule } from "./genwasm.js";
import { glueCost, fuelOverhead, compileTimes, faultIsolation, hasMultiMemory } from "./bench.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const args = process.argv.slice(2);
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

const plain = readFileSync(join(here, "wasm", "fx_plugin.wasm"));
const large = Buffer.from(largeModule(100_000, 1));
const bins = {
  plain,
  count32: fuel(plain, { mode: "count", width: 32 }).bytes,
  segment32: fuel(plain, { mode: "segment", width: 32 }).bytes,
  loop32: fuel(plain, { mode: "loop", width: 32 }).bytes,
  segment64: fuel(plain, { mode: "segment", width: 64 }).bytes,
  loop64: fuel(plain, { mode: "loop", width: 64 }).bytes,
  segload32: fuel(plain, { mode: "segment", width: 32, check: "load" }).bytes,
  loopload32: fuel(plain, { mode: "loop", width: 32, check: "load" }).bytes,
  host: readFileSync(join(here, "wasm", "fx_host.wasm")),
  large,
  largeSeg: fuel(large, { mode: "segment", width: 32 }).bytes,
  core: readFileSync(join(repo, "src", "plugins", "audio", "runtime", "wasm", "myco_audio.wasm")),
  huge: Buffer.from(largeModule(9_000_000, 3)), // over Chromium's 8 MB main-thread sync-compile limit
  scan: Buffer.from(scanModule()),
  mm: Buffer.from(multiMemoryModule()),
  coreBig: readFileSync(join(repo, "src", "plugins", "audio", "runtime", "wasm", "myco_audio_decode_aac.wasm")),
};
const staticStats = {};
for (const [k, mode] of [["segment32", "segment"], ["loop32", "loop"]]) staticStats[k] = { bytes: bins[k].length, ...fuel(plain, { mode }).stats };
staticStats.plain = { bytes: plain.length };
staticStats.large = { bytes: large.length, segBytes: bins.largeSeg.length };
const coreSeg = fuel(bins.core, { mode: "segment" });
staticStats.coreFuelSegment = { bytes: bins.core.length, instrumentedBytes: coreSeg.bytes.length, ...coreSeg.stats };

const results = {
  machine: {
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    loadavg: os.loadavg(),
    node: process.version,
    v8: process.versions.v8,
  },
  static: staticStats,
};

const now = () => performance.now();
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const want = (k) => only === null || only.includes(k);
results.node = {};
if (want("glue")) {
  console.error("node: glue");
  results.node.glue = glueCost(bins, now);
}
if (want("fuel")) {
  console.error("node: fuel");
  results.node.fuel = fuelOverhead(bins, now);
}
if (want("compile")) {
  console.error("node: compile");
  results.node.compile = compileTimes(bins, now);
}
if (want("faults")) {
  console.error("node: faults");
  results.node.faults = ["loop", "wasmscan", ...(hasMultiMemory(bins) ? ["multimemory"] : [])].map((s) => faultIsolation(bins, now, s));
}

if (!args.includes("--node-only")) {
  const require = createRequire(join(repo, "package.json"));
  let pw;
  try {
    pw = require(require.resolve("playwright", { paths: [repo, join(repo, "..", "..", ".."), ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean)] }));
  } catch (e) {
    results.browsers = { error: `playwright not found: ${e.message}` };
  }
  if (pw) {
    const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.startsWith("/bins/")) {
        const b = bins[path.slice(6).replace(/\.wasm$/, "")];
        if (b) return res.writeHead(200, { "Content-Type": "application/wasm" }).end(b);
      }
      const file = join(here, path === "/" ? "index.html" : path.slice(1));
      if (!file.startsWith(here) || !existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    });
    const port = Number(process.env.E2E_PORT ?? 4391);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const url = `http://127.0.0.1:${port}/`;
    const launch = {
      chromium: { args: ["--autoplay-policy=no-user-gesture-required"] },
      webkit: {},
      firefox: { firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 } },
    };
    results.browsers = {};
    for (const name of ["chromium", "webkit", "firefox"]) {
      let browser;
      try {
        browser = await pw[name].launch(launch[name]);
      } catch (e) {
        // A browser build other than the one this Playwright expects may be installed (e.g. chromium-1243 for 1.64.1).
        const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
        const other = dir && existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith(`${name}-`)).sort().pop() : null;
        const exe = other ? { chromium: "chrome-linux64/chrome", firefox: "firefox/firefox", webkit: "pw_run.sh" }[name] : null;
        if (other && existsSync(join(dir, other, exe))) {
          try {
            browser = await pw[name].launch({ ...launch[name], executablePath: join(dir, other, exe) });
          } catch (e2) {
            results.browsers[name] = { error: `launch ${other}: ${String(e2.message).split("\n")[0]}` };
            continue;
          }
        } else {
          results.browsers[name] = { error: `launch: ${String(e.message).split("\n")[0]}` };
          continue;
        }
      }
      try {
        const page = await browser.newPage();
        page.on("console", (m) => console.error(`[${name}] ${m.text()}`));
        page.on("pageerror", (e) => console.error(`[${name}] pageerror ${e.message}`));
        await page.goto(url);
        await page.waitForFunction(() => window.spikeResults?.done === true, null, { timeout: 900_000, polling: 1000 });
        results.browsers[name] = { version: browser.version(), ...(await page.evaluate(() => window.spikeResults)) };
      } catch (e) {
        results.browsers[name] = { version: browser.version(), error: String(e).slice(0, 500) };
      } finally {
        await browser.close();
      }
    }
    server.close();
  }
}

const json = JSON.stringify(results, (k, v) => (typeof v === "bigint" ? Number(v) : v), 1);
if (outFile) writeFileSync(outFile, json);
console.log(json);
