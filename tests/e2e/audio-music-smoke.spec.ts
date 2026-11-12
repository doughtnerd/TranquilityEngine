import { expect, openTestProject, type Page, play, test } from "./fixtures";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";
import { bootSample, musicRows, peakOver as peakOverMusic, readLate } from "./audioMusic";

// M4 smoke (ADR 0166/0167, plan task S0): the milestone's path in the real app, through the Sound Lab sample. One playing
// voice gets a stamped, shaped fade (`AudioVoice.fadeShaped` with `at`: a FADE with a frame offset) and a spatial one-shot
// with sends and non-default effects is played at a future audio-clock time (a stamped PLAY, with its SET_VOICE_FX at the
// same frame, coreBackend.ts "its SET_VOICE_FX at the same frame"). Since the in-voice flip (Z3) both apply inside their
// voices, so `splitQuanta` reads 0 (M4-0's exit check). Later waves grow this file by one case each.
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
const reportedSplitQuanta = (d: Debug): number | null => d.musicTotals?.splitQuanta ?? (typeof d.core.splitQuanta === "number" ? d.core.splitQuanta : null);

/**
 * The core's `splitQuanta`: `Audio.debug()`'s field once P10 reports it, else the STATUS mirror `Audio.debug()` itself reads
 * (`CoreBackend.mirror`, reached through the faded voice's backend, `__smokeBackend`; TypeScript-private, a plain property
 * at run time). Null only when neither exists.
 */
const readSplitQuanta = async (page: Page, d: Debug): Promise<number | null> =>
  reportedSplitQuanta(d) ??
  (await page.evaluate(() => {
    const backend = (globalThis as unknown as { __smokeBackend?: { mirror?: { splitQuanta?: number } } }).__smokeBackend;
    return typeof backend?.mirror?.splitQuanta === "number" ? backend.mirror.splitQuanta : null;
  }));

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
  const splitBefore = reportedSplitQuanta(base);

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
    // Stamped (Z3): `AudioVoice.fadeShaped` with `at` ahead of the audio clock writes a FADE with a frame offset, which
    // the in-voice flip applies inside the voice. No public call stamps a fade yet, so the spec reaches the event
    // instance's voices (`EventHandle.instance`, `EventInstance.voices`, both TypeScript-private, plain properties at run time).
    const stamped = await page.evaluate(() => {
      type ShapedVoice = { fadeShaped?(f: { to: number; seconds: number; law: string; at?: number }): void; backend?: unknown };
      const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
      const h = (globalThis as unknown as { __smokeFade: { instance?: { voices?: { voice: ShapedVoice }[] } } }).__smokeFade;
      const voices = h.instance?.voices ?? [];
      const at = Audio.time + 0.2;
      let n = 0;
      for (const { voice } of voices) {
        if (!voice.fadeShaped) continue;
        voice.fadeShaped({ to: 0, seconds: 0.3, law: "linear", at });
        (globalThis as unknown as { __smokeBackend?: unknown }).__smokeBackend ??= voice.backend;
        n++;
      }
      return n;
    });
    expect(stamped, "the core voice takes a stamped, shaped fade").toBeGreaterThan(0);
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

  await test.step("splitQuanta reads 0 (M4-0's exit check)", async () => {
    const after = (await audioDebug(page))!;
    const split = await readSplitQuanta(page, after);
    info.annotations.push({ type: "splitQuanta", description: `${split} (before the plays: ${splitBefore})` });
    // The in-voice flip (Z2a-Z2c): the stamped fade and the stamped play with sends apply inside their voices.
    expect(split, "Audio.debug() reports splitQuanta (musicTotals, else the core group)").not.toBeNull();
    expect(split).toBe(0);
    expect(errors).toEqual([]);
    expect(after.status).toBe("running");
  });
});

