import { expect, test, type Page } from "./fixtures";
import { bootMix } from "./audioMix";

// M5b loudness in the real editor app (ADR 0171 amended by 0172, task E2): the Sound Lab's loudness page (keys L, W, C, F, V, D;
// `scripts/behaviors/Loudness.ts`) plays the project's reference (`audio/loudness-reference.wav`, the EBU Tech 3341 case 1
// signal: a 1 kHz sine at -23 dBFS on both channels, on the metered UI bus) and the readings come from the public API
// (`Audio.bus(n).loudness`, `Audio.loudnessTarget`) and `Audio.debug().mix`.
//
// Cases: a tone reads -22.99 LUFS in Play; the target verdict for every target and a hot signal (high, low, ok, waiting,
// peak over); every reset option; pause and resume (by the F key and the API); the taint rules of the Mixer panel's monitor
// mute, solo and Compare; the ladder's loudness step as the STATUS flag reaches the meters.
//
// **Timing is on the audio clock**: a reading waits on the meter's own `elapsed` (seconds of metered audio since its last reset,
// counted in the core's rendered sub-blocks) or on `Audio.time`, never on a wall-clock span; the polls only pace the reads.
// **Seams:** the Mixer panel (Mp2b) lands in parallel, so a monitor control is made as the panel's `monitorModel.ts` makes it
// (`mixer.setMonitor`, then the hub's `noteMonitorMute` or `noteMonitorSolo`, then `setMonitorActive`), through the core backend
// the page already holds. A real ladder step needs the adaptive cap at its floor and seconds of underruns, which a headless page
// can't be made to have on demand: the ladder case sets the STATUS block's `loudShed` as the core reports it (the core's side,
// the step order and the give-back, is `ladderRecoveryLoopback.test.ts` and `audio-core`'s tests).

test.describe.configure({ timeout: 120_000 });

/** EBU Tech 3341 case 1: -23 dBFS 1 kHz stereo reads -22.99 LUFS (spike S1: -22.993; the standard's tolerance is +/- 0.1 LU). */
const TONE_LUFS = -22.99;
const TONE_TOLERANCE = 0.1;

type Target = { name: string; integrated: number; tolerance: number; truePeak: number; deviation: number; state: string; peakOver: boolean };
type Reading = {
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  maxTruePeak: number;
  maxMomentary: number;
  elapsed: number;
  metered: boolean;
  paused: boolean;
  pausedBy: string | null;
  incomplete: boolean;
  tainted: boolean;
  truePeakBound: string;
  target: Target | null;
};
type Loud = { [K in keyof Reading]: Reading[K] } & { reset(what?: string): void; pause(): void; resume(): void };
type Hub = { noteMonitorMute(bus: string): void; noteMonitorSolo(): void; setMonitorActive(on: boolean): void; setCompare(on: boolean): void; feed(s: { loudShed: number }): void };
type Backend = { loudness: Hub; mixer: { setMonitor(bus: string, c: { mute?: boolean; solo?: boolean }): void }; mirror: { loudShed: number } };
type Debug = { status: string; counters: { underruns: number }; voices: { clip: string; bus: string; state: string }[]; mix: { metersPaused: number; loudnessLadderStep: number; monitorActive: boolean } };
type Api = {
  __myco: { Audio: { time: number; loudnessTarget: string | null; debug(): Debug; bus(n: string): { loudness: Loud; mute: boolean }; playOneShot(c: string, o?: object): { voice?: { backend?: Backend; inner?: { backend?: Backend } } } } };
  __b: Backend;
  __ladder: { on: boolean };
};

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await bootMix(page);
  // The core backend the page holds, reached through a voice (a plain property at run time), for the seams above.
  await page.evaluate(() => {
    const g = globalThis as unknown as Api;
    const v = g.__myco.Audio.playOneShot("audio/beep.wav", { volume: 0.0001, bus: "SFX" }).voice;
    g.__b = (v?.backend ?? v?.inner?.backend)!;
  });
  return errors;
}

