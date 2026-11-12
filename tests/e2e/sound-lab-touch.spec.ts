import { expect, type Page, test } from "./fixtures";
import { audioDebug, bootSample, FLAPPY, LAB, musicRows, readLate, watchConsole } from "./audioMusic";

// Task L2 (M4d): the last sample polish in the real browser. The Sound Lab's music and rhythm pages have on-screen
// buttons (a phone has no keys), the music page starts the eight-stem and A, B, C events itself, a pointer press on the
// rhythm page's view is a tap, a page can claim the keyboard from the main page's handlers, and Flappy's town music plays
// through a run, a game over and the restart without a restart of its own. Headless Chromium has no sound output: rows and
// counters are the proof. (The listening pass is audio-music-listening.spec.ts.)
test.describe.configure({ timeout: 120_000 });

const bar = (page: Page, key: string) => page.locator(`[data-touch-bar] button[data-key="${key}"]`);

/** Goes from the tour to a page through the tour's own buttons (the touch way). */
async function openPage(page: Page, key: "m" | "r"): Promise<void> {
  await bootSample(page, LAB);
  await bar(page, key).click();
}

test("L2: the tour's buttons open the music page, whose buttons start the eight-stem event and the A, B, C playlist", async ({ page }) => {
  const seen = watchConsole(page);
  await openPage(page, "m");
  await expect(bar(page, "4")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await musicRows(page)).some((r) => r.asset.includes("music-world") && r.state === "playing"), { timeout: 30_000, message: "the world switch starts with the page" }).toBe(true);

  await bar(page, "4").click();
  await expect.poll(async () => (await musicRows(page)).find((r) => r.asset.includes("music-stems8"))?.state, { timeout: 30_000 }).toBe("playing");
  const row = (await musicRows(page)).find((r) => r.asset.includes("music-stems8"))!;
  expect(row.stems, "eight stems").toHaveLength(8);
  expect(row.stems.filter((s) => s.streamed).map((s) => s.name).sort(), "the two melodies stream").toEqual(["melody-a", "melody-b"]);
  expect(row.groups.map((g) => ({ of: g.of, primed: g.primed }))).toEqual([{ of: 8, primed: 8 }]);
  expect((await musicRows(page)).some((r) => r.asset.includes("music-world")), "starting one event stops the one before").toBe(false);
  await page.waitForTimeout(2_000);

  await bar(page, "5").click();
  const order: string[] = [];
  await expect
    .poll(
      async () => {
        const r = (await musicRows(page)).find((x) => x.asset.includes("music-list3"));
        if (r?.segment && order[order.length - 1] !== r.segment) order.push(r.segment);
        return order.join("");
      },
      { timeout: 60_000, intervals: [100] },
    )
    .toBe("ABC");
  await bar(page, "d").click(); // the readout toggles without a problem
  await bar(page, "o").click();
  await expect.poll(async () => (await musicRows(page)).length, { timeout: 10_000 }).toBe(0);
  expect(await readLate(page)).toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("L2: on the rhythm page a press on the view is a tap, a press on a button is not", async ({ page }) => {
  const seen = watchConsole(page);
  await openPage(page, "r");
  await page.waitForFunction(() => !!(globalThis as unknown as { __rhythmLab?: unknown }).__rhythmLab, undefined, { timeout: 15_000 });
  const state = () => page.evaluate(() => (globalThis as unknown as { __rhythmLab: { state(): { mode: string; taps: number } } }).__rhythmLab.state());
  await bar(page, "c").click();
  await expect.poll(async () => (await state()).mode, { timeout: 15_000 }).toBe("calibrate");
  await expect.poll(async () => (await musicRows(page)).find((r) => r.segment === "click")?.state, { timeout: 30_000 }).toBe("playing");
  expect((await state()).taps).toBe(0);
  await page.mouse.click(480, 250); // the view
  await expect.poll(async () => (await state()).taps).toBe(1);
  await page.mouse.click(480, 250);
  await expect.poll(async () => (await state()).taps).toBe(2);
  await bar(page, "d").click(); // a button: not a tap
  await bar(page, "x").click();
  await page.waitForTimeout(500);
  expect((await state()).taps).toBe(2);
  await bar(page, "o").click();
  await expect.poll(async () => (await state()).mode).toBe("");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("L2: a page that claims the keyboard keeps the main page's handlers quiet", async ({ page }) => {
  await bootSample(page, LAB);
  await page.evaluate(() => {
    const g = globalThis as unknown as { __myco: { Audio: { playOneShot(clip: string, o?: object): unknown } }; __oneShots: string[] };
    g.__oneShots = [];
    const real = g.__myco.Audio.playOneShot.bind(g.__myco.Audio);
    g.__myco.Audio.playOneShot = (clip, o) => (g.__oneShots.push(clip), real(clip, o));
  });
  const played = () => page.evaluate(() => (globalThis as unknown as { __oneShots: string[] }).__oneShots.filter((c) => /click|beep|burst/.test(c)).length);
  const release = await page.evaluateHandle(() => (globalThis as unknown as { __soundLabKeys: { claim(): () => void } }).__soundLabKeys.claim());
  await page.keyboard.press("1");
  await page.keyboard.press("5");
  await page.waitForTimeout(500);
  expect(await played(), "claimed: 1 and 5 did nothing on the main page").toBe(0);
  await release.evaluate((fn) => (fn as () => void)());
  await page.keyboard.press("1");
  await expect.poll(played).toBe(2);
});

test("L2: Flappy's town music plays through a run, game over and the restart without a restart of its own; game over dips it", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, FLAPPY); // the unlocking click also starts the run
  await expect.poll(async () => (await musicRows(page)).find((r) => r.asset.includes("town"))?.state, { timeout: 60_000 }).toBe("playing");
  const id = (await musicRows(page)).find((r) => r.asset.includes("town"))!.id;
  const volume = () => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { volume: number } } } }).__myco.Audio.bus("Music").volume);
  const before = await volume();
  // The bird falls to the ground and dies: game over dips the Music bus.
  await expect.poll(volume, { timeout: 30_000, message: "the town music dips at game over" }).toBeLessThan(before * 0.5);
  expect((await musicRows(page)).find((r) => r.asset.includes("town"))?.id, "the same music instance, not restarted").toBe(id);
  await page.waitForTimeout(1_000); // the restart delay
  await page.mouse.click(480, 250); // the next run
  await expect.poll(volume, { timeout: 30_000, message: "the volume comes back with the next run" }).toBeCloseTo(before, 2);
  const row = (await musicRows(page)).find((r) => r.asset.includes("town"))!;
  expect(row.id, "the music went through the restart without one of its own").toBe(id);
  expect(row.state).toBe("playing");
  // M shows the readout (it is a Text; the numbers are Audio.debug().music, which the page reads).
  await page.keyboard.press("m");
  const d = (await audioDebug(page))!;
  expect(d.music?.some((r) => r.asset.includes("town"))).toBe(true);
  expect(await readLate(page)).toMatchObject({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0 });
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});
