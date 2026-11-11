import { chromium } from '/home/user/TranquilityEngine/node_modules/playwright-core/index.mjs';
const flags = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', ...flags] });
const pg = await b.newPage();
await pg.goto('about:blank');
const r = await pg.evaluate(async () => {
  const c = new AudioContext({ latencyHint: 'interactive' });
  await c.resume();
  const t0 = performance.now(), c0 = c.currentTime;
  await new Promise(r => setTimeout(r, 2000));
  const ts = c.getOutputTimestamp();
  return { state: c.state, sr: c.sampleRate, base: c.baseLatency, out: c.outputLatency, dCtx: c.currentTime - c0, dWall: (performance.now() - t0) / 1000, ts: { c: ts.contextTime, p: ts.performanceTime }, now: performance.now() };
});
console.log(flags.join(' ') || '(none)', JSON.stringify(r));
await b.close();
