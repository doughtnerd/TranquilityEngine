import { expect, test } from "./fixtures";
import { bootMix, installFrameClock, mixDebug, sampleBusGain } from "./audioMix";

// M5 smoke (ADR 0171 amended by 0172, plan task S0, H6): the milestone path in the real editor app, through the Sound Lab
// sample, one case per milestone, grown by later waves (each owning task un-fixmes its case in its own wave).
// Today's live case is the bus behaviour M5-0 builds on: the buses exist, a bus's effective gain is the product of its tree,
// and a scripted `fadeTo` (the Sound Lab's Buses page, `scripts/behaviors/Buses.ts`) moves a bus's gain over time, measured
// on the audio clock (the core's rendered frames), never a wall-clock tolerance (ground rules, "Test rules").

test.describe.configure({ timeout: 120_000 });

test("M5 smoke (today): the buses exist, effective gain is the tree's product, and a fadeTo moves the gain over audio frames", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await bootMix(page);
  await installFrameClock(page);

  await test.step("the project's buses exist in the API and in Audio.debug()", async () => {
    const d = (await mixDebug(page))!;
    const names = d.buses.map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(["Master", "Music", "SFX", "Ambience", "UI", "Engine"]));
    const api = await page.evaluate(() => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { buses: readonly string[]; bus(n: string): { exists: boolean } } } }).__myco;
      return { buses: [...Audio.buses], music: Audio.bus("Music").exists, nope: Audio.bus("NoSuchBus").exists };
    });
    expect(api.buses).toEqual(expect.arrayContaining(["Master", "Music", "Engine"]));
    expect(api.music).toBe(true);
    expect(api.nope).toBe(false);
  });

  await test.step("a bus's effective gain reads the product of its tree", async () => {
    // Authored in project.json: Music 0.6 and Engine 0.8, both under Master 1.
    const read = () =>
      page.evaluate(() => {
        const { Audio } = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { effectiveGain: number; volume: number }; debug(): { buses: { name: string; effectiveGain: number }[] } } } }).__myco;
        const row = (n: string) => Audio.debug().buses.find((b) => b.name === n)!.effectiveGain;
        return { music: Audio.bus("Music").effectiveGain, engine: Audio.bus("Engine").effectiveGain, musicRow: row("Music"), engineRow: row("Engine"), master: Audio.bus("Master").effectiveGain };
      });
    const before = await read();
    expect(before.master).toBeCloseTo(1, 6);
    expect(before.music).toBeCloseTo(0.6, 6);
    expect(before.engine).toBeCloseTo(0.8, 6);
    expect(before.musicRow).toBeCloseTo(0.6, 6);
    expect(before.engineRow).toBeCloseTo(0.8, 6);
    // Halving the parent halves every child: the product of the tree, in the API and the debug rows alike.
    await page.evaluate(() => ((globalThis as unknown as { __myco: { Audio: { bus(n: string): { volume: number } } } }).__myco.Audio.bus("Master").volume = 0.5));
    const halved = await read();
    expect(halved.master).toBeCloseTo(0.5, 6);
    expect(halved.music).toBeCloseTo(0.3, 6);
    expect(halved.engine).toBeCloseTo(0.4, 6);
    expect(halved.musicRow).toBeCloseTo(0.3, 6);
    expect(halved.engineRow).toBeCloseTo(0.4, 6);
    await page.evaluate(() => ((globalThis as unknown as { __myco: { Audio: { bus(n: string): { volume: number } } } }).__myco.Audio.bus("Master").volume = 1));
    expect((await read()).music).toBeCloseTo(0.6, 6);
  });

  await test.step("a scripted fadeTo moves the gain over audio frames", async () => {
    // The Buses page's key 3: `Audio.bus("Music").fadeTo(0.25, 0.5)`. Since M5's authored/runtime split (Mx1) `volume` is a
    // multiplier on the authored 0.6, so the bus is heard at 0.6 × 0.25 = 0.15, today's level. Sampled with the core's
    // rendered frame on each read.
    const samples = await sampleBusGain(page, "Music", 0.15, 96_000 * 4, `Audio.bus("Music").fadeTo(0.25, 0.5)`);
    const rate = (await mixDebug(page))!.sampleRate;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    expect(first.gain).toBeCloseTo(0.6, 6);
    expect(first.frame, "the frame clock is the core's, and runs").toBeGreaterThan(0);
    expect(last.gain, "the fade lands on its target").toBeCloseTo(0.15, 4);
    expect(last.frame - first.frame, "the audio clock ran between the first and last reading").toBeGreaterThan(0);
    // Monotone, in the API and in the debug row, with the frame never going back.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.frame).toBeGreaterThanOrEqual(samples[i - 1]!.frame);
      expect(samples[i]!.gain).toBeLessThanOrEqual(samples[i - 1]!.gain + 1e-9);
      expect(samples[i]!.debugGain).toBeCloseTo(samples[i]!.gain, 6);
    }
    // It moved over time, not in one step: some reading lies strictly between start and target.
    expect(samples.some((s) => s.gain < 0.6 - 1e-3 && s.gain > 0.15 + 1e-3), "an intermediate gain was read").toBe(true);
    // A half-second fade cannot finish sooner than its length on the audio clock: from the first reading below the start to the first at the target.
    const left = samples.find((s) => s.gain < 0.6 - 1e-6)!;
    const landed = samples.find((s) => Math.abs(s.gain - 0.15) < 1e-4)!;
    // Measured on `Audio.time` (the heard clock the fade runs on): since the stamped lanes (Mx2) nothing is sent while a
    // fade runs, so STATUS idles at 48 quanta and its frame is too coarse for this bound.
    expect((landed.time - left.time) * rate, "the fade takes about its 0.5 s of audio frames").toBeGreaterThanOrEqual(0.4 * rate);
    // Back up, as the page's key 3 does on its second press: the multiplier returns to 1, heard at the authored 0.6.
    await page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { fadeTo(v: number, s: number): void } } } }).__myco.Audio.bus("Music").fadeTo(1, 0.5));
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { effectiveGain: number } } } }).__myco.Audio.bus("Music").effectiveGain), { timeout: 15_000 }).toBeCloseTo(0.6, 4);
    expect((await mixDebug(page))!.status).toBe("running");
    expect(errors).toEqual([]);
  });
});