/** One meter's readings now (a plain copy; `-Infinity` survives the trip). */
const read = (page: Page, bus: string): Promise<Reading> =>
  page.evaluate((name) => {
    const m = (globalThis as unknown as Api).__myco.Audio.bus(name).loudness;
    const t = m.target;
    return {
      momentary: m.momentary,
      shortTerm: m.shortTerm,
      integrated: m.integrated,
      lra: m.lra,
      maxTruePeak: m.maxTruePeak,
      maxMomentary: m.maxMomentary,
      elapsed: m.elapsed,
      metered: m.metered,
      paused: m.paused,
      pausedBy: m.pausedBy,
      incomplete: m.incomplete,
      tainted: m.tainted,
      truePeakBound: m.truePeakBound,
      target: t ? { name: t.name, integrated: t.integrated, tolerance: t.tolerance, truePeak: t.truePeak, deviation: t.deviation, state: t.state, peakOver: t.peakOver } : null,
    };
  }, bus);

/** Reads two meters in one turn (no STATUS block lands between them). */
const readBoth = (page: Page, a: string, b: string) =>
  page.evaluate(
    ([x, y]) => {
      const one = (name: string) => {
        const m = (globalThis as unknown as Api).__myco.Audio.bus(name).loudness;
        const t = m.target;
        return { integrated: m.integrated, elapsed: m.elapsed, paused: m.paused, pausedBy: m.pausedBy, incomplete: m.incomplete, tainted: m.tainted, state: t?.state ?? null };
      };
      return [one(x!), one(y!)] as const;
    },
    [a, b] as const,
  );

/** Runs a script line against the page's `Audio` (the sync reads below need to be one turn). */
const run = <T>(page: Page, src: string): Promise<T> => page.evaluate((s) => new Function("Audio", "g", `return (${s});`)((globalThis as unknown as Api).__myco.Audio, globalThis) as unknown, src) as Promise<T>;

/** Waits until the audio clock has run `seconds` (`Audio.time`). The poll interval is only a pace. */
async function audioFor(page: Page, seconds: number): Promise<void> {
  const t0 = await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.time);
  await page.waitForFunction(([t, s]) => (globalThis as unknown as Api).__myco.Audio.time > (t as number) + (s as number), [t0, seconds] as const, { timeout: 60_000, polling: 50 });
}

/** Waits until a meter has metered `seconds` since its last reset (the core's rendered sub-blocks). */
const metered = (page: Page, bus: string, seconds: number) => expect.poll(async () => (await read(page, bus)).elapsed, { timeout: 60_000, message: `${bus} has metered ${seconds} s of audio` }).toBeGreaterThanOrEqual(seconds);

/**
 * The page's key L: the other sounds pause, the reference plays on UI. Waits for the reference voice, then for Master's
 * momentary level to settle on the tone (the page's reverb tail has rung out), then C resets Master and UI: from here both meters
 * hold the tone alone. Pressing L is the owner's own step (listening-notes/m5b.md, S1).
 */
async function referenceOn(page: Page): Promise<void> {
  await page.keyboard.press("l");
  await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.debug())).voices.some((v) => v.clip.includes("loudness-reference") && v.bus === "UI" && v.state === "playing"), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await read(page, "Master")).momentary, { timeout: 60_000, message: "Master's momentary level has settled on the tone" }).toBeCloseTo(TONE_LUFS, 1);
  await page.keyboard.press("c");
  await expect.poll(async () => (await read(page, "Master")).elapsed, { timeout: 15_000, message: "the reset took" }).toBeLessThan(1);
}

