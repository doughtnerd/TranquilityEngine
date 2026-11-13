import { expect, test, type Locator, type Page } from "./fixtures";
import { BUSES, TONE_PEAK, fader, openAudioSettings, openLiveMix, openMixer, playLiveMix, savedProject, stopPlay, strip, type MixBus } from "./audioMixLive";
import { FINE_DRAG_SCALE, gainToPosition, positionToGain } from "../../src/plugins/audio/editor/mix/faderModel";

// M5c live mixing in the real editor app (ADR 0171 amended by 0172 and 0173, task E3): an edit made in Play through the Mixer panel
// (`audiomixer`) or Project Settings > Audio is heard on the audio clock, kept in `project.json` after Stop, and undone and redone
// through the shared Project Settings history; every Mixer control and option; every edit class of architecture section 4.7;
// level ducking audible on its target.
//
// The project is the editor's in-memory test project (the Flappy files) with a small audio section and one scene of looping
// reference tones (`audioMixLive.ts`): the Sound Lab opens read-only, so a live edit there neither reaches the mixer nor is saved.
// **"Heard"** is the bus's meter peak (a looping 1 kHz sine at -23 dBFS, so a bus's peak is that sine's peak times the bus's gain),
// and `Bus.effectiveGain` (the product of the core's lanes), both read on the audio clock: a wait is for `Audio.time` to pass, or for
// a reading to arrive; the polls only pace the reads and no assertion is a wall-clock span. A bus with effects (a filter or the
// compressor) is read on the signal's ratio to its own reading before the edit, never on an absolute level.
// **Limits:** headless Chromium has no sound output, so "no click" is read off `Audio.debug()` (underruns, late and early records,
// refusals) and the meter's own readings, not the ear (the listening section, `listening-notes/m5c.md`, is the ear).

test.describe.configure({ timeout: 150_000 });

type Dbg = {
  time: number;
  counters: { underruns: number; lateCommands: number; traps: number };
  buses: { name: string; effectiveGain: number; peakL: number; peakR: number }[];
  voices: { clip: string; bus: string; state: string }[];
  mix: { monitorActive: boolean; metersPaused: number; liveRefused: number; liveDeferred: number; busRecordsEarly: number; sidechainLate: number; slots: { name: string; state: string }[]; ducking: { target: string; trigger: string; mode: string; gain: number }[] };
};
type BusApi = { effectiveGain: number; duckGain: number; volume: number; mute: boolean; loudness: { elapsed: number; paused: boolean; pausedBy: string | null } };
type Api = {
  __myco: {
    Audio: { time: number; loudnessTarget: string | null; buses: readonly string[]; debug(): Dbg; bus(n: string): BusApi };
    AudioSource: unknown;
    GameObject: { findObjectsOfType(t: unknown): { node: { name: string }; play(): void; stop(): void }[] };
  };
};

function track(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

const dbg = (page: Page): Promise<Dbg> => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.debug());
const gainOf = (page: Page, bus: string): Promise<number> => page.evaluate((b) => (globalThis as unknown as Api).__myco.Audio.bus(b).effectiveGain, bus);
const duckOf = (page: Page, bus: string): Promise<number> => page.evaluate((b) => (globalThis as unknown as Api).__myco.Audio.bus(b).duckGain, bus);
const audioTime = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.time);

/** Waits until the audio clock has run `seconds` (`Audio.time`); the poll interval is only a pace. */
async function audioFor(page: Page, seconds: number): Promise<void> {
  const t0 = await audioTime(page);
  await page.waitForFunction(([t, s]) => (globalThis as unknown as Api).__myco.Audio.time > (t as number) + (s as number), [t0, seconds] as const, { timeout: 60_000, polling: 25 });
}

/** The highest and lowest meter peak of a bus, and its effective gain range, over `seconds` of the audio clock (sampled in the page). */
async function meterWindow(page: Page, bus: string, seconds: number): Promise<{ max: number; min: number; gainMin: number; gainMax: number; n: number }> {
  return page.evaluate(
    async ([name, span]) => {
      const A = (globalThis as unknown as Api).__myco.Audio;
      const t0 = A.time;
      let max = 0, min = Infinity, gainMin = Infinity, gainMax = 0, n = 0;
      while (A.time < t0 + (span as number)) {
        const row = A.debug().buses.find((b) => b.name === name)!;
        max = Math.max(max, row.peakL);
        min = Math.min(min, row.peakL);
        gainMin = Math.min(gainMin, row.effectiveGain);
        gainMax = Math.max(gainMax, row.effectiveGain);
        n++;
        await new Promise((r) => setTimeout(r, 8));
      }
      return { max, min, gainMin, gainMax, n };
    },
    [bus, seconds] as const,
  );
}

/**
 * A bus plays the tone at `gain` times the tone: its effective gain reaches `gain` (a reading that arrives; the fade is the core's),
 * then over 0.3 s of the audio clock its meter peak holds at the tone's peak times `gain` (silent below 0.002 for gain 0).
 */
async function heard(page: Page, bus: string, gain: number): Promise<void> {
  await expect.poll(() => gainOf(page, bus), { timeout: 20_000, message: `${bus}'s effective gain reaches ${gain}` }).toBeCloseTo(gain, 3);
  // The meter falls with its own release (about 0.5 s from a louder reading to the new level): let it settle on the audio clock.
  await audioFor(page, gain === 0 ? 1.6 : 0.9);
  const w = await meterWindow(page, bus, 0.3);
  if (gain === 0) {
    // A fall from a loud reading takes the meter longer: poll audio-clock windows until it is silent.
    await expect.poll(async () => (await meterWindow(page, bus, 0.3)).max, { timeout: 30_000, message: `${bus} is silent` }).toBeLessThan(0.002);
    return;
  }
  expect(w.max, `${bus} peak at ${gain}`).toBeGreaterThan(TONE_PEAK * gain * 0.93);
  expect(w.max).toBeLessThan(TONE_PEAK * gain * 1.07);
  expect(w.min, "a steady tone: the meter holds").toBeGreaterThan(TONE_PEAK * gain * 0.9);
}

