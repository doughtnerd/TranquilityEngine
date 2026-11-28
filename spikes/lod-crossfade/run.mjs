// Runner: builds the page, serves it, runs every test (or those whose name starts with an argument) in headless
// Chromium (WebGL2 on SwiftShader) and prints the results as JSON.
// Usage: node spikes/lod-crossfade/run.mjs [testNamePrefix...]   (OUT=file.json to also save the JSON)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await import("./build.mjs");

const server = createServer((req, res) => {
  const f = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
  try {
    res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(join(here, "dist", f)));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
let executablePath;
try {
  const b = await chromium.launch({ args });
  await b.close();
} catch {
  const base = "/opt/pw-browsers";
  const dirs = readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const sub = readdirSync(join(base, d)).find((s) => s.startsWith("chrome-linux"));
    if (sub) {
      executablePath = join(base, d, sub, "chrome");
      break;
    }
  }
}
const browser = await chromium.launch({ executablePath, args });
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning" || process.env.VERBOSE) console.error(`[page ${m.type()}]`, m.text().slice(0, 500));
});
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 500)));
await page.goto(url);
await page.waitForFunction("window.ready === true");
const all = await page.evaluate("Object.keys(window.tests)");
const wanted = process.argv.length > 2 ? process.argv.slice(2) : all;
const results = {};
for (const name of all.filter((n) => wanted.some((w) => n.startsWith(w)))) {
  try {
    results[name] = await page.evaluate(`window.tests[${JSON.stringify(name)}]()`);
  } catch (e) {
    results[name] = { error: String(e).slice(0, 800) };
  }
}
const info = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return { webgl2: !!gl, renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?" };
});
const json = JSON.stringify({ info, results }, null, 1);
if (process.env.OUT) writeFileSync(process.env.OUT, json);
console.log(json);
await browser.close();
server.close();