test("M5b: a -23 dBFS tone reads -22.99 LUFS on master and on a metered bus, in Play, once the audio clock has filled the window", async ({ page }) => {
  const errors = await boot(page);
  await referenceOn(page);
  // Six seconds of metered audio: the short-term window (3 s) is full and the loudness range has its two blocks.
  await metered(page, "Master", 6);
  await metered(page, "UI", 6);
  for (const bus of ["Master", "UI"]) {
    const r = await read(page, bus);
    expect(r.metered, `${bus} is metered`).toBe(true);
    expect(r.integrated, `${bus} integrated`).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(r.integrated, `${bus} integrated`).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
    expect(r.momentary, `${bus} momentary`).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(r.momentary).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
    expect(r.shortTerm, `${bus} short-term`).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(r.shortTerm).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
    // A steady tone has no range, and its true peak is the tone's own: -23 dBFS (the golden's window is -0.4 / +0.2 dB).
    expect(r.lra, `${bus} loudness range of a steady tone`).toBeGreaterThanOrEqual(0);
    expect(r.lra).toBeLessThan(0.1);
    expect(r.maxTruePeak, `${bus} true peak`).toBeGreaterThan(-23.4);
    expect(r.maxTruePeak).toBeLessThan(-22.8);
    expect(r.maxMomentary, `${bus} max momentary`).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
    expect(r.incomplete, `${bus}: nothing lost, shed or rebuilt`).toBe(false);
    expect(r.tainted).toBe(false);
    expect(r.paused).toBe(false);
    expect(r.elapsed, `${bus}: elapsed is metered audio since the reset`).toBeGreaterThanOrEqual(6);
  }
  // Master (the final output, after the limiter) and UI (at unity, nothing else on it) read the same signal.
  const [m, u] = [await read(page, "Master"), await read(page, "UI")];
  expect(Math.abs(m.integrated - u.integrated), "master and the UI bus agree").toBeLessThan(0.05);
  // The project's first target (console, -24 LUFS +/- 2 LU, -1 dBTP) is met: +1.0 LU, inside the tolerance.
  expect(m.target).toMatchObject({ name: "console", integrated: -24, tolerance: 2, truePeak: -1, state: "ok", peakOver: false });
  expect(m.target!.deviation).toBeCloseTo(TONE_LUFS + 24, 1);
  expect(errors).toEqual([]);
});

test("M5b: the target verdict, for every target and a hot signal: ok, low, high, waiting, peak over; a bad name is ignored", async ({ page }) => {
  const errors = await boot(page);
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  await test.step("waiting: a meter just reset has no integrated value, so no verdict yet", async () => {
    await run(page, `Audio.bus("UI").loudness.reset("all")`);
    const r = await read(page, "UI");
    expect(r.integrated).toBe(-Infinity);
    expect(r.target).toMatchObject({ name: "console", state: "waiting", deviation: -Infinity });
  });

  await referenceOn(page);
  await metered(page, "Master", 3);

  await test.step("console (-24 +/- 2): the reference is +1.0 LU: ok", async () => {
    expect(await run<string | null>(page, `Audio.loudnessTarget`), "the first target is the default").toBe("console");
    const t = (await read(page, "Master")).target!;
    expect(t.state).toBe("ok");
    expect(t.deviation).toBeCloseTo(TONE_LUFS + 24, 1);
  });

  await test.step("mobile (-18 +/- 2): the same signal is -5.0 LU: low (the V key cycles to it)", async () => {
    await page.keyboard.press("v");
    await expect.poll(() => run<string | null>(page, `Audio.loudnessTarget`), { timeout: 15_000 }).toBe("mobile");
    const [m, u] = [await read(page, "Master"), await read(page, "UI")];
    for (const r of [m, u]) {
      expect(r.target).toMatchObject({ name: "mobile", integrated: -18, tolerance: 2, state: "low", peakOver: false });
      expect(r.target!.deviation).toBeCloseTo(TONE_LUFS + 18, 1);
    }
    expect(m.integrated, "a target change is not a reset: the meter kept its reading").toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(m.elapsed).toBeGreaterThanOrEqual(3);
  });

  await test.step("the V key goes round: back to console", async () => {
    await page.keyboard.press("v");
    await expect.poll(() => run<string | null>(page, `Audio.loudnessTarget`), { timeout: 15_000 }).toBe("console");
    expect((await read(page, "Master")).target!.state).toBe("ok");
  });

  await test.step("a name that is not a target is ignored with one warning, and null selects the first", async () => {
    const before = warnings.length;
    await run(page, `(Audio.loudnessTarget = "nope")`);
    expect(await run<string | null>(page, `Audio.loudnessTarget`)).toBe("console");
    expect(warnings.slice(before).filter((w) => w.includes("no loudness target named"))).toHaveLength(1);
    await run(page, `(Audio.loudnessTarget = "mobile")`);
    await run(page, `(Audio.loudnessTarget = null)`);
    expect(await run<string | null>(page, `Audio.loudnessTarget`)).toBe("console");
  });

  await test.step("a hot signal (the same sine at -0.5 dBFS, key W): high, and its true peak is over the -1 dBTP ceiling", async () => {
    await page.keyboard.press("l"); // the reference off: the other sounds return
    await run(page, `Audio.bus("UI").loudness.reset("all")`);
    await page.keyboard.press("w");
    await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.debug())).voices.some((v) => v.clip.includes("loudness-hot") && v.bus === "UI"), { timeout: 20_000 }).toBe(true);
    // The clip is 2 s; the meter has run past it once it has metered 3 s.
    await metered(page, "UI", 3);
    const hot = await read(page, "UI");
    expect(hot.target).toMatchObject({ name: "console", state: "high", peakOver: true });
    // A 2 s burst: the 400 ms blocks that straddle its start and end pass the gates at part energy, so integrated reads a
    // little under the tone's own -0.5 LUFS (measured -1.10): -24 + 22.9 here, not 23.5.
    expect(hot.target!.deviation, "about -1 LUFS against -24").toBeGreaterThan(22.6);
    expect(hot.target!.deviation).toBeLessThan(23.6);
    expect(hot.maxTruePeak, "the tone's own peak").toBeGreaterThan(-0.8);
    expect(hot.maxTruePeak).toBeLessThan(-0.2);
    // The hot bus's peak is a fact about that bus: the reference's meter reading (console again) says ok on a quieter one.
    await run(page, `(Audio.loudnessTarget = "mobile")`);
    expect((await read(page, "UI")).target).toMatchObject({ name: "mobile", state: "high", peakOver: true });
    await run(page, `(Audio.loudnessTarget = "console")`);
    // Reset "maxPeak" clears the over flag (the peak is the only thing it clears); the integrated level stays high.
    await run(page, `Audio.bus("UI").loudness.reset("maxPeak")`);
    const cleared = await read(page, "UI");
    expect(cleared.target!.peakOver).toBe(false);
    expect(cleared.target!.state).toBe("high");
  });
  expect(errors).toEqual([]);
});

