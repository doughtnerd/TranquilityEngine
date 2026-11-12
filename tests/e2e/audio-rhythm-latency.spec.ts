import { expect, type Page, test } from "./fixtures";
import { bootSample, LAB } from "./audioMusic";

// ADR 0166 Rh1 (architecture §4.6): rhythm mode's `latencyHint: 0` takes effect in a real browser. The Sound Lab boots
// twice in one page, with `audio.rhythmMode` off and then on (the project file rewritten on the way in), and
// `Audio.latency` is read back from the running core's context each time: rhythm mode's base and output latency are
// below the `"interactive"` ones (S5 measured 2.9 / 8 ms against 10 / 32 ms on Chromium's fake sink). Headless Chromium
// has no real device, so only the order is asserted; the figures are printed for the build log.

test.describe.configure({ timeout: 150_000 });

type Latency = { base: number; output: number; limiter: number; total: number; reliable: boolean };
type Api = { Audio: { latency: Latency; rhythmMode: boolean } };

/** `Audio.latency` once the context has rendered a while (the output figure can start at 0). */
async function settledLatency(page: Page): Promise<{ latency: Latency; rhythmMode: boolean }> {
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.latency.output), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
    return { latency: Audio.latency, rhythmMode: Audio.rhythmMode };
  });
}

test("rhythm mode: the context is made with latencyHint 0 and Audio.latency reads lower", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  let rhythmMode = false;
  await page.route("**/samples/sound-lab/project.json", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.audio = { ...(json.audio ?? {}), rhythmMode };
    await route.fulfill({ response: res, json });
  });
  const read: { latency: Latency; rhythmMode: boolean }[] = [];
  for (const mode of [false, true]) {
    rhythmMode = mode;
    await bootSample(page, LAB); // a fresh page load: a new host and context
    read.push(await settledLatency(page));
  }
  expect(errors).toEqual([]);
  const [off, on] = read as [(typeof read)[0], (typeof read)[0]];
  expect(off.rhythmMode).toBe(false);
  expect(on.rhythmMode).toBe(true);
  for (const r of [off, on]) {
    expect(r.latency.total).toBeCloseTo(r.latency.base + r.latency.output + r.latency.limiter, 9);
    expect(r.latency.limiter).toBeGreaterThan(0);
  }
  expect(on.latency.base).toBeLessThan(off.latency.base);
  expect(on.latency.output).toBeLessThan(off.latency.output);
  const ms = (x: number) => (x * 1000).toFixed(2);
  const line = (l: Latency) => `base ${ms(l.base)} output ${ms(l.output)} limiter ${ms(l.limiter)} total ${ms(l.total)} ms, reliable ${l.reliable}`;
  console.log(`[Rh1 latency] interactive: ${line(off.latency)}; rhythm (hint 0): ${line(on.latency)}`);
});