/** A bus's authored entry in `project.json`. */
const savedOf = async (page: Page, bus: string): Promise<{ volume: number; mute: boolean; parent?: string; effects?: { type: string; [k: string]: unknown }[] } | undefined> =>
  (await savedProject(page)).audio?.buses?.find((b) => b.name === bus);
const savedVolume = async (page: Page, bus: string): Promise<number> => (await savedOf(page, bus))!.volume;

const banners = (page: Page) => page.locator(".mixer-banners .mixer-banner");
const audioPanel = (page: Page) => page.locator(".panel.project").getByRole("group", { name: "Audio settings" });

/** A number field of the settings panel: type and commit with Enter. */
async function commit(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.press("Enter");
}

/** Expands a bus's row in Project Settings > Audio (its effects and checks are in the body of a collapsed `details`). */
const expandBus = (page: Page, bus: string) => audioPanel(page).locator(`details[data-bus="${bus}"]`).evaluate((d) => ((d as HTMLDetailsElement).open = true));

/**
 * The counters a click would show in: all must be unchanged across an edit. Underruns are left out: software GL on a shared 4-core
 * box starves the audio thread now and then, with or without an edit (a test reports them, it doesn't assert them).
 */
const clickCounters = async (page: Page) => {
  const d = await dbg(page);
  return { lateCommands: d.counters.lateCommands, traps: d.counters.traps, busRecordsEarly: d.mix.busRecordsEarly, sidechainLate: d.mix.sidechainLate, liveRefused: d.mix.liveRefused };
};

/** The Mixer's fader gets the focus (its keys act on it). */
async function focusFader(page: Page, bus: string): Promise<void> {
  await fader(page, bus).focus();
  await expect(fader(page, bus)).toBeFocused();
}

/** The project's buses with `name` patched. */
const withBus = (name: string, patch: Partial<MixBus>, buses: MixBus[] = BUSES): MixBus[] => buses.map((b) => (b.name === name ? { ...b, ...patch } : b));

void strip;
void openAudioSettings;
void duckOf;
void banners;
void commit;
void expandBus;
void withBus;
void stopPlay;

// ---- a fader edit: heard, kept, undone -------------------------------------------------------------------------------------

test("M5c: a fader edit is heard in Play on the audio clock, kept in project.json after Stop, and undone and redone with the same heard value", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Aux" }] });
  await playLiveMix(page);
  await openMixer(page);
  await heard(page, "Aux", 1);
  const counters = await clickCounters(page);

  let v1 = 1;
  await test.step("one key on the fader: one committed edit, heard on Aux's meter and effective gain", async () => {
    await focusFader(page, "Aux");
    await page.keyboard.press("PageDown");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBeLessThan(1);
    v1 = await savedVolume(page, "Aux");
    expect(v1).toBeCloseTo(positionToGain(gainToPosition(1) - 0.1), 6);
    await heard(page, "Aux", v1);
    expect(await clickCounters(page), "no late, early or refused record, no underrun").toEqual(counters);
  });

  await test.step("Stop: the edit is kept in project.json, not reverted to the authored value", async () => {
    await stopPlay(page);
    expect(await savedVolume(page, "Aux")).toBeCloseTo(v1, 9);
    await expect(fader(page, "Aux")).toHaveAttribute("aria-valuetext", /dB$/);
  });

  await test.step("Play again: the bus starts at the edited value, heard", async () => {
    await playLiveMix(page);
    await heard(page, "Aux", v1);
  });

  await test.step("Ctrl+Z restores the value and the heard value; Ctrl+Shift+Z puts the edit back", async () => {
    await focusFader(page, "Aux");
    await page.keyboard.press("Control+z");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBe(1);
    await heard(page, "Aux", 1);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBeCloseTo(v1, 9);
    await heard(page, "Aux", v1);
    expect((await dbg(page)).mix.liveRefused, "nothing was refused").toBe(0);
  });
  expect(errors).toEqual([]);
});

// ---- every key of the fader --------------------------------------------------------------------------------------------------

test("M5c: every fader key is one committed edit, heard, and one undo step: arrows, page keys, Home, End, the fine modifiers, a double-click", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Aux" }] });
  await playLiveMix(page);
  await openMixer(page);
  await heard(page, "Aux", 1);
  await focusFader(page, "Aux");

  /** key, expected position change (`by`) or absolute position (`to`). */
  const keys: { key: string; by?: number; to?: number }[] = [
    { key: "ArrowUp", by: 0.02 },
    { key: "ArrowRight", by: 0.02 },
    { key: "ArrowDown", by: -0.02 },
    { key: "ArrowLeft", by: -0.02 },
    { key: "PageUp", by: 0.1 },
    { key: "PageDown", by: -0.1 },
    { key: "Shift+ArrowUp", by: 0.02 * FINE_DRAG_SCALE },
    { key: "Alt+ArrowDown", by: -0.02 * FINE_DRAG_SCALE },
    { key: "End", to: 1 },
    { key: "Home", to: 0 },
  ];
  for (const k of keys) {
    await test.step(k.key, async () => {
      const before = await savedVolume(page, "Aux");
      const pos = Math.min(1, Math.max(0, k.to ?? gainToPosition(before) + k.by!));
      const want = positionToGain(pos);
      await page.keyboard.press(k.key);
      await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000, message: `${k.key} moved the fader` }).toBeCloseTo(want, 6);
      await heard(page, "Aux", want);
      // One undo step: one Ctrl+Z puts the value before the key back, and redo returns it.
      await page.keyboard.press("Control+z");
      await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000, message: `${k.key} undoes in one step` }).toBeCloseTo(before, 6);
      await page.keyboard.press("Control+Shift+z");
      await expect.poll(() => savedVolume(page, "Aux")).toBeCloseTo(want, 6);
    });
  }

  await test.step("a double-click puts the fader on unity gain, one commit", async () => {
    expect(await savedVolume(page, "Aux")).toBe(0); // Home left it silent
    await fader(page, "Aux").dblclick();
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBe(1);
    await heard(page, "Aux", 1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBe(0);
  });
  expect((await dbg(page)).mix.liveRefused).toBe(0);
  expect(errors).toEqual([]);
});

