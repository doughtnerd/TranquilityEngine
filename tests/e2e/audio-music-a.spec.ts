import { expect, type Page, test } from "./fixtures";
import {
  addAssets, audioDebug, bootSample, event, FLAPPY, INTENSITY_EVENT, LAB, layered, musicRows, offGrid, pauseWorkers, peakOver, playlist3, readLate, SINES, snap, startEvent, stems8, switchAB, watchConsole, withStinger,
  type Row,
} from "./audioMusic";

// Interactive music, milestone M4a (ADR 0166/0167; waves plan, task E1): the milestone's path in the real browser, on the
// core backend (one case on Babylon). The cases open the Sound Lab (or the Flappy sample) in Play mode, add music events built
// from the lab's clips (`audioMusic.ts`) and observe them through `Audio.debug()` (the `music` rows, `musicTotals`:
// `maxSlipFrames`, `splitQuanta`; the core's `groupsLate` from the STATUS mirror) and the bus meters. The events play on the Tape
// bus, so its meter shows the music alone. Headless Chromium has no sound output: the meters and counters are the proof, the
// listening section (audio-music-listening.spec.ts, M4a) is the ear's. Frames are capped (tests/e2e/README.md), so the
// tolerances are in tenths of a second; the sample-exact claims are the loopback tests' (T1) and the cargo goldens' (C3).
//
// The 10-minute playlist (M4a's exit check) is `@slow`: `npm run test:e2e:slow -- audio-music-a --repeat-each 3`.
// `E2E_PLAYLIST_SECONDS` shortens it for a trial run.
test.describe.configure({ timeout: 150_000 });

type G = { __myco: { Audio: { time: number } }; __e1: Record<string, { setParameter(n: string, v: string | number): void; trigger(n: string): boolean; stop(s?: number): void }> };
const audioTime = (page: Page) => page.evaluate(() => (globalThis as unknown as G).__myco.Audio.time);

/** The core's group counters stayed clean: no group late, held or abandoned, no slip, no quantum split by music. */
async function expectClean(page: Page, what: string): Promise<void> {
  expect(await readLate(page), `${what}: the core's group counters`).toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  const d = (await audioDebug(page))!;
  expect(d.musicTotals?.splitQuanta, `${what}: splitQuanta`).toBe(0);
  expect(d.musicTotals?.maxSlipFrames, `${what}: maxSlipFrames`).toBe(0);
  expect(d.musicTotals?.musicRingRefused, `${what}: no ring refused`).toBe(0);
  for (const r of d.music ?? []) expect({ late: r.lateGroups, held: r.groupsHeld, timeouts: r.groupTimeouts }, `${what}: ${r.asset} row`).toEqual({ late: 0, held: 0, timeouts: 0 });
}

const rowOf = async (page: Page, asset: string): Promise<Row | undefined> => (await musicRows(page)).find((r) => r.asset.includes(asset));