// M5-0 (Mx2, then Dp1): the stamped bus path. Owners un-fixme in their wave: Mx2 (W3) the fade case, Dp1 (W4) the duck case.
// The exact first-moving sample is asserted on the loopback host (`laneWriterLoopback.test.ts`); here, the shipped page.
test("M5-0 smoke: a fade lands through the lanes on its stamp", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await bootMix(page);
  await installFrameClock(page);
  type Row = { name: string; effectiveGain: number; lastRampStartFrame?: number };
  type Dbg = MixDebugM5 & { buses: Row[] };
  type MixDebugM5 = { sampleRate: number; musicTotals?: { splitQuanta: number } };
  const read = () =>
    page.evaluate(() => {
      const g = globalThis as unknown as { __myco: { Audio: { debug(): unknown; bus(n: string): { effectiveGain: number } } }; __mixFrame: () => { frame: number } };
      const d = g.__myco.Audio.debug() as Dbg;
      return { frame: g.__mixFrame().frame, gain: g.__myco.Audio.bus("Music").effectiveGain, row: d.buses.find((b) => b.name === "Music")!, split: d.musicTotals?.splitQuanta ?? 0, rate: d.sampleRate };
    });
  const before = await read();
  expect(before.gain).toBeCloseTo(0.6, 6);
  // 1. The Buses page's fade (key 3), from a script: one BUS_RAMP on Music's runtime lane, stamped ahead of the core's frame.
  const called = await page.evaluate(() => {
    const g = globalThis as unknown as { __myco: { Audio: { bus(n: string): { fadeTo(v: number, s: number): void } } }; __mixFrame: () => { frame: number } };
    const frame = g.__mixFrame().frame;
    g.__myco.Audio.bus("Music").fadeTo(0.25, 0.5);
    return frame;
  });
  await expect.poll(async () => (await read()).row.lastRampStartFrame, { timeout: 15_000 }).toBeGreaterThan(0);
  const stamp = (await read()).row.lastRampStartFrame!;
  expect(stamp, "stamped ahead of the core's frame at the call").toBeGreaterThan(called);
  expect(stamp - called, "within the lookahead and the clock's lead (well under 0.5 s)").toBeLessThan(0.5 * before.rate);
  // 2. On the audio clock: once the core has rendered past stamp + 0.5 s, the fade has landed on 0.6 x 0.25.
  const end = stamp + Math.round(0.5 * before.rate);
  await expect.poll(async () => (await read()).frame, { timeout: 15_000 }).toBeGreaterThan(end);
  const landed = await read();
  expect(landed.gain, "landed on its target by stamp + duration").toBeCloseTo(0.15, 4);
  expect(landed.row.effectiveGain).toBeCloseTo(0.15, 4);
  expect(landed.row.lastRampStartFrame, "one stamp: nothing re-sent while it ran").toBe(stamp);
  // 3. Applied as a stamp: no quantum split. (Lateness isn't asserted here: a headless page whose main thread stalls past
  // the lookahead can deliver any stamped record late; the loopback case asserts it on a deterministic clock.)
  expect(landed.split).toBe(0);
  // Back up (the key's second press).
  await page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { fadeTo(v: number, s: number): void } } } }).__myco.Audio.bus("Music").fadeTo(1, 0.5));
  await expect.poll(async () => (await read()).gain, { timeout: 15_000 }).toBeCloseTo(0.6, 4);
  expect((await read()).row.lastRampStartFrame).toBeGreaterThan(stamp);
  expect(errors).toEqual([]);
});