// ---- the pointer drag: preview, release, Escape --------------------------------------------------------------------------------

test("M5c: a pointer drag previews live and commits one edit on release; Escape puts the start value back and commits nothing; Shift drags finely", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Aux" }] });
  await playLiveMix(page);
  await openMixer(page);
  await heard(page, "Aux", 1);
  await fader(page, "Aux").scrollIntoViewIfNeeded();
  const box = (await fader(page, "Aux").boundingBox())!;
  const x = box.x + box.width / 2;
  const yUnity = box.y + box.height * (1 - 0.75);
  const drag = async (dy: number, o: { shift?: boolean } = {}) => {
    await page.mouse.move(x, yUnity);
    if (o.shift) await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(x, yUnity + dy, { steps: 6 });
  };

  await test.step("while the button is down the mix follows (heard) and nothing is saved or undoable", async () => {
    await drag(box.height * 0.25); // down a quarter of the travel
    const want = positionToGain(0.5);
    await expect.poll(() => gainOf(page, "Aux"), { timeout: 20_000, message: "the preview reached the core" }).toBeCloseTo(want, 2);
    expect(await savedVolume(page, "Aux"), "no commit while dragging").toBe(1);
    await heard(page, "Aux", await gainOf(page, "Aux"));
  });
  await test.step("release: one committed edit, one undo step", async () => {
    await page.mouse.up();
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBeCloseTo(positionToGain(0.5), 2);
    const committed = await savedVolume(page, "Aux");
    await heard(page, "Aux", committed);
    await focusFader(page, "Aux");
    await page.keyboard.press("Control+z");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBe(1);
    await heard(page, "Aux", 1);
  });
  await test.step("Escape during a drag: the start value is back, heard, and nothing is committed", async () => {
    await drag(box.height * 0.25);
    await expect.poll(() => gainOf(page, "Aux"), { timeout: 20_000 }).toBeLessThan(0.9);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await heard(page, "Aux", 1);
    expect(await savedVolume(page, "Aux")).toBe(1);
  });
  await test.step("Shift makes the same pointer travel a tenth as far", async () => {
    await drag(box.height * 0.25, { shift: true });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBeLessThan(1);
    // 0.25 of the travel x FINE_DRAG_SCALE below unity (snapping to unity only holds inside 0.02 of it).
    expect(await savedVolume(page, "Aux")).toBeCloseTo(positionToGain(0.75 - 0.25 * FINE_DRAG_SCALE), 2);
    await heard(page, "Aux", await savedVolume(page, "Aux"));
  });
  expect(errors).toEqual([]);
});

/** Starts, stops or reads a scene tone (an `AudioSource` on the node named `Tone <bus>`). */
const toneAction = (page: Page, bus: string, action: "play" | "stop") =>
  page.evaluate(
    ([b, a]) => {
      const m = (globalThis as unknown as Api).__myco;
      const s = m.GameObject.findObjectsOfType(m.AudioSource).find((x) => x.node.name === `Tone ${b}`);
      if (!s) throw new Error(`no tone on ${b}`);
      s[a as "play"]();
    },
    [bus, action] as const,
  );

// ---- M, MM, S ------------------------------------------------------------------------------------------------------------------

test("M5c: M mutes and saves, MM mutes in the monitor only, S solos in the monitor only; neither monitor control is saved or outlives Stop", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Aux" }, { bus: "Music" }] });
  await playLiveMix(page);
  await openMixer(page);
  await heard(page, "Aux", 1);
  const mute = (bus: string) => page.getByRole("button", { name: `Mute ${bus}`, exact: true });
  const mm = (bus: string) => page.getByRole("button", { name: `Monitor mute ${bus}`, exact: true });
  const solo = (bus: string) => page.getByRole("button", { name: `Solo ${bus}`, exact: true });
  const musicPeak = async () => (await meterWindow(page, "Music", 0.3)).max;

  await test.step("M: saved in project.json, silent, one undo step restores it", async () => {
    await mute("Aux").click();
    await expect(mute("Aux")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await savedOf(page, "Aux"))!.mute, { timeout: 10_000 }).toBe(true);
    await heard(page, "Aux", 0);
    await focusFader(page, "Aux");
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await savedOf(page, "Aux"))!.mute, { timeout: 10_000 }).toBe(false);
    await heard(page, "Aux", 1);
  });

  await test.step("MM: Aux goes silent, the project is untouched, the banner and Audio.debug() say a monitor control is on", async () => {
    await mm("Aux").click();
    await expect(mm("Aux")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await meterWindow(page, "Aux", 0.3)).max, { timeout: 30_000, message: "Aux is silent in the monitor" }).toBeLessThan(0.002);
    expect((await savedOf(page, "Aux"))!.mute, "never saved").toBe(false);
    expect(await savedVolume(page, "Aux")).toBe(1);
    await expect(banners(page).filter({ hasText: "Monitor controls are on" })).toHaveCount(1);
    expect((await dbg(page)).mix.monitorActive).toBe(true);
    expect(await musicPeak(), "the other bus plays on").toBeGreaterThan(0.03);
    await mm("Aux").click();
    await expect(mm("Aux")).toHaveAttribute("aria-pressed", "false");
    await heard(page, "Aux", 1);
    await expect(banners(page).filter({ hasText: "Monitor controls are on" })).toHaveCount(0);
    expect((await dbg(page)).mix.monitorActive).toBe(false);
  });

  await test.step("S: every other bus goes silent, Aux keeps playing, nothing is saved; S again returns the mix", async () => {
    await solo("Aux").click();
    await expect(solo("Aux")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(musicPeak, { timeout: 30_000, message: "Music is silent while Aux is soloed" }).toBeLessThan(0.002);
    expect((await meterWindow(page, "Aux", 0.3)).max, "the soloed bus plays").toBeGreaterThan(TONE_PEAK * 0.93);
    expect((await dbg(page)).mix.monitorActive).toBe(true);
    expect(await savedVolume(page, "Music")).toBe(0.6);
    await solo("Aux").click();
    await expect(solo("Aux")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(musicPeak, { timeout: 30_000 }).toBeGreaterThan(0.03);
  });

  await test.step("a monitor control does not outlive Stop", async () => {
    await mm("Aux").click();
    await expect(mm("Aux")).toHaveAttribute("aria-pressed", "true");
    await stopPlay(page);
    await playLiveMix(page);
    await expect(mm("Aux")).toHaveAttribute("aria-pressed", "false");
    expect((await dbg(page)).mix.monitorActive).toBe(false);
    await heard(page, "Aux", 1);
  });
  expect(errors).toEqual([]);
});