test("M4a: a segment starts on the grid, at the time it was asked for, and the music reports it", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  await page.waitForTimeout(500);

  // The sound-lab's `music-intensity` segment (120 bpm, 4 s, three stems), entry cue heard 3 s from now.
  const T = (await audioTime(page)) + 3;
  await startEvent(page, "m", INTENSITY_EVENT, { at: T });
  await expect.poll(async () => (await rowOf(page, "music-intensity"))?.state, { timeout: 30_000, message: "the segment is primed and playing" }).toBe("playing");
  const row = (await rowOf(page, "music-intensity"))!;
  expect(row.segment).toBe("intensity");
  expect(row.tempo).toBe(120);
  expect(row.stems.map((s) => s.name).sort()).toEqual(["lead", "pad", "pulse"]);

  // Bar 1 is where it was asked to start: every bar line, seen at different times, is a whole number of 2 s bars from it.
  const bars: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = (await snap(page, "m"))!;
    expect(s.segment).toBe("intensity");
    bars.push(s.nextBar!);
    expect(offGrid(s.nextBar! - T, 2), `bar line ${s.nextBar!.toFixed(3)} against the start ${T.toFixed(3)}`).toBeLessThan(0.02);
    expect(offGrid(s.nextBeat! - T, 0.5), "beat line").toBeLessThan(0.02);
    expect(s.beat).toBeGreaterThanOrEqual(1);
    expect(s.beat).toBeLessThanOrEqual(4);
    await page.waitForTimeout(700);
  }
  expect(bars[bars.length - 1]!, "the grid advances").toBeGreaterThan(bars[0]!);
  // Heard: the Music bus has the segment's stems on it (Intensity is 1 here: all three).
  expect(await peakOver(page, "Music", 600), "the Music bus meter").toBeGreaterThan(0.01);
  await expectClean(page, "segment");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4a: eight stems start together: one group, one start, no slip, streamed and decoded stems side by side", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  await addAssets(page, { "e1/stems8.audioevent.json": stems8() });
  expect(await readLate(page)).toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  await startEvent(page, "m", "e1/stems8.audioevent.json");
  await expect.poll(async () => (await rowOf(page, "stems8"))?.state, { timeout: 30_000 }).toBe("playing");
  const row = (await rowOf(page, "stems8"))!;
  expect(row.stems, "eight stems").toHaveLength(8);
  expect(row.stems.every((s) => s.primed)).toBe(true);
  // The melody's sidecar says stream: two stems take music rings, the six decoded stems don't.
  const streamed = row.stems.filter((s) => s.streamed);
  expect(streamed.map((s) => s.name).sort()).toEqual(["melody-a", "melody-b"]);
  expect(row.groups.map((g) => ({ of: g.of, primed: g.primed }))).toEqual([{ of: 8, primed: 8 }]);

  // One snapshot of the voice table: every stem is a playing voice of the event and they are at the same position.
  // The streamed stems' rows are not read here (F-16: they read waitingForData for as long as they play, see the fixme below).
  const decodedPlaying = async () => {
    const d = (await audioDebug(page))!;
    return d.voices.filter((v) => v.event === row.id && v.state === "playing" && v.playheadSeconds !== null);
  };
  await expect.poll(async () => (await decodedPlaying()).length, { timeout: 15_000, message: "the six decoded stems are playing" }).toBe(6);
  const d = (await audioDebug(page))!;
  const mine = d.voices.filter((v) => v.event === row.id);
  expect(mine, "eight voices of the music event").toHaveLength(8);
  // Started together and kept together: the decoded stems' playheads, in one snapshot of the table, are the same frame.
  const heads = mine.filter((v) => v.playheadSeconds !== null).map((v) => v.playheadSeconds!);
  expect(heads).toHaveLength(6);
  expect(Math.max(...heads) - Math.min(...heads), "six decoded stems, one playhead").toBe(0);
  expect(row.groups[0]!.state, "the group is playing, as one").toBe("playing");
  expect(d.musicTotals!.poolUsed, "two music rings in use").toBe(2);
  expect(d.musicTotals!.poolHighWater).toBeGreaterThanOrEqual(2);
  expect(await peakOver(page, "Tape", 600), "audible").toBeGreaterThan(0.01);

  // Let it loop a few passes: the group stays on one clock.
  const seen6: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1_500);
    const now = (await audioDebug(page))!.voices.filter((v) => v.event === row.id && v.playheadSeconds !== null).map((v) => v.playheadSeconds!);
    expect(now.length, "decoded stems playing").toBe(6);
    expect(Math.max(...now) - Math.min(...now), "still one playhead").toBe(0);
    seen6.push(now[0]!);
  }
  expect(seen6.some((p, i) => i > 0 && p < seen6[i - 1]!), `the loop wrapped (playheads ${seen6.map((x) => x.toFixed(2)).join(" ")})`).toBe(true);
  await expectClean(page, "eight stems");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