test("M5b: every reset option clears what it says, and the audio clock counts again from the reset", async ({ page }) => {
  const errors = await boot(page);
  await referenceOn(page);
  await metered(page, "UI", 6);
  const before = await read(page, "UI");
  expect(before.integrated).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
  expect(before.maxTruePeak).toBeGreaterThan(-23.4);
  expect(before.shortTerm).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
  expect(before.lra).toBeGreaterThanOrEqual(0);

  await test.step('reset("maxPeak"): the maxima go, the integrated level, its range and the window stay', async () => {
    // One turn: no STATUS block can land between the reset and the read.
    const r = await page.evaluate(() => {
      const m = (globalThis as unknown as Api).__myco.Audio.bus("UI").loudness;
      const was = { integrated: m.integrated, elapsed: m.elapsed, lra: m.lra };
      m.reset("maxPeak");
      return { was, maxTruePeak: m.maxTruePeak, maxMomentary: m.maxMomentary, integrated: m.integrated, elapsed: m.elapsed, lra: m.lra, momentary: m.momentary, shortTerm: m.shortTerm };
    });
    expect(r.maxTruePeak).toBe(-Infinity);
    expect(r.maxMomentary).toBe(-Infinity);
    expect(r.integrated).toBe(r.was.integrated);
    expect(r.elapsed).toBe(r.was.elapsed);
    expect(r.lra).toBe(r.was.lra);
    expect(r.momentary, "the window continues").toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(r.shortTerm).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    // The tone is still playing, so the maxima come back from the next audio on.
    await expect.poll(async () => (await read(page, "UI")).maxTruePeak, { timeout: 15_000 }).toBeGreaterThan(-23.4);
    expect((await read(page, "UI")).maxMomentary).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
  });

  await test.step('reset("integrated"): integrated, range, elapsed and the flags go; momentary, short-term and the maxima stay', async () => {
    const r = await page.evaluate(() => {
      const m = (globalThis as unknown as Api).__myco.Audio.bus("UI").loudness;
      const was = { maxTruePeak: m.maxTruePeak, momentary: m.momentary };
      m.reset("integrated");
      return { was, integrated: m.integrated, lra: m.lra, elapsed: m.elapsed, maxTruePeak: m.maxTruePeak, momentary: m.momentary, shortTerm: m.shortTerm, target: m.target!.state };
    });
    expect(r.integrated).toBe(-Infinity);
    expect(r.lra).toBe(-Infinity);
    expect(r.elapsed).toBe(0);
    expect(r.target, "no integrated value, no verdict").toBe("waiting");
    expect(r.maxTruePeak).toBe(r.was.maxTruePeak);
    expect(r.momentary, "the window continues").toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(r.shortTerm).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    // It meters again from zero, on the audio clock: after one second of frames the integrated level is back.
    await metered(page, "UI", 1);
    const after = await read(page, "UI");
    expect(after.integrated).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(after.integrated).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
    expect(after.elapsed).toBeLessThan(before.elapsed);
  });

  await test.step('reset("all") and reset() (the default): the window restarts too, so momentary is empty for 0.4 s and short-term for 3 s', async () => {
    for (const call of [`Audio.bus("UI").loudness.reset("all")`, `Audio.bus("UI").loudness.reset()`]) {
      await metered(page, "UI", 1);
      const r = await page.evaluate((src) => {
        const m = (globalThis as unknown as Api).__myco.Audio.bus("UI").loudness;
        new Function("Audio", src)((globalThis as unknown as Api).__myco.Audio);
        return { momentary: m.momentary, shortTerm: m.shortTerm, integrated: m.integrated, maxTruePeak: m.maxTruePeak, maxMomentary: m.maxMomentary, elapsed: m.elapsed, lra: m.lra };
      }, call);
      expect(r, call).toMatchObject({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, maxTruePeak: -Infinity, maxMomentary: -Infinity, elapsed: 0, lra: -Infinity });
      // 0.5 s of metered audio: momentary has its four sub-blocks, short-term still waits for thirty.
      await metered(page, "UI", 0.5);
      const half = await read(page, "UI");
      expect(half.momentary, call).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
      expect(half.shortTerm, call).toBe(-Infinity);
      expect(half.integrated).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    }
    await metered(page, "UI", 3.2);
    const full = await read(page, "UI");
    expect(full.shortTerm, "thirty sub-blocks in").toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(full.shortTerm).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
  });

  await test.step("the C key resets Master and UI, as the owner does", async () => {
    await metered(page, "UI", 1);
    await page.keyboard.press("c");
    await expect.poll(async () => Math.max((await read(page, "UI")).elapsed, (await read(page, "Master")).elapsed), { timeout: 15_000 }).toBeLessThan(1);
  });
  expect(errors).toEqual([]);
});