// ---- snapshot buttons ----------------------------------------------------------------------------------------------------------

test("M5c: snapshot buttons are disabled outside Play, one is in force at a time, the one in force fades back to the plain mix, and none is saved", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Aux" }, { bus: "Music" }] });
  await openMixer(page);
  const snap = (name: string) => page.locator(".mixer-snapshots").getByRole("button", { name, exact: true });
  await expect(snap("Muffled")).toBeDisabled();
  await expect(snap("Quiet")).toBeDisabled();
  await playLiveMix(page);
  await heard(page, "Aux", 1);
  await expect(snap("Muffled")).toBeEnabled();

  await test.step("Muffled: Music at 0.3 of its 0.6", async () => {
    await snap("Muffled").click();
    await expect(snap("Muffled")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => gainOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.6 * 0.3, 3);
    await heard(page, "Aux", 1);
  });
  await test.step("Quiet replaces it: Music 0.2 of 0.6, Aux 0.5", async () => {
    await snap("Quiet").click();
    await expect(snap("Quiet")).toHaveAttribute("aria-pressed", "true");
    await expect(snap("Muffled")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => gainOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.6 * 0.2, 3);
    await heard(page, "Aux", 0.5);
  });
  await test.step("the one in force again: back to the plain mix", async () => {
    await snap("Quiet").click();
    await expect(snap("Quiet")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => gainOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.6, 3);
    await heard(page, "Aux", 1);
  });
  await test.step("a snapshot is session state: project.json is unchanged and there is nothing to undo", async () => {
    await snap("Muffled").click();
    await expect.poll(() => gainOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.18, 3);
    expect(await savedVolume(page, "Music")).toBe(0.6);
    expect(await savedVolume(page, "Aux")).toBe(1);
    await focusFader(page, "Aux");
    await page.keyboard.press("Control+z");
    await audioFor(page, 0.3);
    expect(await savedVolume(page, "Music")).toBe(0.6);
    await stopPlay(page);
    await expect(snap("Muffled")).toBeDisabled();
  });
  expect(errors).toEqual([]);
});

// ---- target, Reset, Pause, Compare, clip lamp ----------------------------------------------------------------------------------

test("M5c: the target picker sets every target, Reset and Pause act on the meters and the timer, the clip lamp latches and clears", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Music" }, { bus: "Aux", volume: 20 }] });
  await playLiveMix(page);
  await openMixer(page);
  const loud = (): Promise<{ elapsed: number; paused: boolean }> =>
    page.evaluate(() => {
      const m = (globalThis as unknown as Api).__myco.Audio.bus("Master").loudness;
      return { elapsed: m.elapsed, paused: m.paused };
    });
  const timer = page.getByRole("timer", { name: "Elapsed" });

  await test.step("every option of the target picker sets Audio.loudnessTarget", async () => {
    const select = page.getByRole("combobox", { name: "Loudness target" });
    const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.length, "the default project has more than one target").toBeGreaterThan(1);
    for (const v of [...values, values[0]!]) {
      await select.selectOption(v);
      await expect.poll(() => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.loudnessTarget), { timeout: 10_000 }).toBe(v);
    }
  });
  await test.step("Reset: the meters' elapsed time and the timer go to zero and run on", async () => {
    await expect.poll(async () => (await loud()).elapsed, { timeout: 30_000 }).toBeGreaterThan(2);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(async () => (await loud()).elapsed, { timeout: 10_000 }).toBeLessThan(1.5);
    await expect(timer).toHaveText("0:00");
  });
  await test.step("Pause holds the meters (the audio clock goes on); Resume counts again", async () => {
    const pause = page.getByRole("button", { name: /^(Pause|Resume)$/ });
    await expect(pause).toHaveText("Pause");
    await pause.click();
    await expect(pause).toHaveText("Resume");
    await expect(pause).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await loud()).paused).toBe(true);
    const held = (await loud()).elapsed;
    await audioFor(page, 1.2);
    expect((await loud()).elapsed, "no audio counted while paused").toBe(held);
    await pause.click();
    await expect(pause).toHaveText("Pause");
    await expect.poll(async () => (await loud()).elapsed, { timeout: 20_000 }).toBeGreaterThan(held + 0.5);
    expect((await loud()).paused).toBe(false);
  });
  await test.step("the clip lamp: a bus over full scale latches it; stopping the tone and clicking the lamp clears it", async () => {
    const lamp = page.getByRole("button", { name: "Aux clip", exact: true });
    await expect(lamp).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await toneAction(page, "Aux", "stop");
    await expect.poll(async () => (await meterWindow(page, "Aux", 0.3)).max, { timeout: 30_000 }).toBeLessThan(0.002);
    await expect(lamp).toHaveAttribute("aria-pressed", "true"); // still latched: a latch holds
    await lamp.click();
    await expect(lamp).toHaveAttribute("aria-pressed", "false");
  });
  expect(errors).toEqual([]);
});

