// Dev helper: node dev.mjs <testName> '<json args array>'  -> prints the result JSON once (raw sample arrays dropped).
import { openSpike } from "./browser.mjs";
const spike = await openSpike();
const page = await spike.newPage();
const [name, a] = process.argv.slice(2);
const t = Date.now();
const r = await page.evaluate(([n, aa]) => window.tests[n](...aa), [name, a ? JSON.parse(a) : []]);
if (r && r.png) { (await import("node:fs")).writeFileSync(process.env.PNG ?? "/tmp/claude-0/shot.png", Buffer.from(r.png.split(",")[1], "base64")); }
console.log(JSON.stringify(r, (k, v) => (k === "raw" || k === "png" ? undefined : v), 1), "\nms", Date.now() - t);
await spike.close();