test("M5b: a paused meter holds its readings and counts no audio; resuming restarts its window and marks nothing incomplete", async ({ page }) => {
  const errors = await boot(page);
  await referenceOn(page);
  await metered(page, "UI", 2);
  await test.step("the F key pauses Master's and UI's meters", async () => {
    await page.keyboard.press("f");
    await expect.poll(async () => (await readBoth(page, "Master", "UI")).every((m) => m.paused), { timeout: 15_000 }).toBe(true);
    const [m, u] = await readBoth(page, "Master", "UI");
    expect([m.pausedBy, u.pausedBy]).toEqual(["script", "script"]);
    expect((await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.debug())).mix.metersPaused, "Audio.debug() counts them").toBe(2);
  });
  await test.step("two seconds of the audio clock go by: elapsed and the integrated level did not move", async () => {
    const [m0, u0] = await readBoth(page, "Master", "UI");
    await audioFor(page, 2);
    const [m1, u1] = await readBoth(page, "Master", "UI");
    expect(m1.elapsed, "Master paused").toBe(m0.elapsed);
    expect(u1.elapsed, "UI paused").toBe(u0.elapsed);
    expect(u1.integrated).toBe(u0.integrated);
    expect(m1.integrated).toBe(m0.integrated);
  });
  await test.step("F again resumes: the meter counts again from where it stopped, with its integrated level kept", async () => {
    const [, u0] = await readBoth(page, "Master", "UI");
    await page.keyboard.press("f");
    await expect.poll(async () => (await readBoth(page, "Master", "UI")).some((m) => m.paused), { timeout: 15_000 }).toBe(false);
    const r = await read(page, "UI");
    expect(r.pausedBy).toBeNull();
    expect(r.integrated, "kept across the pause").toBeCloseTo(u0.integrated, 6);
    await metered(page, "UI", u0.elapsed + 1);
    const after = await read(page, "UI");
    expect(after.integrated).toBeGreaterThan(TONE_LUFS - TONE_TOLERANCE);
    expect(after.integrated).toBeLessThan(TONE_LUFS + TONE_TOLERANCE);
    expect(after.incomplete, "a script's own pause is not a gap in the programme").toBe(false);
    expect(after.paused).toBe(false);
  });
  await test.step("pause() and resume() from a script, on one bus: only that meter stops", async () => {
    const e = await page.evaluate(() => {
      const { Audio } = (globalThis as unknown as Api).__myco;
      Audio.bus("UI").loudness.pause();
      return { ui: Audio.bus("UI").loudness.elapsed, master: Audio.bus("Master").loudness.elapsed, by: Audio.bus("UI").loudness.pausedBy, masterPaused: Audio.bus("Master").loudness.paused };
    });
    expect(e.by).toBe("script");
    expect(e.masterPaused).toBe(false);
    await audioFor(page, 1.5);
    const [m, u] = await readBoth(page, "Master", "UI");
    expect(u.elapsed, "UI held").toBe(e.ui);
    expect(m.elapsed, "Master kept counting").toBeGreaterThan(e.master + 1);
    await run(page, `Audio.bus("UI").loudness.resume()`);
    expect((await read(page, "UI")).paused).toBe(false);
  });
  expect(errors).toEqual([]);
});