test("M5c: Compare plays the saved mix from Play start with the faders locked, saves nothing and leaves the edit's undo step alone", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { tones: [{ bus: "Aux" }] });
  await openMixer(page);
  const compare = page.getByRole("button", { name: "Compare", exact: true });
  await expect(compare, "outside Play there is nothing to compare").toBeDisabled();
  await playLiveMix(page);
  await expect(compare).toBeEnabled();
  await expect(compare).toHaveAttribute("title", /same as at Play start/);
  await focusFader(page, "Aux");
  await page.keyboard.press("PageDown");
  await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBeLessThan(1);
  const v1 = await savedVolume(page, "Aux");
  await heard(page, "Aux", v1);
  await expect(compare).toHaveAttribute("title", /saved mix from Play start/);

  await test.step("on: the Play-start value is heard, the banner shows, the faders are locked", async () => {
    await compare.click();
    await expect(compare).toHaveAttribute("aria-pressed", "true");
    await expect(banners(page).filter({ hasText: "Compare:" })).toHaveCount(1);
    await heard(page, "Aux", 1);
    expect(await savedVolume(page, "Aux"), "nothing saved").toBeCloseTo(v1, 9);
    await focusFader(page, "Aux");
    await page.keyboard.press("ArrowDown");
    await audioFor(page, 0.4);
    expect(await savedVolume(page, "Aux"), "the fader is locked").toBeCloseTo(v1, 9);
    expect(await gainOf(page, "Aux")).toBeCloseTo(1, 3);
  });
  await test.step("off: the edited mix is back", async () => {
    await compare.click();
    await expect(compare).toHaveAttribute("aria-pressed", "false");
    await expect(banners(page).filter({ hasText: "Compare:" })).toHaveCount(0);
    await heard(page, "Aux", v1);
  });
  await test.step("the edit is still the one undo step", async () => {
    await page.keyboard.press("Control+z");
    await expect.poll(() => savedVolume(page, "Aux"), { timeout: 10_000 }).toBe(1);
    await heard(page, "Aux", 1);
  });
  expect(errors).toEqual([]);
});

// ---- the edit classes (architecture 4.7) -------------------------------------------------------------------------------------

/** `mixer.apply(op)` as the editor's section hook does it, through the core backend the page holds (reached through a voice). */
const applyOp = (page: Page, op: object) =>
  page.evaluate((o) => {
    type Backend = { applyOp(op: object): { ok: boolean; class: string; deferred?: string; restartRequired?: string } };
    type Voice = { backend?: Backend; inner?: { backend?: Backend } };
    const A = (globalThis as unknown as { __myco: { Audio: { playOneShot(c: string, o?: object): { voice?: Voice } } } }).__myco.Audio;
    const v = A.playOneShot("audio/loudness-reference.wav", { volume: 0.0001, bus: "UI" }).voice;
    return (v?.backend ?? v?.inner?.backend)!.applyOp(o);
  }, op);

const FX4: MixBus = { name: "Fx", parent: "Master", effects: [{ type: "lowpass", frequency: 18000, q: 1 }, { type: "highpass", frequency: 20, q: 1 }, { type: "compressor", threshold: -24, knee: 30, ratio: 8, attack: 0.003, release: 0.25 }, { type: "reverb", send: 0.2 }] };

