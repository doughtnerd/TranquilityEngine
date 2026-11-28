// Shared by run.mjs and dev.mjs: builds the page, serves it, and opens it in headless Chromium (WebGL2 on SwiftShader).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function openSpike() {
  await import("./build.mjs");
  const server = createServer((req, res) => {
    const f = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
    try {
      res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "text/html");
      // cross-origin isolation: performance.now() then has microsecond resolution instead of 0.1 ms
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
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
    for (const d of readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      const sub = readdirSync(join(base, d)).find((s) => s.startsWith("chrome-linux"));
      if (sub) { executablePath = join(base, d, sub, "chrome"); break; }
    }
  }
  const browser = await chromium.launch({ executablePath, args });
  /** A fresh page (fresh WebGL context and heap). */
  const newPage = async () => {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (["error", "warning"].includes(m.type()) || process.env.VERBOSE) console.error(`[page ${m.type()}]`, m.text().slice(0, 400));
    });
    page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 500)));
    await page.goto(url);
    await page.waitForFunction("window.ready === true");
    return page;
  };
  return { newPage, close: async () => { await browser.close(); server.close(); } };
}
