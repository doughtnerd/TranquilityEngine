// Chromium side of the speed benchmark: node bench-chromium.mjs [--runs N] [--only a,b] [--json]
import { startServer } from './lib/serve.mjs';
import { launchChromium } from './lib/browser.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const runs = +arg('--runs', 7);
const only = arg('--only', '');
const { server, port } = await startServer();
const { browser, via, playwrightVersion } = await launchChromium();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e));
  await page.goto(`http://127.0.0.1:${port}/bench.html?runs=${runs}${only ? '&only=' + only : ''}`);
  await page.waitForFunction(() => window.__ready);
  const res = await page.evaluate(() => window.__run());
  res.env = `Chromium ${browser.version()} (playwright ${playwrightVersion})`;
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(res));
  else for (const r of res.rows) console.log(r.name.padEnd(14), String(r.tris).padStart(7), Object.entries(r.timings).map(([k, v]) => `${k} ${v.p50.toFixed(1)}`).join('  '));
} finally { await browser.close(); server.close(); }