test("M5c: every edit class is applied live and kept: direct (volume, mute, send, filter), smoothed (compressor), structural (move, effect removal, bus removal, undo of it) and an added bus", async ({ page }) => {
  const errors = track(page);
  const buses = [...withBus("Aux", { volume: 0.5 }), FX4];
  await openLiveMix(page, { buses, tones: [{ bus: "UI" }, { bus: "Music" }, { bus: "SFX" }, { bus: "Ambience" }, { bus: "Deep" }] });
  await playLiveMix(page);
  await openMixer(page);
  await openAudioSettings(page);
  // The Mixer and Project panels are tabs of one dock: `inMixer` looks at the strips and comes back to the (re-expanded) settings.
  const settings = async () => {
    await openAudioSettings(page);
    for (const b of ["Music", "SFX", "Ambience", "Fx"]) await expandBus(page, b);
  };
  const inMixer = async <T,>(look: () => Promise<T>): Promise<T> => {
    await openMixer(page);
    try {
      return await look();
    } finally {
      await settings();
    }
  };
  await settings();
  const field = (label: string) => audioPanel(page).getByLabel(label, { exact: true });
  const peak = async (bus: string) => {
    await audioFor(page, 1.0);
    return (await meterWindow(page, bus, 0.3)).max;
  };
  await heard(page, "UI", 1);
  const musicBefore = await peak("Music");
  const sfxBefore = await peak("SFX");
  expect(musicBefore).toBeGreaterThan(0.03);
  const counters = await clickCounters(page);

  await test.step("direct: bus volume and mute, heard", async () => {
    await commit(field("UI volume"), "0.5");
    await expect.poll(() => savedVolume(page, "UI"), { timeout: 10_000 }).toBe(0.5);
    await heard(page, "UI", 0.5);
    await field("Mute UI").check();
    await expect.poll(async () => (await savedOf(page, "UI"))!.mute, { timeout: 10_000 }).toBe(true);
    await heard(page, "UI", 0);
    await field("Mute UI").uncheck();
    await heard(page, "UI", 0.5);
  });
  await test.step("direct: a send level is applied without a refusal or a banner and kept", async () => {
    await commit(field("Ambience reverb Send (0-1)"), "1");
    await expect.poll(async () => (await savedOf(page, "Ambience"))!.effects![0]!.send, { timeout: 10_000 }).toBe(1);
    await audioFor(page, 0.5);
    expect((await dbg(page)).mix.liveRefused).toBe(0);
    await inMixer(() => expect(banners(page)).toHaveCount(0));
  });
  await test.step("direct: a filter parameter changes the sound (the 1 kHz tone falls by the 500 Hz low-pass), Q is kept", async () => {
    await commit(field("Music lowpass Frequency (Hz)"), "500");
    await expect.poll(async () => (await savedOf(page, "Music"))!.effects![1]!.frequency, { timeout: 10_000 }).toBe(500);
    const after = await peak("Music");
    expect(after / musicBefore, "about -11 dB: a 1 kHz tone two times over the cut-off").toBeGreaterThan(0.2);
    expect(after / musicBefore).toBeLessThan(0.4);
    await commit(field("Music lowpass Q"), "2");
    await expect.poll(async () => (await savedOf(page, "Music"))!.effects![1]!.q, { timeout: 10_000 }).toBe(2);
  });
  await test.step("smoothed: a compressor threshold changes the level and the level settles", async () => {
    await commit(field("SFX compressor Threshold (dB)"), "-60");
    await expect.poll(async () => (await savedOf(page, "SFX"))!.effects![0]!.threshold, { timeout: 10_000 }).toBe(-60);
    const a = await peak("SFX");
    expect(Math.abs(a - sfxBefore) / sfxBefore, "the compressor acts differently").toBeGreaterThan(0.1);
    const b = await peak("SFX");
    expect(Math.abs(b - a) / a, "settled").toBeLessThan(0.03);
  });
  await test.step("structural: moving Deep under Master raises its effective gain from 0.5 to 1 (a dip, then the new place)", async () => {
    await inMixer(() => expect(strip(page, "Deep")).toHaveAttribute("data-depth", "2"));
    expect(await gainOf(page, "Deep")).toBeCloseTo(0.5, 3);
    await audioPanel(page).getByLabel("Deep parent", { exact: true }).selectOption("Master");
    await expect.poll(async () => (await savedOf(page, "Deep"))!.parent, { timeout: 10_000 }).toBe("Master");
    await expect.poll(() => gainOf(page, "Deep"), { timeout: 20_000 }).toBeCloseTo(1, 3);
    await inMixer(() => expect(strip(page, "Deep")).toHaveAttribute("data-depth", "1"));
    await audioFor(page, 0.6);
  });
  await test.step("structural: removing the low-pass puts the Music tone back at its first level", async () => {
    await page.getByRole("button", { name: "Remove Music lowpass effect", exact: true }).click();
    await expect.poll(async () => (await savedOf(page, "Music"))!.effects!.length, { timeout: 10_000 }).toBe(1);
    const after = await peak("Music");
    expect(Math.abs(after - musicBefore) / musicBefore).toBeLessThan(0.08);
  });
  const names = () => page.evaluate(() => [...(globalThis as unknown as Api).__myco.Audio.buses]);
  await test.step("structural: removing a bus with a sound on it takes it from the mixer and the strips, and its sound moves to the root", async () => {
    await audioPanel(page).getByRole("button", { name: "Remove bus Deep", exact: true }).click();
    await expect.poll(names, { timeout: 20_000 }).not.toContain("Deep");
    await inMixer(() => expect(strip(page, "Deep")).toHaveCount(0));
    await expect.poll(async () => (await dbg(page)).voices.filter((v) => v.clip.includes("loudness-reference") && v.bus === "Deep").length, { timeout: 20_000 }).toBe(0);
    expect((await dbg(page)).voices.some((v) => v.clip.includes("loudness-reference") && v.bus === "Master"), "the sound plays on at the root").toBe(true);
    await audioFor(page, 0.5);
  });
  await test.step("structural: undo brings the bus back (the Project Settings history's Undo)", async () => {
    await page.locator(".panel.project .project-settings-toolbar").getByRole("button", { name: "Undo" }).click();
    await expect.poll(names, { timeout: 30_000 }).toContain("Deep");
    await inMixer(() => expect(strip(page, "Deep")).toHaveCount(1));
  });
  await test.step("direct: an added bus is live at once", async () => {
    const before = await names();
    await audioPanel(page).getByRole("button", { name: "Add child bus to Aux", exact: true }).click();
    await expect.poll(async () => (await names()).length, { timeout: 20_000 }).toBe(before.length + 1);
    const added = (await names()).find((n) => !before.includes(n))!;
    await inMixer(() => expect(strip(page, added)).toHaveCount(1));
    await expect.poll(async () => (await dbg(page)).mix.slots.find((s) => s.name === added)?.state, { timeout: 20_000 }).toBe("live");
    expect((await savedProject(page)).audio!.buses!.map((b) => b.name)).toContain(added);
  });
  await test.step("no click: no record was late, early or refused, and no trap, across all of it", async () => {
    expect(await clickCounters(page)).toEqual(counters);
    test.info().annotations.push({ type: "underruns", description: `${(await dbg(page)).counters.underruns} (reported, not asserted)` });
  });
  expect(errors).toEqual([]);
});