test.fixme("M5-0 smoke: a presence duck starts on its stamped frame", async ({ page }) => {
  await bootMix(page);
  await installFrameClock(page);
  // Dp1:
  //  1. Play a voice on a bus with a presence duck rule (a trigger bus, ADR 0172) and read the duck's start frame in
  //     the debug rows: the duck starts on the frame its trigger voice was stamped to, `splitQuanta` still 0.
  void page;
});

// M5a (Rc4): capture. Owner un-fixmes in W7.
test.fixme("M5a smoke: a capture starts, stops, is saved and is non-empty", async ({ page }) => {
  await bootMix(page);
  // Rc4:
  //  1. Start a capture (the recorder's start, through `Audio.capture` or the editor's record control).
  //  2. Let the audio clock advance (frames, not a wall-clock wait), play a one-shot so the capture has content.
  //  3. Stop the capture and save it: the result is a file in the project with a non-zero length and a header that parses.
  void page;
});

// M5b (E2): loudness. Owner un-fixmes in W8.
test.fixme("M5b smoke: master's momentary loudness reads a number", async ({ page }) => {
  await bootMix(page);
  // E2:
  //  1. Play the Sound Lab's music loop so master carries signal.
  //  2. Read master's momentary loudness (LUFS) from `Audio.debug()`'s bus row: a finite number, not null or -Infinity.
  //  3. It is about the same on a repeat read after more audio frames (a steady loop), and null/silent while nothing plays.
  void page;
});

// M5c (E3): live edit. Owner un-fixmes in W9.
test.fixme("M5c smoke: a live edit in Play is heard and kept after Stop", async ({ page }) => {
  await bootMix(page);
  // E3:
  //  1. In Play, edit a bus's volume through the mixer panel's live edit; read the new effective gain in `Audio.debug()` and the bus's peak change.
  //  2. Press Stop: the edit is kept in the project settings (not reverted to the authored value).
  //  3. Play again: the bus starts at the edited value.
  void page;
});

// M5d (X3): the milestone's last case. Owner un-fixmes in W10.
test.fixme("M5d smoke: X3's end-to-end step", async ({ page }) => {
  await bootMix(page);
  // X3:
  //  1. Steps are named by the X3 task (the export/profiler/mixer-panel path of M5d); this case is a placeholder until then.
  void page;
});