// F-16 (found by E1): the voice rows of a streamed music stem. The stem plays (its music ring is bound and the Music bus carries it,
// the flappy case above), but `Audio.debug().voices` lists it as `waitingForData` with clip "" and no playhead for as long as it plays.
// Diagnosis: a gated music member's stream is opened by the group (`primeGroup`), so it is not in `StreamStore.byStream`; the
// store's `onStatus` is what clears `VoiceReason.WAITING_FOR_DATA` (core/streams.ts), and `debug.ts` finds the clip path through the
// clip registry, which has no entry for it. The Audio Debug panel's voice table shows the same wrong row.
test.fixme("M4a: a streamed stem's voice row reads playing, with its clip and a playhead (F-16)", async ({ page }) => {
  await bootSample(page, LAB);
  await addAssets(page, { "e1/stems8.audioevent.json": stems8() });
  await startEvent(page, "m", "e1/stems8.audioevent.json");
  await expect.poll(async () => (await rowOf(page, "stems8"))?.state, { timeout: 30_000 }).toBe("playing");
  const id = (await rowOf(page, "stems8"))!.id;
  await page.waitForTimeout(2_000);
  const melody = (await audioDebug(page))!.voices.filter((v) => v.event === id && v.clip.includes("melody"));
  expect(melody.map((v) => v.state)).toEqual(["playing", "playing"]);
  expect(melody.every((v) => v.playheadSeconds !== null)).toBe(true);
});