// M4a (E1): a segment starts on the core and its group reports `start`: the sound-lab's `music-intensity` segment (three stems,
// 120 bpm) is played through `Audio.play`; the music row reaches `playing`, its one group is `playing` with all three stems primed,
// no group is late and no quantum is split. The full M4a path (stems, playlists, transitions, stingers) is audio-music-a.spec.ts.
test("M4a smoke: a segment starts and its group reports start", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await bootSample(page, LAB);
  await page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
    (globalThis as unknown as { __m4a: unknown }).__m4a = Audio.play("audio/events/music-intensity.audioevent.json");
  });
  await expect.poll(async () => (await musicRows(page)).find((r) => r.asset.includes("music-intensity"))?.state, { timeout: 30_000 }).toBe("playing");
  const row = (await musicRows(page)).find((r) => r.asset.includes("music-intensity"))!;
  expect(row.segment).toBe("intensity");
  expect(row.groups.map((g) => ({ state: g.state, primed: g.primed, of: g.of }))).toEqual([{ state: "playing", primed: 3, of: 3 }]);
  const late = await readLate(page);
  expect(late, "no group late, held or abandoned; no slip; no split").toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  expect(errors).toEqual([]);
});

// M4b smoke (E2): the Sound Lab's music page (SM2; key M on the tour). A state key changes the world switch on a bar line by the
// rule for the pair and the debug row names that rule, a stinger plays over the music, and the core's counters stay clean. The
// page's clips are decoded by silent one-shots first: a segment's first play, with its clips never decoded, ends at its first
// loop end (the fixme in audio-music-b.spec.ts). The full M4b path is audio-music-b.spec.ts.
test("M4b smoke: a state key changes the music on a bar by the named rule, and a stinger plays over it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await bootSample(page, LAB);
  await page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
    for (const c of ["bridge-riser", "calm-bells", "calm-pad", "combat-bass", "combat-drums", "explore-arp", "explore-pad", "loop-body", "stinger-hit"]) Audio.playOneShot(`audio/music/${c}.wav`, { volume: 0.0001, bus: "UI" });
  });
  await page.waitForTimeout(2_500);
  await page.keyboard.press("m");
  const world = async () => (await musicRows(page)).find((r) => r.asset.includes("music-world"));
  await expect.poll(async () => (await world())?.state, { timeout: 30_000, message: "the world switch plays" }).toBe("playing");
  expect((await world())!.segment).toBe("explore");
  await page.keyboard.press("2");
  let rule: { to: string; ruleKey: string; rule: number; tier: number } | null = null;
  await expect
    .poll(
      async () => {
        const row = await world();
        if (row?.pending) rule = { to: row.pending.to, ruleKey: row.pending.ruleKey, rule: row.pending.rule, tier: row.pending.tier };
        return row?.segment;
      },
      { timeout: 20_000, intervals: [50], message: "the change to combat lands" },
    )
    .toBe("combat");
  expect(rule, "the row named the rule that chose the change").toEqual({ to: "combat", ruleKey: "explore>combat", rule: 0, tier: 1 });
  await expect.poll(async () => (await world())?.pending ?? null, { timeout: 10_000 }).toBeNull();
  await page.keyboard.press("t");
  await expect.poll(async () => (await world())?.stingers.played, { timeout: 10_000, message: "the stinger is played" }).toBe(1);
  expect((await world())!.segment, "the music carries on").toBe("combat");
  expect(await peakOverMusic(page, "Music", 600), "the Music bus is audible").toBeGreaterThan(0.01);
  const late = await readLate(page);
  expect(late, "no group late, held or abandoned; no slip; no split").toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  expect(errors).toEqual([]);
});