test("M5c: a fifth effect is refused live with the message that it applies at the next Play, and the refusal is counted", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { buses: [...BUSES, FX4], tones: [{ bus: "UI" }] });
  await playLiveMix(page);
  await openMixer(page);
  await openAudioSettings(page);

  await test.step("the fifth effect: the mixer answers that it applies at the next Play, and counts the refusal", async () => {
    const refused = (await dbg(page)).mix.liveRefused;
    const r = await applyOp(page, { op: "addEffect", bus: "Fx", index: 4, effect: { type: "lowpass", frequency: 8000, q: 1 } });
    expect(r.ok).toBe(false);
    expect(r.restartRequired).toMatch(/a bus takes at most 4 effects while playing; this one applies at the next Play/);
    expect((await dbg(page)).mix.liveRefused).toBe(refused + 1);
  });
  expect(errors).toEqual([]);
});

test("M5c: an add that finds no free slot is deferred (kept, and live at the next recycle), with every slot of 32 in use", async ({ page }) => {
  const errors = track(page);
  const many: MixBus[] = [{ name: "Master" }, ...Array.from({ length: 31 }, (_, i) => ({ name: `B${String(i + 1).padStart(2, "0")}`, parent: "Master" }))];
  await openLiveMix(page, { buses: many, tones: [{ bus: "B01" }] });
  await playLiveMix(page);
  await audioFor(page, 0.5);
  const r = await page.evaluate(() => {
    type Res = { ok: boolean; class: string; deferred?: string };
    type Backend = { applyOp(op: object): Res };
    type Voice = { backend?: Backend; inner?: { backend?: Backend } };
    const A = (globalThis as unknown as { __myco: { Audio: { playOneShot(c: string, o?: object): { voice?: Voice } } } }).__myco.Audio;
    const v = A.playOneShot("audio/loudness-reference.wav", { volume: 0.0001, bus: "B01" }).voice;
    const b = (v?.backend ?? v?.inner?.backend)!;
    // One task: the removed bus is a tombstone still holding its slot when the add arrives.
    const removed = b.applyOp({ op: "removeBus", bus: "B31" });
    const added = b.applyOp({ op: "addBus", name: "Late", parent: "Master" });
    return { removed, added };
  });
  expect(r.removed.ok).toBe(true);
  expect(r.added.ok, "kept, not refused").toBe(true);
  expect(r.added.deferred).toMatch(/free bus slot/);
  await expect.poll(async () => (await dbg(page)).mix.liveDeferred, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await dbg(page)).mix.slots.find((s) => s.name === "Late")?.state, { timeout: 30_000, message: "the deferred add is live after the recycle" }).toBe("live");
  expect((await dbg(page)).mix.liveRefused).toBe(0);
  expect(errors).toEqual([]);
});

// The design (architecture 4.7, api-and-models 7): an edit with no live path "applies at the next Play" and the Mixer says so. The op log
// (`mix/opLog.ts`, `createOpLog`) returns before it records an entry when a change has no ops (`if (ops.length === 0) return;`), so an
// edit that only touches a key with no live path (the AAC codec checkbox here) never reaches the banner's `restartRequired` list, and the
// fifth effect added through Project Settings is not saved at all (the draft has the parse's "runs only the first 4 effects" problem:
// "Not saved: 1 problem"). Neither can be driven from the editor until the log records those; this case is the check for when it does.
test.fixme("M5c: an edit with no live path (the AAC codec) is saved and the Mixer's banner says it applies at the next Play", async ({ page }) => {
  await openLiveMix(page, { tones: [{ bus: "UI" }] });
  await playLiveMix(page);
  await openAudioSettings(page);
  await audioPanel(page).getByLabel("AAC codec", { exact: true }).click();
  await openMixer(page);
  await expect(banners(page).filter({ hasText: "Applies at the next Play" }).first()).toBeVisible({ timeout: 20_000 });
});

// ---- level ducking, audible ----------------------------------------------------------------------------------------------------

/** The lowest duck gain of Music over `seconds` of the audio clock. */
const meterDuck = (page: Page, seconds: number) =>
  page.evaluate(async (span) => {
    const A = (globalThis as unknown as Api).__myco.Audio;
    const t0 = A.time;
    let min = 1;
    while (A.time < t0 + span) {
      min = Math.min(min, A.bus("Music").duckGain);
      await new Promise((r) => setTimeout(r, 10));
    }
    return { min };
  }, seconds);

const LEVEL = { target: "Music", trigger: "SFX", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.05, release: 0.4 };
const DUCK_DB = -20 * Math.log10(LEVEL.amount);

test("M5c: a level rule ducks its target to the rule's amount while the trigger is over the threshold, and lets go on release; the strip's gain reduction meter shows it", async ({ page }) => {
  const errors = track(page);
  // The trigger is the tone at full scale: -23 dBFS peak is -26 dBFS RMS, over the rule's -30.
  await openLiveMix(page, { audio: { ducking: [LEVEL] }, tones: [{ bus: "Music" }, { bus: "SFX", playOnAwake: false }, { bus: "SFX", volume: 0.02, playOnAwake: false, label: "SFX quiet" }] });
  await playLiveMix(page);
  await openMixer(page);
  const gr = page.getByRole("meter", { name: "Music gain reduction", exact: true });
  await heard(page, "Music", 0.6);
  expect(await duckOf(page, "Music"), "nothing on the trigger yet").toBe(1);
  await expect(gr, "a level-ducked bus always shows its gain reduction").toBeVisible();
  const counters = await clickCounters(page);

  await test.step("the trigger over the threshold: the target falls to the amount (on the audio clock)", async () => {
    await toneAction(page, "SFX", "play");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000, message: "ducked to the amount" }).toBeCloseTo(LEVEL.amount, 2);
    expect(await gainOf(page, "Music"), "effective gain carries it").toBeCloseTo(0.6 * LEVEL.amount, 2);
    await expect.poll(async () => Number(await gr.getAttribute("aria-valuenow")), { timeout: 10_000 }).toBeCloseTo(DUCK_DB, 0);
    const d = (await dbg(page)).mix.ducking.find((r) => r.target === "Music")!;
    expect(d).toMatchObject({ trigger: "SFX", mode: "level" });
    expect(d.gain).toBeCloseTo(LEVEL.amount, 2);
    // Heard: the Music bus's tone is down by the duck (its filters are at 1 kHz ~ unity), against its own reading before.
    await audioFor(page, 1.2);
    expect((await meterWindow(page, "Music", 0.3)).max, "Music's meter at 0.18 of the tone").toBeLessThan(TONE_PEAK * 0.6 * 0.5);
  });
  await test.step("the trigger stops: released back to 1 on the audio clock", async () => {
    await toneAction(page, "SFX", "stop");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 3);
    await heard(page, "Music", 0.6);
  });
  await test.step("a trigger under the threshold does not duck (the tone at 0.02 is -52 dBFS RMS)", async () => {
    await toneAction(page, "SFX quiet", "play");
    // The voice's first quanta read louder than its -52 dBFS (a shallow dip, measured to 0.82 at the start and gone in 2 s): never
    // the rule's amount, and gone by the time it has played.
    const w = await meterDuck(page, 2.5);
    expect(w.min, "nowhere near the amount").toBeGreaterThan(0.7);
    expect(await duckOf(page, "Music")).toBeGreaterThan(0.995);
    await toneAction(page, "SFX quiet", "stop");
  });
  expect(await clickCounters(page), "no late, early or refused record, no underrun, no late sidechain").toEqual(counters);
  expect(errors).toEqual([]);
});

