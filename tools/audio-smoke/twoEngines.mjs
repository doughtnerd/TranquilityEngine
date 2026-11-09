// Opens twoEngines.html in Chromium (Playwright) against a running dev server: PORT=3107 node tools/audio-smoke/twoEngines.mjs
import { chromium } from "@playwright/test";
const port = process.env.PORT ?? "3107";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("console:", m.type(), m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://localhost:${port}/tools/audio-smoke/twoEngines.html`);
const result = await page.waitForFunction(() => window.__result, null, { timeout: 30000 }).then((h) => h.jsonValue());
console.log(JSON.stringify(result));
await browser.close();
