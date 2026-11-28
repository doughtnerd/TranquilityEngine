// Launch Chromium via Playwright. `require('playwright')` resolves to the repo's version, whose pinned browser build may not be
// installed on this machine; fall back to any other playwright whose default chromium launches with no options.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function launchChromium() {
  const candidates = ['playwright', '/opt/node-tools/node_modules/playwright'];
  let lastErr;
  for (const c of candidates) {
    try {
      const { chromium } = require(c);
      const browser = await chromium.launch(); // no options
      return { browser, via: c, playwrightVersion: require(c + '/package.json').version };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