// M4c smoke (E3): the Sound Lab's rhythm page (key R on the tour). C starts a calibration on the click track; 20 taps are injected
// through `__rhythmLab.tap(performanceTime)` on a known +30 ms from the beat, and the page's result reads that offset and applies it to
// `Audio.calibration`; G starts the tap game, where a tap on the calibrated zero is a PERFECT; a script's `handle.onMusic("beat")`
// is called. The full M4c path (hooks, cues, unsubscribe, reload, the stale flag, the grades) is audio-music-c.spec.ts.
test("M4c smoke: a calibration run on the rhythm page reads the injected offset and sets Audio.calibration, and a tap on it is perfect", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await bootSample(page, LAB);
  await page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
    for (const c of ["click-track", "combat-drums", "combat-bass"]) Audio.playOneShot(`audio/music/${c}.wav`, { volume: 0.0001, bus: "UI" });
  });
  await page.waitForTimeout(2_500);
  await page.keyboard.press("r");
  type Lab = { state(): { mode: string; beats: number; result: { offsetMs: number; steady: boolean; applied: boolean } | null; calibrationMs: number; last: { grade: string; judgedMs: number } | null }; tap(t: number): unknown; page: { handle: { music: { nextGrid(k: string): { time: number } } } } };
  const state = () => page.evaluate(() => (globalThis as unknown as { __rhythmLab: Lab }).__rhythmLab.state());
  await expect.poll(() => page.evaluate(() => !!(globalThis as unknown as { __rhythmLab?: unknown }).__rhythmLab), { timeout: 15_000 }).toBe(true);
  await page.keyboard.press("c");
  await expect.poll(async () => (await state()).beats, { timeout: 20_000, message: "the click track plays and its beats are counted" }).toBeGreaterThan(1);
  // Twenty taps (the page drops the first 4), each aimed 30 +- 4 ms after the next beat's heard time.
  const tapAll = (offsets: number[]) =>
    page.evaluate((offs) => {
      const g = globalThis as unknown as { __myco: { Audio: { timeAt(p: number): number } }; __rhythmLab: Lab };
      for (const off of offs) {
        const T = g.__rhythmLab.page.handle.music.nextGrid("beat").time;
        const p0 = performance.now();
        g.__rhythmLab.tap(p0 + (T - g.__myco.Audio.timeAt(p0)) * 1000 + off);
      }
    }, offsets);
  await tapAll([...Array(4).fill(100), ...[26, 34, 30, 28, 32, 30, 27, 33, 30, 29, 31, 30, 26, 34, 30, 30]]);
  const done = await state();
  expect(done.result, "a steady run is applied").toMatchObject({ steady: true, applied: true });
  expect(done.result!.offsetMs, "the result reads the injected offset").toBeGreaterThan(26);
  expect(done.result!.offsetMs).toBeLessThan(34);
  expect(done.calibrationMs, "Audio.calibration is the result").toBeCloseTo(done.result!.offsetMs, 6);
  // The tap game: a tap at the calibrated offset is on the zero.
  await page.keyboard.press("g");
  await expect.poll(async () => (await state()).mode, { timeout: 20_000 }).toBe("game");
  await expect.poll(async () => (await state()).beats, { timeout: 20_000 }).toBeGreaterThan(1);
  await tapAll([done.result!.offsetMs]);
  const last = (await state()).last!;
  expect(last.grade, "a tap on the calibrated zero").toBe("perfect");
  expect(Math.abs(last.judgedMs), "judged against the calibration").toBeLessThan(5);
  // handle.onMusic: a script that plays music itself hears its beats.
  const beats = await page.evaluate(async () => {
    const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
    const h = Audio.play("audio/music/rhythm-click.audioevent.json") as unknown as { onMusic(k: string, f: () => void): () => void; stop(s?: number): void };
    let n = 0;
    const off = h.onMusic("beat", () => n++);
    await new Promise((r) => setTimeout(r, 4_000));
    off();
    h.stop();
    return n;
  });
  expect(beats, "about two beats a second reach the script").toBeGreaterThanOrEqual(3);
  const late = await readLate(page);
  expect(late, "no group late, held or abandoned; no slip; no split").toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  expect(errors).toEqual([]);
});

test("M4 editor smoke: Project Settings > Audio shows the Music block, and a ring edit is saved with the preset reading custom", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page);
  await showTab(page, /^Project/);
  await pickCategory(page, "Audio");
  const audio = page.locator(".panel.project").getByRole("group", { name: "Audio settings" });
  await expect(audio.locator(".project-settings-list-head", { hasText: /^Music/ })).toBeVisible();
  const rings = audio.getByLabel("Music rings", { exact: true });
  await expect(rings).toHaveValue("12");
  await rings.fill("10");
  await rings.press("Enter");
  const saved = () => page.evaluate(() => JSON.parse((window as unknown as { testFolder: { read(p: string): string | undefined } }).testFolder.read("project.json")!).audio?.music?.rings as number | undefined);
  await expect.poll(saved).toBe(10);
  await expect(audio.getByLabel("Voices preset", { exact: true })).toHaveValue("custom");
});
