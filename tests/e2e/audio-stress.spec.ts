import { expect, type Page, play, test } from "./fixtures";

// The audio stress sample (C1, ADR 0157; samples/stress): the soak's content in a real browser, for a minute. It drives
// the core with generated clips (about 64 MB, shuffled), 32 buses with effects, streams, moving HRTF sources, bus churn
// and a start rate of about 200 a second, and reads the core's own counters (`Audio.debug()`, through the sample's
// `__stress` handle). Headless Chromium has no sound output and shares a few cores with software rendering, so this
// checks that the core RUNS under the load and degrades the way the design says (the adaptive cap), not that it meets the
// soak gate (0 underruns on the gate machines, C3). It prints the counters so a run doubles as a data point.
const STRESS = "/editor.html?sample=stress";
const STORM_SECONDS = 60;

test.describe.configure({ timeout: 360_000 });

type Stats = {
  phase: string;
  stormSeconds: number;
  started: number;
  startedPlaying: number;
  clipMB: number;
  clipCount: number;
  sample: {
    status: string;
    underruns: number;
    logicalVoices: number;
    mixedVoices: number;
    mixedCap: number;
    hrtfVoices: number;
    hrtfFlagged: number;
    workUnits: number;
    workUnitsMax: number;
    streams: number;
    streamStarves: number;
    streamErrors: number;
    traps: number;
    rebuilds: number;
    droppedPlays: number;
  } | null;
  underrunsSinceStart: number;
  lateSinceStart: number;
  starvesSinceStart: number;
  capMin: number;
  capMax: number;
  logicalMax: number;
  mixedMax: number;
  hrtfMax: number;
  hrtfFlaggedMax: number;
  wuMax: number;
  stalls: number;
  maxGapMs: number;
  capHistory: number[];
};

const stats = (page: Page) =>
  page.evaluate(() => {
    const h = (globalThis as unknown as { __stress?: { stats(): unknown } }).__stress;
    return h ? (h.stats() as Stats) : null;
  });

test("the stress sample runs for a minute: thousands of voices, the cap adapts, no stream starves", { tag: "@slow" }, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(STRESS);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await play(page);
  await page.mouse.click(480, 250); // the gesture that unlocks the context

  await test.step("the clips are generated and loaded, then the storm starts", async () => {
    await expect.poll(async () => (await stats(page))?.phase, { timeout: 120_000 }).toBe("running");
    const s = (await stats(page))!;
    // Architecture 6.5: at least 64 MB of distinct clips (the generator makes 64 MiB).
    expect(s.clipMB).toBeGreaterThanOrEqual(63);
    expect(s.clipCount).toBeGreaterThan(300);
    expect(s.sample!.status).toBe("running");
  });

  const t0 = Date.now();
  const log: string[] = [];
  while (Date.now() - t0 < STORM_SECONDS * 1000) {
    await page.waitForTimeout(10_000);
    const s = (await stats(page))!;
    const c = s.sample!;
    log.push(
      `t=${((Date.now() - t0) / 1000).toFixed(0)}s logical=${c.logicalVoices} mixed=${c.mixedVoices}/${c.mixedCap} hrtf=${c.hrtfFlagged}(rendering ${c.hrtfVoices}) underruns=${s.underrunsSinceStart} late=${s.lateSinceStart} starves=${s.starvesSinceStart} dropped=${c.droppedPlays} wu=${c.workUnits}(max ${c.workUnitsMax}) stalls=${s.stalls}`,
    );
  }
  const s = (await stats(page))!;
  const c = s.sample!;
  // The numbers, for the build log (`--reporter=list` shows them).
  console.log(`[stress] ${log.join("\n[stress] ")}`);
  console.log(
    `[stress] summary: started ${s.started} (${s.startedPlaying} playing) in ${s.stormSeconds.toFixed(0)} s; logical peak ${s.logicalMax}, mixed peak ${s.mixedMax}, hrtf peak ${s.hrtfFlaggedMax} flagged (${s.hrtfMax} rendering), cap ${s.capMin}..${s.capMax}, underruns ${s.underrunsSinceStart}, late ${s.lateSinceStart}, starves ${s.starvesSinceStart}, work units max ${s.wuMax}, main stalls >100 ms ${s.stalls} (longest ${Math.round(s.maxGapMs)} ms)`,
  );

  await test.step("it ran: voices in the thousands, streams and moving sources alive", async () => {
    expect(c.status).toBe("running");
    expect(s.stormSeconds).toBeGreaterThan(STORM_SECONDS - 5);
    // About 200 starts a second after the warm-up (the generous floor allows for a slow machine's frames).
    expect(s.startedPlaying).toBeGreaterThan(s.stormSeconds * 100);
    // The beds' prefill fills the logical voices: well into the thousands (the limit is 4,096).
    expect(s.logicalMax).toBeGreaterThan(2000);
    expect(s.mixedMax).toBeGreaterThan(32);
    // The HRTF cap (ADR 0162) is main's choice: the high preset's 8 voices, the ones past it on the bed. The core's own
    // `hrtfVoices` also counts a voice handed to the bed while it crossfades out (45 ms, beside the one that took its
    // place), so it reads 9 or 10 when a reading lands in a handover; the more handovers (a loaded machine's longer frames
    // move the sources further between picks), the likelier. That count is the panners' cost, by design (H3; the
    // work-unit model charges it); `hrtfLoopback.test.ts` pins it: the limit plus the outgoing voice for the crossfade,
    // then the limit. Here the cap is checked where it is promised, and the core stays inside its bank of 32.
    expect(s.hrtfFlaggedMax).toBeGreaterThan(0);
    expect(s.hrtfFlaggedMax).toBeLessThanOrEqual(8);
    expect(s.hrtfMax).toBeGreaterThan(0);
    expect(s.hrtfMax).toBeLessThanOrEqual(32);
    // Eight looping streams, open the whole time.
    expect(c.streams).toBe(8);
  });

  await test.step("the cap adapts and does not collapse for good", async () => {
    // The cap may drop under load (that is the design) but it recovers: over the last 20 s (40 readings) it was not pinned at
    // its floor of 16, and it is above that now.
    expect(s.capMax).toBeGreaterThan(16);
    const tail = s.capHistory.slice(-40);
    expect(Math.max(...tail)).toBeGreaterThan(16);
    expect(c.mixedCap).toBeGreaterThanOrEqual(16);
    expect(c.traps).toBe(0);
    expect(c.rebuilds).toBe(0);
  });

  await test.step("no stream starves, nothing errors, underruns stay bounded", async () => {
    expect(s.starvesSinceStart).toBe(0);
    expect(c.streamErrors).toBe(0);
    // Headless Chromium renders in software and runs the audio thread on the same few cores, so a minute at the full
    // load may underrun now and then (the soak's 0-underrun gate is for the gate machines). A core that can't keep up
    // underruns on every quantum (375 a second), and the cap exists to prevent that, so 1,000 over the minute (about
    // 3 s of audio) still catches a collapse. The numbers print above.
    expect(s.underrunsSinceStart).toBeLessThanOrEqual(1000);
    expect(errors).toEqual([]);
  });
});