test("M4a: a playlist advances item to item on the grid, and stops after its rounds", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  await addAssets(page, { "e1/playlist.audioevent.json": playlist3(1) });
  await startEvent(page, "m", "e1/playlist.audioevent.json");
  // Sample the music row for the whole run; the list is A, B, C (each 4 s) and ends.
  const seq = await page.evaluate(async () => {
    const { Audio } = (globalThis as unknown as { __myco: { Audio: { debug(): { music?: { segment: string | null; bar: number; beat: number; asset: string }[] } } } }).__myco;
    const out: { segment: string; bar: number; beat: number }[] = [];
    const t0 = performance.now();
    let seenAny = false;
    while (performance.now() - t0 < 60_000) {
      const r = Audio.debug().music?.find((m) => m.asset.includes("playlist"));
      if (r) seenAny = true;
      else if (seenAny) break; // its row is gone: the playlist ended
      if (r?.segment && out[out.length - 1]?.segment !== r.segment) out.push({ segment: r.segment, bar: r.bar, beat: r.beat });
      await new Promise((res) => setTimeout(res, 50));
    }
    return out;
  });
  expect(seq.map((s) => s.segment), "the items in order").toEqual(["A", "B", "C"]);
  // Each item is first seen within its first beat or two (a display frame after the change), at bar 1.
  for (const s of seq) {
    expect(s.bar, `${s.segment} is first seen in its bar 1`).toBe(1);
    expect(s.beat, `${s.segment} is first seen near its start`).toBeLessThanOrEqual(2);
  }
  expect(await rowOf(page, "playlist"), "the playlist's row is gone once it has played its rounds").toBeUndefined();
  await expectClean(page, "playlist");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4a: a quantised transition lands on a bar line, the debug row names its rule, a crossfade and a cut both play", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  await addAssets(page, { "e1/switch.audioevent.json": switchAB() });
  const T = (await audioTime(page)) + 3;
  await startEvent(page, "m", "e1/switch.audioevent.json", { at: T });
  await expect.poll(async () => (await rowOf(page, "switch"))?.state, { timeout: 30_000 }).toBe("playing");
  expect((await snap(page, "m"))!.segment).toBe("A");

  const change = async (to: string, ruleKey: string, rule: number) => {
    await page.evaluate((v) => (globalThis as unknown as G).__e1.m!.setParameter("State", v), to);
    // The pending change shows on the handle and in the row, with the rule that chose it.
    await expect.poll(async () => (await snap(page, "m"))?.transition?.to, { timeout: 10_000 }).toBe(to);
    const s = (await snap(page, "m"))!;
    const pending = (await rowOf(page, "switch"))?.pending;
    expect(pending, "the row shows the pending change").toBeTruthy();
    expect({ to: pending!.to, ruleKey: pending!.ruleKey, rule: pending!.rule, tier: pending!.tier, parent: pending!.parent }, "the rule that supplied it").toEqual({ to, ruleKey, rule, tier: 1, parent: "world" });
    expect(s.transition!.time, "it lands in the future").toBeGreaterThan(s.now);
    expect(offGrid(s.transition!.time - T, 2), `lands on a bar line (${s.transition!.time.toFixed(3)} against the start ${T.toFixed(3)})`).toBeLessThan(0.02);
    expect(s.transition!.time - s.now, "within a bar and the lead").toBeLessThan(2 + 1.5);
    // After the landing time the new segment plays, at the start of its bar 1.
    await expect.poll(async () => (await snap(page, "m"))?.segment, { timeout: 15_000 }).toBe(to);
    const after = (await snap(page, "m"))!;
    expect(after.now, "it did not change early").toBeGreaterThanOrEqual(s.transition!.time - 0.15);
    expect(after.bar, `${to} is first seen at its bar 1`).toBe(1);
    expect(after.beat).toBeLessThanOrEqual(2);
    await expect.poll(async () => (await snap(page, "m"))?.transition, { timeout: 10_000 }).toBeNull();
    expect(await peakOver(page, "Tape", 500), `${to} is audible`).toBeGreaterThan(0.01);
  };
  await test.step("A to B: next bar, a one-beat equal-power crossfade (rule 0)", () => change("B", "A>B", 0));
  await page.waitForTimeout(150);
  await test.step("B to A: next bar, a cut (rule 1)", () => change("A", "B>A", 1));
  await expectClean(page, "transitions");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4a: a stinger plays on the next bar, over the music, which carries on", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  await addAssets(page, { "e1/stinger.audioevent.json": withStinger() }, SINES);
  const T = (await audioTime(page)) + 3;
  await startEvent(page, "m", "e1/stinger.audioevent.json", { at: T });
  await expect.poll(async () => (await rowOf(page, "stinger"))?.state, { timeout: 30_000 }).toBe("playing");
  await page.waitForTimeout(800);
  const base = await peakOver(page, "Tape", 500);
  expect(base, "the music alone (a quiet sine)").toBeGreaterThan(0.05);
  expect(base, "quiet enough to hear the stinger over").toBeLessThan(0.25);
  // Trigger just after a bar line: the next one is then further off than the player's lead, so the stinger is not "too late" for it
  // (a trigger that finds its point inside the lead plays on the bar after, and the debug row counts it late, with a warning).
  await expect.poll(async () => { const s = (await snap(page, "m"))!; return s.nextBar! - s.now; }, { timeout: 10_000, intervals: [30] }).toBeGreaterThan(1.5);
  // The stinger is a louder sine: the Tape meter against the audio clock shows when it enters.
  const fired = await page.evaluate(async () => {
    const g = globalThis as unknown as G & { __myco: { Audio: { time: number; bus(n: string): { peak: number } } } };
    const yes = g.__e1.m!.trigger("hit");
    const no = g.__e1.m!.trigger("nope");
    const calledAt = g.__myco.Audio.time;
    const t0 = performance.now();
    let entered: number | null = null;
    while (performance.now() - t0 < 5000 && entered === null) {
      if (g.__myco.Audio.bus("Tape").peak > 0.3) entered = g.__myco.Audio.time;
      await new Promise((r) => setTimeout(r, 4));
    }
    return { yes, no, calledAt, entered };
  });
  expect({ yes: fired.yes, no: fired.no }, "a known trigger is accepted, an unknown one is not").toEqual({ yes: true, no: false });
  expect(fired.entered, "the stinger was heard").not.toBeNull();
  expect(fired.entered! - fired.calledAt, "it waited for the next bar line").toBeGreaterThan(0.01);
  expect(fired.entered! - fired.calledAt, "and no longer than a bar and the lead").toBeLessThan(2 + 1.2);
  expect(offGrid(fired.entered! - T, 2), `the stinger entered on a bar line (${fired.entered!.toFixed(3)} against the start ${T.toFixed(3)})`).toBeLessThan(0.15);
  await expect.poll(async () => (await rowOf(page, "stinger"))?.stingers.played, { timeout: 15_000, message: "the stinger is counted as played" }).toBe(1);
  const row = (await rowOf(page, "stinger"))!;
  expect({ played: row.stingers.played, late: row.stingers.late, skipped: row.stingers.skipped, dropped: row.stingers.dropped }).toEqual({ played: 1, late: 0, skipped: 0, dropped: 0 });
  // It is over a second later and the music was not changed by it: the same segment, still on its grid.
  await expect.poll(() => peakOver(page, "Tape", 300), { timeout: 8_000, message: "the stinger ended" }).toBeLessThan(0.25);
  const s = (await snap(page, "m"))!;
  expect(s.segment).toBe("A");
  expect(offGrid(s.nextBar! - T, 2)).toBeLessThan(0.02);
  await expectClean(page, "stinger");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4a: quantised automation brings a stem in on the beat, not when the parameter moves", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  await addAssets(page, { "e1/layered.audioevent.json": layered() }, SINES);
  const T = (await audioTime(page)) + 3;
  await startEvent(page, "m", "e1/layered.audioevent.json", { at: T });
  await expect.poll(async () => (await rowOf(page, "layered"))?.state, { timeout: 30_000 }).toBe("playing");
  await page.waitForTimeout(800);
  const base = await peakOver(page, "Tape", 500);
  expect(base, "the base stem alone").toBeGreaterThan(0.05);

  // Sets Layer and watches the Tape meter against the audio clock for `ms`; returns when the level first rose past 1.4 x base.
  const raise = (ms: number) =>
    page.evaluate(
      async ([span, floor]) => {
        const g = globalThis as unknown as G & { __myco: { Audio: { time: number; bus(n: string): { peak: number } } } };
        const calledAt = g.__myco.Audio.time;
        g.__e1.m!.setParameter("Layer", 1);
        const t0 = performance.now();
        let crossed: number | null = null;
        while (performance.now() - t0 < (span as number)) {
          if (crossed === null && g.__myco.Audio.bus("Tape").peak > (floor as number)) crossed = g.__myco.Audio.time;
          await new Promise((r) => setTimeout(r, 4));
        }
        return { calledAt, crossed };
      },
      [ms, base * 1.4] as const,
    );
  const rises: { calledAt: number; crossed: number }[] = [];
  for (const wait of [0, 170]) {
    // Back to the base alone (the meter holds a peak briefly), then a wait that moves the call to another phase of the beat.
    await page.evaluate(() => (globalThis as unknown as G).__e1.m!.setParameter("Layer", 0));
    await expect.poll(() => peakOver(page, "Tape", 200), { timeout: 15_000, message: "the layer left again" }).toBeLessThan(base * 1.25);
    await page.waitForTimeout(wait);
    const r = await raise(2200);
    expect(r.crossed, "the layer entered").not.toBeNull();
    rises.push({ calledAt: r.calledAt, crossed: r.crossed! });
  }
  for (const r of rises) {
    expect(r.crossed - r.calledAt, "not at once: it waited for a beat line").toBeGreaterThan(0.01);
    expect(r.crossed - r.calledAt, "and no longer than a beat plus the lead").toBeLessThan(0.5 + 1.2);
    expect(offGrid(r.crossed - T, 0.5), `entered on a beat line (${r.crossed.toFixed(3)} against the start ${T.toFixed(3)})`).toBeLessThan(0.12);
  }
  await expectClean(page, "quantised automation");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4a: the flappy sample's streamed segment plays on its grid without a warning", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, FLAPPY);
  // The sample's music prefab autoloads: a streamed segment, `town`, 105 bpm.
  await expect.poll(async () => (await rowOf(page, "town"))?.state, { timeout: 60_000, message: "the town segment plays" }).toBe("playing");
  const row = (await rowOf(page, "town"))!;
  expect(row.segment).toBe("town");
  expect(row.tempo).toBe(105);
  expect(row.stems).toHaveLength(1);
  expect(row.stems[0]!.streamed, "town.mp3 streams").toBe(true);
  expect(row.stems[0]!.ring, "through a music ring").not.toBeNull();
  const d = (await audioDebug(page))!;
  expect(d.musicTotals!.poolUsed).toBe(1);
  expect(d.musicTotals!.poolSize).toBe(12);
  await page.waitForTimeout(6_000);
  const later = (await rowOf(page, "town"))!;
  expect(later.state).toBe("playing");
  expect(later.bar * 4 + later.beat, "the position moves").toBeGreaterThan(row.bar * 4 + row.beat);
  expect(await peakOver(page, "Music", 600), "heard on the Music bus").toBeGreaterThan(0.005);
  await expectClean(page, "flappy");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings, "no warning from the engine about the music").toEqual([]);
});

