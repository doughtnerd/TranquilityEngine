import { expect, type Page, play, test } from "./fixtures";

// M4 smoke (ADR 0166/0167, plan task S0): the milestone's path in the real app, through the Sound Lab sample. One playing
// voice gets a fade (a stamped FADE record) and a spatial one-shot with sends and non-default effects is played at a future
// audio-clock time (a stamped PLAY, with its SET_VOICE_FX at the same frame, coreBackend.ts "its SET_VOICE_FX at the same
// frame"). Both split the quantum today. The spec asserts the sound path worked as far as `Audio.debug()` shows, and records
// `splitQuanta` as an annotation. Later waves grow this file by one case each.
const LAB = "/editor.html?sample=sound-lab";

test.describe.configure({ timeout: 120_000 });

type Voice = { id: number; clip: string; bus: string; state: string; gain: number; filter?: { lowpassHz: number; highpassHz: number }; sends?: unknown[]; panner?: unknown };
type Debug = {
  status: string;
  counters: { underruns: number };
  voices: Voice[];
  core: Record<string, number | string | boolean> & { splitQuanta?: number };
  musicTotals?: { splitQuanta?: number };
};
type Api = { Audio: { debug(): unknown; time: number; play(e: string, o?: object): { playing: boolean; fade(to: number, s: number): void }; playOneShot(clip: string, o?: object): unknown } };

const audioDebug = (page: Page) => page.evaluate(() => ((globalThis as unknown as { __myco?: Api }).__myco?.Audio.debug() as Debug | undefined) ?? null);
const voice = async (page: Page, clip: string) => (await audioDebug(page))?.voices.find((v) => v.clip.includes(clip));

/** The highest peak of a bus's meter over `ms` in the page (one reading can land in a quiet part of the clip). */
const peakOver = (page: Page, bus: string, ms = 300) =>
  page.evaluate(
    async ([name, span]) => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { peak: number } } } }).__myco;
      let max = 0;
      const start = performance.now();
      while (performance.now() - start < (span as number)) {
        max = Math.max(max, Audio.bus(name as string).peak);
        await new Promise((r) => setTimeout(r, 10));
      }
      return max;
    },
    [bus, ms] as const,
  );

/** `splitQuanta` where the debug output reports it (M4's totals, else the core group), or null while it is not reported. */
const readSplitQuanta = (d: Debug): number | null => d.musicTotals?.splitQuanta ?? (typeof d.core.splitQuanta === "number" ? d.core.splitQuanta : null);

test("M4 smoke: a stamped fade and a stamped spatial play with sends in the Sound Lab", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(LAB);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await play(page);
  await page.mouse.click(480, 250); // the user gesture that unlocks the context

  await expect.poll(async () => (await audioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
  expect((await audioDebug(page))!.core.backend).toBe("core");
  await expect.poll(async () => (await voice(page, "music-loop"))?.state, { timeout: 30_000 }).toBe("playing");
  const base = (await audioDebug(page))!;
  const splitBefore = readSplitQuanta(base);

  await test.step("a fade on one playing voice takes effect", async () => {
    // A sustained looping event, so the voice is still there when the fade has run; a fade on its handle is a stamped FADE.
    await page.evaluate(() => {
      const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
      const h = Audio.play("audio/events/engine-single.audioevent.json", { bus: "Engine" });
      (globalThis as unknown as { __smokeFade: typeof h }).__smokeFade = h;
    });
    await expect.poll(async () => (await voice(page, "engine-single"))?.state, { timeout: 20_000 }).toBe("playing");
    // The voice row's gain is main's own; the core applies the fade, so the Engine bus meter is what shows it.
    await expect.poll(() => peakOver(page, "Engine"), { timeout: 15_000, message: "the voice is audible on its bus" }).toBeGreaterThan(0.01);
    const before = await peakOver(page, "Engine");
    await page.evaluate(() => (globalThis as unknown as { __smokeFade: { fade(to: number, s: number): void } }).__smokeFade.fade(0, 0.3));
    await expect.poll(() => peakOver(page, "Engine"), { timeout: 15_000, message: "the fade silences the bus" }).toBeLessThan(before * 0.1);
    expect(["playing", "virtual"], "a silent voice stays listed, virtualized by selection").toContain((await voice(page, "engine-single"))?.state);
    // The other voice is unaffected by it.
    expect((await voice(page, "music-loop"))?.state).toBe("playing");
  });

  await test.step("a stamped spatial play with sends and non-default effects plays", async () => {
    // `at` ahead of the audio clock stamps the PLAY; the low-pass, high-pass and send are non-default per-voice effects.
    await page.evaluate(() => {
      const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
      Audio.playOneShot("audio/noise-loop.wav", { bus: "SFX", volume: 0.5, position: [3, 0, 0], at: Audio.time + 0.3, reverbSend: 0.7, lowpass: 3000, highpass: 120 });
    });
    await expect.poll(async () => (await voice(page, "noise-loop"))?.state, { timeout: 20_000 }).toBe("playing");
    const v = (await voice(page, "noise-loop"))!;
    expect(v.panner, "spatial voice has a panner").toBeTruthy();
    expect(v.filter?.lowpassHz ?? 24_000, "low-pass reaches the voice row").toBeLessThanOrEqual(3000);
    expect(v.filter?.highpassHz ?? 0, "high-pass reaches the voice row").toBeGreaterThan(20);
  });

  await test.step("splitQuanta is recorded", async () => {
    const after = (await audioDebug(page))!;
    const split = readSplitQuanta(after);
    info.annotations.push({ type: "splitQuanta", description: split === null ? "not reported yet" : `${split} (before the plays: ${splitBefore})` });
    // TODO(Z3, in-voice flip): the stamped records apply inside their voices, so replace this with
    // `expect(split).toBe(0)` (and fail on null). Until the counter exists, nothing is asserted about it.
    if (split !== null) expect(split).toBeGreaterThanOrEqual(0);
    expect(errors).toEqual([]);
    expect(after.status).toBe("running");
  });
});