test("M5c: every level-rule setting is live: threshold, detector, amount and mode (level against presence) change the duck while the trigger plays", async ({ page }) => {
  const errors = track(page);
  await openLiveMix(page, { audio: { ducking: [LEVEL] }, tones: [{ bus: "Music" }, { bus: "SFX", playOnAwake: false }, { bus: "SFX", volume: 0.02, playOnAwake: false, label: "SFX quiet" }, { bus: "SFX", clip: "audio/drum-loop.wav", playOnAwake: false, label: "SFX drum" }] });
  await playLiveMix(page);
  await openMixer(page);
  await openAudioSettings(page);
  const rule = (label: string) => audioPanel(page).getByLabel(`Ducking 1 ${label}`, { exact: true });
  const ruleSaved = async () => ((await savedProject(page)).audio!.ducking as Record<string, unknown>[])[0]!;
  /** The mean duck gain of Music over `seconds` of the audio clock. */
  const meanDuck = (seconds: number) =>
    page.evaluate(async (span) => {
      const A = (globalThis as unknown as Api).__myco.Audio;
      const t0 = A.time;
      let sum = 0, n = 0;
      while (A.time < t0 + span) {
        sum += A.bus("Music").duckGain;
        n++;
        await new Promise((r) => setTimeout(r, 20));
      }
      return sum / n;
    }, seconds);
  await heard(page, "Music", 0.6);
  await toneAction(page, "SFX", "play");
  await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.3, 2);

  await test.step("threshold above the trigger's RMS (-26): released; below it: ducked again", async () => {
    await commit(rule("threshold"), "-20");
    await expect.poll(async () => (await ruleSaved()).threshold, { timeout: 10_000 }).toBe(-20);
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
    await commit(rule("threshold"), "-40");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.3, 2);
  });
  await test.step("amount: the target goes to the new multiplier", async () => {
    await commit(rule("amount"), "0.5");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.5, 2);
    expect(await gainOf(page, "Music")).toBeCloseTo(0.3, 2);
    await commit(rule("amount"), "0.3");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(0.3, 2);
  });
  await test.step("detector: on a bursty trigger (the drum loop) at -12 dBFS the peak detector ducks deeper than RMS", async () => {
    await toneAction(page, "SFX", "stop");
    await commit(rule("threshold"), "-12");
    await toneAction(page, "SFX drum", "play");
    await audioFor(page, 1.5);
    const rms = await meanDuck(2);
    await rule("detector").selectOption("peak");
    await expect.poll(async () => (await ruleSaved()).detector, { timeout: 10_000 }).toBe("peak");
    await audioFor(page, 1.5);
    const peak = await meanDuck(2);
    expect(peak, `peak ${peak.toFixed(3)} against RMS ${rms.toFixed(3)}`).toBeLessThan(rms - 0.08);
    await rule("detector").selectOption("rms");
    await audioFor(page, 1.5);
    expect(await meanDuck(2), "RMS again: as before").toBeGreaterThan(peak + 0.08);
    await toneAction(page, "SFX drum", "stop");
    await commit(rule("threshold"), "-40");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
  });
  await test.step("mode: a quiet trigger ducks under presence and not under level, on the same target", async () => {
    await commit(rule("threshold"), "-30");
    await toneAction(page, "SFX quiet", "play");
    expect((await meterDuck(page, 2.5)).min, "level: -52 dBFS is under the threshold (only the start's dip)").toBeGreaterThan(0.7);
    await rule("mode").selectOption("presence");
    await expect.poll(async () => (await ruleSaved()).mode, { timeout: 10_000 }).toBe("presence");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000, message: "presence: a voice on the trigger ducks" }).toBeCloseTo(0.3, 2);
    await rule("mode").selectOption("level");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
    await toneAction(page, "SFX quiet", "stop");
  });
  await test.step("undo walks the edits back through the shared history", async () => {
    await page.locator(".panel.project .project-settings-toolbar").getByRole("button", { name: "Undo" }).click(); // the last edit was mode back to level: undone, the rule is presence again
    await expect.poll(async () => (await ruleSaved()).mode, { timeout: 10_000 }).toBe("presence");
    await toneAction(page, "SFX quiet", "play");
    await expect.poll(() => duckOf(page, "Music"), { timeout: 20_000, message: "presence again: the quiet voice ducks" }).toBeCloseTo(0.3, 2);
  });
  expect(errors).toEqual([]);
});