test("M4a on Babylon: a segment plays and a playlist advances", async ({ page }) => {
  const seen = watchConsole(page);
  await bootSample(page, LAB, "babylon");
  const loop = event({ type: "segment", id: "I", tracks: [{ name: "pad", clip: "audio/events/music-pad.wav" }, { name: "pulse", clip: "audio/events/music-pulse.wav" }], regions: [{ id: "loop", from: "1:1:0", to: "end", count: 0 }] });
  await addAssets(page, { "e1/playlist.audioevent.json": playlist3(1), "e1/loop.audioevent.json": loop });
  await startEvent(page, "seg", "e1/loop.audioevent.json");
  await expect.poll(async () => (await snap(page, "seg"))?.segment, { timeout: 30_000, message: "the segment plays on Babylon" }).toBe("I");
  const a = (await snap(page, "seg"))!;
  await page.waitForTimeout(1500);
  const b = (await snap(page, "seg"))!;
  expect(b.time, "its position moves").toBeGreaterThan(a.time);
  await startEvent(page, "list", "e1/playlist.audioevent.json");
  const seq: string[] = [];
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && seq.join() !== "A,B,C") {
    const s = (await snap(page, "list"))?.segment;
    if (s && seq[seq.length - 1] !== s) seq.push(s);
    await page.waitForTimeout(100);
  }
  expect(seq, "the playlist's items in order").toEqual(["A", "B", "C"]);
  expect(seen.errors).toEqual([]);
});