test("M5b: a monitor mute taints its bus, its ancestors and master; a monitor solo or Compare taints every meter; reset clears it; the target check is suspended while a control is on", async ({ page }) => {
  const errors = await boot(page);
  await referenceOn(page);
  await metered(page, "UI", 3);
  const base = await readBoth(page, "Master", "UI");
  expect(base.map((m) => m.tainted)).toEqual([false, false]);
  expect(base.map((m) => m.state)).toEqual(["ok", "ok"]);

  // As the Mixer panel's monitor model makes them (`monitorModel.ts`): the mixer's lane, the taint note, the active flag.
  const monitor = (bus: string, c: { mute?: boolean; solo?: boolean }, note: "mute" | "solo" | null, active: boolean) =>
    page.evaluate(
      ([name, ctl, n, on]) => {
        const b = (globalThis as unknown as Api).__b;
        b.mixer.setMonitor(name as string, ctl as { mute?: boolean });
        if (n === "mute") b.loudness.noteMonitorMute(name as string);
        if (n === "solo") b.loudness.noteMonitorSolo();
        b.loudness.setMonitorActive(on as boolean);
      },
      [bus, c, note, active] as const,
    );
  const debugMix = async () => (await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.debug())).mix;
  const clear = async () => {
    await run(page, `Audio.bus("Master").loudness.reset("all")`);
    await run(page, `Audio.bus("UI").loudness.reset("all")`);
  };

  await test.step("a script mute of an unmetered bus taints nothing", async () => {
    await run(page, `(Audio.bus("Ambience").mute = true)`);
    await audioFor(page, 0.5);
    expect((await readBoth(page, "Master", "UI")).map((m) => m.tainted)).toEqual([false, false]);
    await run(page, `(Audio.bus("Ambience").mute = false)`);
  });

  await test.step("a monitor mute of an unmetered bus (Ambience) taints master only, and suspends the target check", async () => {
    await monitor("Ambience", { mute: true }, "mute", true);
    const [m, u] = await readBoth(page, "Master", "UI");
    expect([m.tainted, u.tainted], "Master is the output, an ancestor of Ambience; UI is neither").toEqual([true, false]);
    expect([m.state, u.state], "the check is suspended on every meter while a control is on").toEqual(["suspended", "suspended"]);
    expect((await debugMix()).monitorActive).toBe(true);
    // Unmuting ends the suspension; the mark stays until a reset.
    await monitor("Ambience", { mute: false }, null, false);
    const after = await readBoth(page, "Master", "UI");
    expect(after.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(after.map((x) => x.tainted), "unmuting clears nothing").toEqual([true, false]);
    expect((await debugMix()).monitorActive).toBe(false);
  });

  await test.step("a monitor mute of a metered bus (UI) taints it and master; its level really goes silent", async () => {
    await monitor("UI", { mute: true }, "mute", true);
    expect((await readBoth(page, "Master", "UI")).map((x) => x.tainted)).toEqual([true, true]);
    const held = (await read(page, "UI")).integrated;
    // The meter reads post-fader, monitor lane included: 0.6 s of the audio clock on, its window holds silence.
    await audioFor(page, 0.6);
    await expect.poll(async () => (await read(page, "UI")).momentary, { timeout: 15_000 }).toBe(-Infinity);
    // Silent blocks are under the absolute gate and leave integrated alone; the blocks that straddled the mute passed it at part
    // energy and pulled it down a little (measured -0.15 LU after 3 s of tone): near the held value, not at silence.
    const after = (await read(page, "UI")).integrated;
    expect(after, "digital silence does not drag the integrated level to silence").toBeGreaterThan(held - 0.5);
    expect(after).toBeLessThanOrEqual(held + 1e-9);
    await monitor("UI", { mute: false }, null, false);
  });

  await test.step('reset("integrated") clears the mark on that meter only; reset("all") clears it too; reset("maxPeak") leaves it', async () => {
    await run(page, `Audio.bus("Master").loudness.reset("maxPeak")`);
    expect((await readBoth(page, "Master", "UI")).map((x) => x.tainted), "maxPeak leaves the marks").toEqual([true, true]);
    await run(page, `Audio.bus("Master").loudness.reset("integrated")`);
    expect((await readBoth(page, "Master", "UI")).map((x) => x.tainted)).toEqual([false, true]);
    await run(page, `Audio.bus("UI").loudness.reset("all")`);
    expect((await readBoth(page, "Master", "UI")).map((x) => x.tainted)).toEqual([false, false]);
  });

  await test.step("a monitor solo taints every meter, and the check is suspended while it is on", async () => {
    await clear();
    await monitor("UI", { solo: true }, "solo", true);
    const both = await readBoth(page, "Master", "UI");
    expect(both.map((x) => x.tainted)).toEqual([true, true]);
    expect(both.map((x) => x.state)).toEqual(["suspended", "suspended"]);
    await monitor("UI", { solo: false }, null, false);
    expect((await readBoth(page, "Master", "UI")).map((x) => x.tainted), "solo off clears nothing").toEqual([true, true]);
    await clear();
  });

  await test.step("Compare taints every meter and suspends the check, until it is switched off", async () => {
    // The last reset left no integrated value (verdict waiting): meter a second of the tone first, so "off" can read ok.
    await metered(page, "Master", 1);
    await metered(page, "UI", 1);
    await page.evaluate(() => (globalThis as unknown as Api).__b.loudness.setCompare(true));
    const on = await readBoth(page, "Master", "UI");
    expect(on.map((x) => x.tainted)).toEqual([true, true]);
    expect(on.map((x) => x.state)).toEqual(["suspended", "suspended"]);
    await page.evaluate(() => (globalThis as unknown as Api).__b.loudness.setCompare(false));
    const off = await readBoth(page, "Master", "UI");
    expect(off.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(off.map((x) => x.tainted)).toEqual([true, true]);
    await clear();
    expect((await readBoth(page, "Master", "UI")).map((x) => x.tainted)).toEqual([false, false]);
  });
  expect(errors).toEqual([]);
});

// The mutes and MASTER-not-1 rows of §1.1 ("authored or script mutes and the hidden-tab mute do not taint; they make
// `target.state` suspended") need the backend to call the hub's `setMuted` and `setMasterNotUnity`. Neither is called anywhere
// at c0d328c (the stubs file lists them as backend inputs); the taint half is in the case above. Un-fixme when they are wired.
test.fixme("M5b: a script mute, or MASTER not 1, suspends the target check without tainting", async ({ page }) => {
  await boot(page);
  await referenceOn(page);
  await metered(page, "Master", 3);
  await run(page, `(Audio.bus("Ambience").mute = true)`);
  await expect.poll(async () => (await read(page, "Master")).target!.state, { timeout: 15_000 }).toBe("suspended");
  expect((await read(page, "Master")).tainted).toBe(false);
});

test("M5b: the ladder's loudness step, as STATUS reports it: non-master meters pause (pausedBy ladder), master keeps metering, the step is in Audio.debug(), and the resume marks incomplete", async ({ page }) => {
  const errors = await boot(page);
  await referenceOn(page);
  await metered(page, "UI", 3);
  const set = (on: boolean) =>
    page.evaluate((v) => {
      const g = globalThis as unknown as Api;
      if (!g.__ladder) {
        g.__ladder = { on: false };
        // The seam: the STATUS block the core sends carries `loudShed` (0 or 1); it reaches the mirror and the hub in this order.
        const hub = g.__b.loudness as unknown as { feed(s: { loudShed: number }): void };
        const feed = hub.feed.bind(hub);
        hub.feed = (s) => {
          if (g.__ladder.on) {
            s.loudShed = 1;
            g.__b.mirror.loudShed = 1;
          }
          feed(s);
        };
      }
      g.__ladder.on = v;
    }, on);
  const mixOf = async () => (await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.debug())).mix;
  expect(await mixOf()).toMatchObject({ loudnessLadderStep: 0, metersPaused: 0 });

  await set(true);
  await test.step("the step is in force: UI is paused by the ladder, Master is not, and Audio.debug() says so", async () => {
    await expect.poll(async () => (await read(page, "UI")).pausedBy, { timeout: 15_000 }).toBe("ladder");
    const [m, u] = await readBoth(page, "Master", "UI");
    expect(u.paused).toBe(true);
    expect(m.paused, "master never stops").toBe(false);
    expect(m.pausedBy).toBeNull();
    expect(await mixOf()).toMatchObject({ loudnessLadderStep: 1, metersPaused: 1 });
    // On the audio clock: UI holds while master meters on.
    const [m0, u0] = await readBoth(page, "Master", "UI");
    await audioFor(page, 1.5);
    const [m1, u1] = await readBoth(page, "Master", "UI");
    expect(u1.elapsed, "UI counts no audio while shed").toBe(u0.elapsed);
    expect(m1.elapsed, "Master kept metering").toBeGreaterThan(m0.elapsed + 1);
    expect(u1.integrated, "the reading it had is kept").toBe(u0.integrated);
    expect(u1.incomplete, "marked on the resume, not before").toBe(false);
  });

  await set(false);
  await test.step("the step is given back: UI meters again, flagged incomplete (a shed span is a gap), Master untouched", async () => {
    await expect.poll(async () => (await read(page, "UI")).paused, { timeout: 15_000 }).toBe(false);
    expect(await mixOf()).toMatchObject({ loudnessLadderStep: 0, metersPaused: 0 });
    const [m, u] = await readBoth(page, "Master", "UI");
    expect(u.incomplete, "a shed span since the last reset").toBe(true);
    expect(m.incomplete, "master never shed").toBe(false);
    // Metering resumes from the audio that follows; the flag stays until a reset.
    const e0 = u.elapsed;
    await metered(page, "UI", e0 + 1);
    expect((await read(page, "UI")).incomplete).toBe(true);
    await run(page, `Audio.bus("UI").loudness.reset("all")`);
    expect((await read(page, "UI")).incomplete).toBe(false);
  });
  expect(errors).toEqual([]);
});
