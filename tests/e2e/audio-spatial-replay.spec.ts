import { expect, type Page, test } from "./fixtures";
import { bootSample, LAB } from "./audioMusic";

// F-22: a spatial AudioSource played again stays spatial. The Sound Lab's spatial page, as the listening pass plays it:
// 0 silences the page, then 5 cycles the "Bed orbit" source (a level circle, a vertical one, off) twice. The second
// time round its clip is resident, so the core sends the PLAY at once; before the fix that PLAY went out without the
// spatial flag (the source gave its position only after starting), and the orbit played flat (the same in both ears)
// while `Audio.debug()` still showed it on HRTF. Headless Chromium has no sound output: the core's own HRTF and bed
// counts and the SFX bus's left and right peaks (the orbit is the only sound on it) stand in for ears.
test.describe.configure({ timeout: 150_000 });

type Debug = {
  voices: { clip: string; panner?: string }[];
  counters: { hrtfVoices: number; bedVoices: number };
  buses: { name: string; peakL: number; peakR: number }[];
};
const debug = (page: Page) => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { debug(): unknown } } }).__myco.Audio.debug() as Debug);
const orbit = (d: Debug) => d.voices.find((v) => v.clip.includes("orbit-pulse"));

/** A key press the game sees: held across a few frames, since input is snapshotted once per frame. */
async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
}

/**
 * The orbit's level circle for `ms` (it starts ahead and passes the right ear at 3 s): main's panner for it, the voices
 * the core pans through HRTF or the bed, and the largest left/right imbalance of the SFX bus.
 */
async function listen(page: Page, ms: number) {
  const panners = new Set<string>();
  let corePanned = Infinity;
  let imbalance = 1;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = await debug(page);
    const v = orbit(d);
    if (v) {
      panners.add(v.panner ?? "none");
      corePanned = Math.min(corePanned, d.counters.hrtfVoices + d.counters.bedVoices);
      const sfx = d.buses.find((b) => b.name === "SFX")!;
      if (Math.min(sfx.peakL, sfx.peakR) > 1e-4) imbalance = Math.max(imbalance, sfx.peakL / sfx.peakR, sfx.peakR / sfx.peakL);
    }
    await page.waitForTimeout(100);
  }
  return { panners: [...panners], corePanned, imbalance };
}

test("the Sound Lab's orbit stays spatial when it is cycled a second time", async ({ page }) => {
  await bootSample(page, LAB);
  await press(page, "s");
  await expect.poll(async () => (await debug(page)).voices.some((v) => v.clip.includes("radio-loop")), { timeout: 30_000 }).toBe(true);
  await page.mouse.click(480, 250); // focus for the keys
  await press(page, "0"); // the page's other sounds stop: the orbit is alone on the SFX bus
  await expect.poll(async () => (await debug(page)).voices.some((v) => v.clip.includes("radio-loop")), { timeout: 10_000 }).toBe(false);

  for (const cycle of [1, 2]) {
    await test.step(`cycle ${cycle}`, async () => {
      await press(page, "5"); // the level circle
      // Once its kernels are in (a quantum or two), main picks HRTF or the bed for it and the core pans it so.
      await expect
        .poll(async () => {
          const d = await debug(page);
          const p = orbit(d)?.panner;
          return (p === "hrtf" || p === "bed") && d.counters.hrtfVoices + d.counters.bedVoices >= 1;
        }, { timeout: 5_000 })
        .toBe(true);
      const heard = await listen(page, 3000);
      expect(heard.panners.every((p) => p === "hrtf" || p === "bed"), `main's panner: ${heard.panners}`).toBe(true);
      expect(heard.corePanned, "the core pans the orbit (HRTF or the bed)").toBeGreaterThanOrEqual(1);
      expect(heard.imbalance, "the orbit passing the right ear is louder on the right").toBeGreaterThan(1.25);
      await press(page, "5"); // the vertical circle
      await page.waitForTimeout(500);
      await press(page, "5"); // off
      await expect.poll(async () => orbit(await debug(page)) === undefined, { timeout: 10_000 }).toBe(true);
    });
  }
});