// The held group (R11, C2c): when a streamed stem runs dry the whole group dips together and resumes together. Pausing the decoder
// worker through the DevTools protocol (`pauseWorkers`) stops the rings refilling; once they drain the core holds the group.
test("M4a: a starved streamed stem holds the whole group, and it resumes together (C2c)", async ({ page }) => {
  await bootSample(page, LAB);
  await addAssets(page, { "e1/stems8.audioevent.json": stems8() });
  await startEvent(page, "m", "e1/stems8.audioevent.json");
  await expect.poll(async () => (await rowOf(page, "stems8"))?.state, { timeout: 30_000 }).toBe("playing");
  await page.waitForTimeout(1_500);
  const held = await pauseWorkers(page, true, null);
  await expect.poll(async () => (await readLate(page))?.groupsHeld, { timeout: 45_000, intervals: [50], message: "the group was held" }).toBeGreaterThanOrEqual(1);
  expect((await rowOf(page, "stems8"))!.state, "the music instance is still there").not.toBeUndefined();
  await pauseWorkers(page, false, held);
  await held.cdp.detach();
  const decoded = async () => (await audioDebug(page))!.voices.filter((v) => v.playheadSeconds !== null && v.state === "playing").map((v) => v.playheadSeconds!);
  await expect.poll(async () => (await decoded()).length, { timeout: 30_000, message: "it resumed" }).toBe(6);
  const heads = await decoded();
  expect(Math.max(...heads) - Math.min(...heads), "the decoded stems resumed on one playhead").toBe(0);
  const late = (await readLate(page))!;
  expect({ abandoned: late.groupsAbandoned, split: late.splitQuanta }, "resumed, not given up").toEqual({ abandoned: 0, split: 0 });
  expect((await audioDebug(page))!.musicTotals!.maxSlipFrames, "the slip is the hold's length").toBeGreaterThan(0);
});

// F-17 (found by E1): a stopped music event's row stays in `Audio.debug().music`, state "ending", for good. Its voices are gone, its
// rings are back and `Audio.debug().events` no longer lists it, but the MusicPlayer is not disposed (a playlist that ends by itself
// does leave the table), so the panel's Music section keeps a dead row for every `stop()`.
test.fixme("M4a: a stopped music event leaves the Music table (F-17)", async ({ page }) => {
  await bootSample(page, LAB);
  await addAssets(page, { "e1/stems8.audioevent.json": stems8() });
  await startEvent(page, "m", "e1/stems8.audioevent.json");
  await expect.poll(async () => (await rowOf(page, "stems8"))?.state, { timeout: 30_000 }).toBe("playing");
  await page.evaluate(() => (globalThis as unknown as G).__e1.m!.stop(0.2));
  await expect.poll(async () => (await rowOf(page, "stems8"))?.state, { timeout: 15_000 }).toBeUndefined();
});

test("M4a: the 10-minute playlist runs with no late group", { tag: "@slow" }, async ({ page }, info) => {
  const SECONDS = Number(process.env.E2E_PLAYLIST_SECONDS ?? 600);
  info.setTimeout(SECONDS * 1000 + 180_000);
  const seen = watchConsole(page);
  await bootSample(page, LAB);
  // 3 one-pass segments of 4 s (decoded, and one with a streamed stem) forever: an item every 4 s, a group per item.
  await addAssets(page, { "e1/long.audioevent.json": playlist3(0) });
  await startEvent(page, "m", "e1/long.audioevent.json");
  await expect.poll(async () => (await rowOf(page, "long"))?.state, { timeout: 30_000 }).toBe("playing");
  // A sampler in the page counts the items (the playing segment's id changes at each advance) every 50 ms.
  await page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: { Audio: { debug(): { music?: { segment: string | null; asset: string }[] } } } }).__myco;
    const s = { items: 0, last: null as string | null, badOrder: 0 };
    (globalThis as unknown as { __long: typeof s }).__long = s;
    setInterval(() => {
      const seg = Audio.debug().music?.find((m) => m.asset.includes("long"))?.segment ?? null;
      if (seg && seg !== s.last) {
        const want = s.last === null ? null : ({ A: "B", B: "C", C: "A" } as Record<string, string>)[s.last];
        if (want && seg !== want) s.badOrder++;
        s.items++;
        s.last = seg;
      }
    }, 50);
  });
  const t0 = Date.now();
  const log: string[] = [];
  let maxReplans = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    await page.waitForTimeout(Math.min(Number(process.env.E2E_PLAYLIST_STEP ?? 30_000), Math.max(1_000, SECONDS * 1000 - (Date.now() - t0))));
    const d = (await audioDebug(page))!;
    const r = d.music?.find((m) => m.asset.includes("long"));
    const late = (await readLate(page))!;
    const replans = Object.values(r?.replans ?? {}).reduce((x, y) => x + y, 0);
    maxReplans = Math.max(maxReplans, replans);
    const items = await page.evaluate(() => (globalThis as unknown as { __long: { items: number } }).__long.items);
    log.push(`t=${Math.round((Date.now() - t0) / 1000)}s items=${items} late=${late.groupsLate}/${r?.lateGroups} held=${late.groupsHeld} slip=${late.maxSlipFrames} split=${late.splitQuanta} replans=${replans} ring=${d.musicTotals?.poolUsed}/${d.musicTotals?.poolHighWater} underruns=${d.counters.underruns} state=${r?.state}`);
    console.log(`[music-a] ${log[log.length - 1]}`);
    // A late group is a failure at once: don't wait out the rest of the run.
    expect(late.groupsLate, `a late group (${log[log.length - 1]})`).toBe(0);
    if (!r) {
      // Between two reads the row was not there: look again for a moment before calling the playlist over (and say so).
      console.log(`[music-a] no music row at t=${Math.round((Date.now() - t0) / 1000)}s; looking again`);
      await expect.poll(async () => (await rowOf(page, "long"))?.state, { timeout: 3_000, message: `the playlist is still playing (${log[log.length - 1]})` }).toBe("playing");
    }
  }
  const long = await page.evaluate(() => (globalThis as unknown as { __long: { items: number; badOrder: number } }).__long);
  const wall = (Date.now() - t0) / 1000;
  info.annotations.push({ type: "playlist", description: `${long.items} items in ${wall.toFixed(0)} s, ${maxReplans} re-plans at most` });
  // An item every 4 s: allow the first item's start and a few missed samples.
  expect(long.items, "items played").toBeGreaterThanOrEqual(Math.floor(SECONDS / 4) - 4);
  expect(long.badOrder, "every advance went to the next item in the list").toBe(0);
  await expectClean(page, "10-minute playlist");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});
