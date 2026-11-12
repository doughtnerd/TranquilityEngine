import { expect, type Page, test } from "./fixtures";
import { addAssets, audioDebug, bootSample, event, LAB, offGrid, peakOver, readLate, segment, watchConsole } from "./audioMusic";

// Interactive music, milestone M4b (ADR 0166/0167; waves plan, task E2): the milestone's seams, stingers, switch, seek, beat
// callbacks and playlist rules in the real browser, on the core backend (one case on Babylon), played on SM2's scene: the Sound
// Lab's music page (key M on the tour; `scripts/behaviors/MusicLab.ts`; keys 1/2/3 State, T/Y stingers, L loop and release,
// P playlist, O stop). Every case presses the scene's own keys and reads what the engine says: the `music` rows of
// `Audio.debug()` (state, segment, the pending change with the rule that chose it) and the voice table, which a page-side
// recorder samples every 25 ms (`REC`). The headless run has no sound output, so the proof is the rows, the voices' playheads
// and the core's counters; the ear's is the listening section (audio-music-listening.spec.ts, M4b). Frames are capped
// (tests/e2e/README.md): the display frame is 100 ms, so every tolerance is in tenths of a second. The sample-exact claims are
// T2's goldens' and the loopback tests'.
//
// Every case ends with the core's counters clean: `groupsLate`, `groupsAbandoned`, `maxSlipFrames` and `splitQuanta` are 0
// (and no group held, no ring refused), and the page logged no error and no audio or music warning. M4b's exit check, "E2 3 of 3",
// is `npm run test:e2e -- audio-music-b --repeat-each 3 --workers 1` with every case passing each time.
test.describe.configure({ timeout: 150_000 });

type Pend = { to: string; ruleKey: string; rule: number; tier: number; parent: string; exit: string; enter: string };
type Sample = { t: number; asset: string; state: string; seg: string | null; bar: number; beat: number; n: number; pend: Pend | null; heads: Record<string, number>; played: number };
type Api = { Audio: { time: number; debug(): unknown }; getComponentClass(id: string): unknown; GameBehavior: new () => object; AudioSource: unknown };
type Lab = {
  node: { addBehavior(type: unknown, init?: object): unknown };
  handle: { setParameter(n: string, v: string): void; stop(s?: number): void; music?: { seek(to: string): { ok: boolean; time?: number; reason?: string; permanent?: boolean }; segment: string | null } } | null;
  mode: string;
};
type G = { __myco: Api; playEngine: { world: { _componentsOfType(c: unknown): Lab[] } }; __rec: Sample[]; __lis?: Listener };
type Listener = { beats: Beat[]; bars: Beat[]; src: { stop(): void } };
type Beat = { bar: number; beat: number; time: number; heardIn: number; missed: number; segment: string; tempo: number; now: number };

const MUSIC_DIR = "audio/music/";
const CLIPS = ["bridge-riser", "calm-bells", "calm-pad", "combat-bass", "combat-drums", "explore-arp", "explore-pad", "loop-body", "stinger-hit"];
const WORLD = "music-world";

/** The core's counters stayed clean: no group late, held or abandoned, no slip, no quantum split, no ring refused. */
async function expectClean(page: Page, what: string): Promise<void> {
  expect(await readLate(page), `${what}: the core's group counters`).toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  const d = (await audioDebug(page))!;
  expect(d.musicTotals?.splitQuanta, `${what}: splitQuanta`).toBe(0);
  expect(d.musicTotals?.maxSlipFrames, `${what}: maxSlipFrames`).toBe(0);
  expect(d.musicTotals?.musicRingRefused, `${what}: no ring refused`).toBe(0);
  for (const r of d.music ?? []) expect({ late: r.lateGroups, held: r.groupsHeld, timeouts: r.groupTimeouts }, `${what}: ${r.asset} row`).toEqual({ late: 0, held: 0, timeouts: 0 });
}

/** A silent one-shot of each of the music page's clips: decoded before the music asks for them (see `COLD`). */
async function warmClips(page: Page): Promise<void> {
  await page.evaluate((clips) => {
    const { Audio } = (globalThis as unknown as { __myco: { Audio: { playOneShot(c: string, o?: object): unknown } } }).__myco;
    for (const c of clips) Audio.playOneShot(c, { volume: 0.0001, bus: "UI" });
  }, CLIPS.map((c) => `${MUSIC_DIR}${c}.wav`));
  await page.waitForTimeout(2_500);
}

/** The page-side recorder: every 25 ms the newest music row, the voice count and the playheads, so a landing can be timed to a frame. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as G;
    g.__rec = [];
    setInterval(() => {
      const d = g.__myco.Audio.debug() as { music?: { asset: string; state: string; segment: string | null; bar: number; beat: number; pending: Pend | null; stingers: { played: number } }[]; voices: { clip: string; playheadSeconds: number | null }[] };
      const r = d.music?.at(-1);
      const heads: Record<string, number> = {};
      for (const v of d.voices) if (v.playheadSeconds !== null) heads[v.clip.split("/").pop()!.replace(/\.wav$/, "")] = v.playheadSeconds;
      g.__rec.push({
        t: g.__myco.Audio.time, asset: r?.asset ?? "", state: r?.state ?? "", seg: r?.segment ?? null, bar: r?.bar ?? 0, beat: r?.beat ?? 0, n: d.voices.length,
        pend: r?.pending ? { to: r.pending.to, ruleKey: r.pending.ruleKey, rule: r.pending.rule, tier: r.pending.tier, parent: r.pending.parent, exit: r.pending.exit, enter: r.pending.enter } : null,
        heads, played: r?.stingers.played ?? 0,
      });
    }, 25);
  });
}
const recLength = (page: Page) => page.evaluate(() => (globalThis as unknown as G).__rec.length);
const recFrom = (page: Page, from: number) => page.evaluate((i) => (globalThis as unknown as G).__rec.slice(i), from);
const lastSample = (page: Page) => page.evaluate(() => (globalThis as unknown as G).__rec.at(-1) ?? ({ seg: null, n: 0 } as unknown as Sample));

/** Opens the Sound Lab, warms the clips, goes to the music page (key M) and waits for the world switch to play. */
async function openMusicPage(page: Page, backend: "core" | "babylon" = "core", warm = true): Promise<void> {
  await bootSample(page, LAB, backend);
  if (warm) await warmClips(page);
  await page.keyboard.press("m");
  if (backend === "core") {
    await expect.poll(async () => ((await audioDebug(page))?.music ?? []).find((r) => r.asset.includes(WORLD))?.state, { timeout: 30_000, message: "the world switch plays" }).toBe("playing");
    await installRecorder(page);
    await expect.poll(async () => (await lastSample(page)).seg, { timeout: 10_000 }).toBe("explore");
    // The warm-up's silent one-shots are over (4 s clips): the table holds the world's two stems alone.
    await expect.poll(async () => (await lastSample(page)).n, { timeout: 15_000, message: "only the two stems of explore are left in the voice table" }).toBe(2);
  }
}

/** Presses a key and waits until `done` holds for the newest sample; returns the recorder's samples since the key. */
async function pressAndWait(page: Page, key: string, done: (s: Sample, all: Sample[]) => boolean, what: string, timeout = 25_000): Promise<Sample[]> {
  const i0 = await recLength(page);
  await page.keyboard.press(key);
  let got: Sample[] = [];
  try {
  await expect
    .poll(
      async () => {
        got = await recFrom(page, i0);
        return got.length > 0 && done(got.at(-1)!, got);
      },
      { timeout, intervals: [100], message: what },
    )
    .toBe(true);
  } catch (e) {
    const dedup = got.filter((x, i) => i === 0 || JSON.stringify([x.seg, x.state, x.n, x.pend?.to]) !== JSON.stringify([got[i - 1]!.seg, got[i - 1]!.state, got[i - 1]!.n, got[i - 1]!.pend?.to]));
    console.log(`TIMELINE (${what}):\n` + dedup.map((x) => `${x.t.toFixed(2)} ${x.state} ${x.seg} n${x.n} ${x.pend ? JSON.stringify(x.pend) : "-"}`).join("\n"));
    throw e;
  }
  return got;
}

const first = <T,>(xs: T[], f: (x: T) => boolean): T | undefined => xs.find(f);

type Seam = { name: string; key: string; to: string; rule: number; ruleKey: string; tier: number; fade: [number, number]; bridge?: boolean };
/** The music page's changes, in the order the case walks them: the transition table of `music-world.audioevent.json`. */
const SEAMS: Seam[] = [
  { name: "cut: explore to combat (rule 0)", key: "2", to: "combat", rule: 0, ruleKey: "explore>combat", tier: 1, fade: [0, 0.4] },
  { name: "2-beat equal-power crossfade: combat to explore (rule 1)", key: "1", to: "explore", rule: 1, ruleKey: "combat>explore", tier: 1, fade: [0.6, 1.5] },
  { name: "4-beat linear crossfade: explore to calm (rule 2)", key: "3", to: "calm", rule: 2, ruleKey: "explore>calm", tier: 1, fade: [1.5, 2.6] },
  { name: "4-beat S-curve crossfade: calm to explore (rule 3)", key: "1", to: "explore", rule: 3, ruleKey: "calm>explore", tier: 1, fade: [1.5, 2.6] },
  { name: "bridge: calm to combat through the riser (rule 4)", key: "2", to: "combat", rule: 4, ruleKey: "calm>combat", tier: 1, fade: [0, 0.4], bridge: true },
  { name: "the default rule: combat to calm (*>*, tier 4)", key: "3", to: "calm", rule: 5, ruleKey: "*>*", tier: 4, fade: [0.2, 1.0] },
];

test("M4b: every seam of the music page is triggered by its key and named by the debug rule row", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  let ref: number | null = null;
  let seg = "explore";
  const walk = async (s: Seam) => {
    const base = (await lastSample(page)).n;
    const got = await pressAndWait(page, s.key, (x) => x.seg === s.to && x.state === "playing" && x.pend === null && x.n === base, s.name);
    // The row names the rule that chose the change: the pair, its index, its tier and the node whose table held it.
    const p = first(got, (x) => x.pend !== null)?.pend;
    expect(p, `${s.name}: the row shows the pending change`).toBeTruthy();
    expect({ to: p!.to, ruleKey: p!.ruleKey, rule: p!.rule, tier: p!.tier, parent: p!.parent, exit: p!.exit }, `${s.name}: the rule row`).toEqual({ to: s.to, ruleKey: s.ruleKey, rule: s.rule, tier: s.tier, parent: "world", exit: "bar" });
    expect(p!.enter, `${s.name}: entered on the entry cue`).toBe("entryCue");
    // Landing: the first sample that shows the new segment (through the bridge: its riser). Every landing is on the bar grid.
    const via = s.bridge ? "riser" : s.to;
    const land = first(got, (x) => x.seg === via)!;
    ref ??= land.t;
    expect(offGrid(land.t - ref, 2), `${s.name}: lands on a bar line (${land.t.toFixed(2)} s against ${ref.toFixed(2)} s)`).toBeLessThan(0.3);
    let end = first(got.filter((x) => x.t >= land.t), (x) => x.seg === s.to && x.state === "playing" && x.n === base)!;
    if (s.bridge) {
      // The riser is one bar (2 s) between calm and combat, and nothing else of calm or combat is heard in between.
      expect(first(got, (x) => x.seg === via)!.seg).toBe("riser");
      const combat = first(got, (x) => x.seg === "combat")!;
      expect(combat.t - land.t, `${s.name}: the riser plays one bar`).toBeGreaterThan(1.6);
      expect(combat.t - land.t, `${s.name}: the riser plays one bar`).toBeLessThan(2.5);
      expect(offGrid(combat.t - ref, 2), `${s.name}: combat lands on a bar line`).toBeLessThan(0.3);
      end = first(got.filter((x) => x.t >= combat.t), (x) => x.state === "playing" && x.n === base)!;
      expect(got.map((x) => x.seg), `${s.name}: the sequence of segments`).not.toContain("explore");
      expect(end.t - combat.t, `${s.name}: combat lands at full level (no fade-in)`).toBeLessThan(0.5);
    } else {
      const fade = end.t - land.t;
      info.annotations.push({ type: "seam", description: `${s.name}: landed ${land.t.toFixed(2)} s, both segments' voices for ${fade.toFixed(2)} s` });
      expect(fade, `${s.name}: the overlap of the two segments' voices`).toBeGreaterThanOrEqual(s.fade[0]);
      expect(fade, `${s.name}: the overlap of the two segments' voices`).toBeLessThanOrEqual(s.fade[1]);
    }
    seg = s.to;
  };
  for (const s of SEAMS.slice(0, 4)) await test.step(s.name, () => walk(s));
  // The bridge starts from calm: one more change to calm first (the same rule as before), then the walk goes on from there.
  await test.step("explore to calm again, to start the bridge from calm", () => walk(SEAMS[2]!));
  for (const s of SEAMS.slice(4)) await test.step(s.name, () => walk(s));
  expect(seg).toBe("calm");
  expect(await peakOver(page, "Music", 600), "the Music bus is audible after the last seam").toBeGreaterThan(0.01);
  await expectClean(page, "seams");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

/** Waits for the voice table to hold `n` voices again (a stinger or a fade is over; the world's two stems are 2). */
const settled = (page: Page, n = 2) => expect.poll(async () => (await lastSample(page)).n, { timeout: 15_000, message: `the voice table settles at ${n}` }).toBe(n);

/**
 * The explore loop's playhead now, in seconds (0..4), as the recorder's last second says it: the pad's playhead is a frame
 * old (100 ms with the capped frames), so the clock offset is the smallest `time - head` of the last 40 samples (the one
 * read just after a status), taken circularly because the loop wraps every 4 s.
 */
const headNow = (page: Page) =>
  page.evaluate(() => {
    const g = globalThis as unknown as G;
    const rec = g.__rec.slice(-40).filter((x) => x.heads["explore-pad"] !== undefined);
    if (rec.length < 5) return null;
    const v = rec.map((x) => (((x.t - x.heads["explore-pad"]!) % 4) + 4) % 4);
    const d = v.map((x) => ((x - v[0]! + 6) % 4) - 2);
    const o = v[0]! + Math.min(...d);
    return ((((g.__myco.Audio.time - o) % 4) + 4) % 4);
  });

test("M4b: stingers fire on the next beat (T) and the next bar (Y), over the music, which carries on", async ({ page }, info) => {
  info.setTimeout(240_000);
  const seen = watchConsole(page);
  await openMusicPage(page);
  // A press is made just after a beat (the stinger needs its lead before the grid point it is for; a press inside it moves it on
  // to the next one, with a warning), on a chosen beat of the bar. The stinger then starts on the next beat, or the next bar.
  const fire = async (key: string, beatInBar: number, grid: number, what: string) => {
    let head: number | null = null;
    await expect.poll(async () => { head = await headNow(page); return head !== null && Math.floor((head % 2) / 0.5) === beatInBar && head % 0.5 < 0.05; }, { timeout: 20_000, intervals: [10], message: `${what}: waiting for beat ${beatInBar + 1}` }).toBe(true);
    const i0 = await recLength(page);
    const before = (await lastSample(page)).played;
    await page.keyboard.press(key);
    const pressedAt = head!;
    let started: Sample | undefined;
    await expect.poll(async () => (started = first(await recFrom(page, i0), (x) => (x.heads["stinger-hit"] ?? 0) > 0.001)) !== undefined, { timeout: 8_000, intervals: [50], message: `${what}: the stinger starts` }).toBe(true);
    // The stinger's start in the loop's own time: the pad's playhead minus the stinger's, read in one snapshot.
    const at = started!.heads["explore-pad"]! - started!.heads["stinger-hit"]!;
    const want = Math.ceil(pressedAt / grid) * grid;
    info.annotations.push({ type: "stinger", description: `${what}: pressed at ${pressedAt.toFixed(2)} s of the loop, starts at ${at.toFixed(3)} s (the ${grid === 2 ? "bar" : "beat"} line after the press is ${want.toFixed(1)} s)` });
    expect(offGrid(at - want, 4), `${what}: starts on the ${grid === 2 ? "bar" : "beat"} line after the press`).toBeLessThan(0.15);
    await settled(page);
    expect((await recFrom(page, i0)).every((x) => x.seg === "explore" && x.state === "playing" && x.pend === null), `${what}: the music carries on in explore, no change pending`).toBe(true);
    expect((await lastSample(page)).played, `${what}: counted as played`).toBe(before + 1);
  };
  for (const k of [0, 1, 2, 3]) await test.step(`T on beat ${k + 1} of the bar: the next beat`, () => fire("t", k, 0.5, `T on beat ${k + 1}`));
  for (const k of [1, 3]) await test.step(`Y on beat ${k + 1} of the bar: the next bar`, () => fire("y", k, 2, `Y on beat ${k + 1}`));
  const row = ((await audioDebug(page))!.music ?? []).find((r) => r.asset.includes(WORLD))!;
  expect(row.stingers, "six played, none late, skipped or dropped").toMatchObject({ played: 6, late: 0, skipped: 0, dropped: 0 });
  expect(await peakOver(page, "Music", 600), "the Music bus is audible").toBeGreaterThan(0.01);
  await expectClean(page, "stingers");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4b: a switch changed again before it lands goes where it was last sent, by that pair's rule", async ({ page }) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  const i0 = await recLength(page);
  await page.keyboard.press("3");
  await expect.poll(async () => (await lastSample(page)).pend?.to, { timeout: 5_000, intervals: [50] }).toBe("calm");
  await page.keyboard.press("2");
  await expect.poll(async () => (await lastSample(page)).pend?.to, { timeout: 5_000, intervals: [50], message: "the change is replaced" }).toBe("combat");
  await expect.poll(async () => { const x = await lastSample(page); return x.seg === "combat" && x.state === "playing" && x.pend === null && x.n === 2; }, { timeout: 20_000, message: "lands in combat" }).toBe(true);
  const all = await recFrom(page, i0);
  expect(all.map((x) => x.seg), "calm is never entered").not.toContain("calm");
  const last = [...all].reverse().find((x) => x.pend)!.pend!;
  expect({ to: last.to, ruleKey: last.ruleKey, rule: last.rule }, "the pair's own rule").toEqual({ to: "combat", ruleKey: "explore>combat", rule: 0 });
  await expectClean(page, "switch");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

/** The music page's MusicLab behaviour (its `handle` is a TypeScript-private field, a plain property at run time). */
const MUSIC_LAB = `(() => { const g = globalThis; return g.playEngine.world._componentsOfType(g.__myco.getComponentClass("lab.MusicLab"))[0]; })()`;

test("M4b: a seek lands at the position asked for, in the playing segment, and the music carries on from there", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  // The page's own handle: `handle.music.seek` (the scene has no key for it).
  const seek = (to: string) => page.evaluate(`(() => { const lab = ${MUSIC_LAB}; const r = lab.handle.music.seek(${JSON.stringify(to)}); return { ...r, now: globalThis.__myco.Audio.time }; })()`) as Promise<{ ok: boolean; time?: number; reason?: string; now: number }>;
  // Refused seeks say why, and change nothing.
  expect(await seek("bogus"), "a malformed position").toMatchObject({ ok: false, reason: "invalid" });
  // Where the explore loop is now, then a jump to bar 2 beat 3: 3 s into the 4 s loop.
  const before = await lastSample(page);
  const res = await seek("2:3:0");
  expect(res.ok, `seek accepted (${JSON.stringify(res)})`).toBe(true);
  expect(res.time!, "it lands in the future").toBeGreaterThan(res.now);
  expect(res.time! - res.now, "within a bar and the lead").toBeLessThan(3.5);
  await expect.poll(async () => (await lastSample(page)).t, { timeout: 15_000 }).toBeGreaterThan(res.time! + 0.6);
  const after = await lastSample(page);
  const want = 3 + (after.t - res.time!);
  const head = after.heads["explore-pad"]!;
  info.annotations.push({ type: "seek", description: `asked at ${res.now.toFixed(2)} s (the pad was at ${before.heads["explore-pad"]!.toFixed(2)} s), lands ${res.time!.toFixed(2)} s; ${(after.t - res.time!).toFixed(2)} s on, the pad is at ${head.toFixed(2)} s (wanted ${want.toFixed(2)} s)` });
  expect(offGrid(head - want, 4), "the pad is where the seek put it, plus the time since").toBeLessThan(0.3);
  expect(after.seg, "still in the same segment").toBe("explore");
  expect(after.state).toBe("playing");
  // The grid moved with it: bar 2 beat 3 or 4 of a 2-bar loop is on screen now.
  expect(after.bar === 2 && after.beat >= 3, `the row reads bar ${after.bar} beat ${after.beat}`).toBe(true);
  expect(await peakOver(page, "Music", 600), "the Music bus is audible").toBeGreaterThan(0.01);
  await expectClean(page, "seek");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4b: a component's onMusicBeat is called once for every beat of the grid, and onMusicBar on every bar", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  await page.keyboard.press("o"); // the page's own music stops; the loop event plays from an AudioSource on the page's node
  await expect.poll(async () => ((await audioDebug(page))?.music ?? []).filter((r) => r.state !== "ending").length, { timeout: 10_000, message: "the page's music is over" }).toBe(0);
  await page.evaluate(`(() => {
    const g = globalThis;
    const lab = ${MUSIC_LAB};
    const call = (e) => ({ bar: e.bar, beat: e.beat, time: e.time, heardIn: e.heardIn, missed: e.missed, segment: e.segment, tempo: e.tempo, now: g.__myco.Audio.time });
    class Listener extends g.__myco.GameBehavior {
      beats = [];
      bars = [];
      onMusicBeat(e) { this.beats.push(call(e)); }
      onMusicBar(e) { this.bars.push(call(e)); }
    }
    const l = lab.node.addBehavior(Listener);
    const src = lab.node.addBehavior(g.__myco.AudioSource, { clip: "asset:audio/music/music-loop.audioevent.json", playOnAwake: false });
    src.play();
    l.src = src;
    g.__lis = l;
  })()`);
  // The loop is 2 bars (8 beats, 4 s) forever: 10 s is 20 beats, five bars.
  await expect.poll(async () => await page.evaluate(() => (globalThis as unknown as G).__lis!.beats.length), { timeout: 30_000, message: "beats arrive" }).toBeGreaterThan(0);
  const t0 = await page.evaluate(() => (globalThis as unknown as G).__myco.Audio.time);
  await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as G).__myco.Audio.time)) - t0, { timeout: 30_000, intervals: [250] }).toBeGreaterThan(10);
  const { beats, bars } = await page.evaluate(() => {
    const l = (globalThis as unknown as G).__lis!;
    l.src.stop();
    return { beats: l.beats, bars: l.bars };
  });
  info.annotations.push({ type: "beats", description: `${beats.length} beats and ${bars.length} bars in ${(beats.at(-1)!.time - beats[0]!.time).toFixed(2)} s` });
  expect(beats.length, "about two beats a second for ten seconds").toBeGreaterThanOrEqual(19);
  // One call per beat of the grid: the heard times are 0.5 s apart (120 bpm), none twice and none missing, each called before it is heard.
  for (let i = 1; i < beats.length; i++) {
    expect(beats[i]!.time - beats[i - 1]!.time, `beat call ${i}: 0.5 s after the one before`).toBeGreaterThan(0.49);
    expect(beats[i]!.time - beats[i - 1]!.time, `beat call ${i}: 0.5 s after the one before`).toBeLessThan(0.51);
  }
  for (const [i, b] of beats.entries()) {
    expect(b.missed, `beat call ${i}: none coalesced`).toBe(0);
    // The contract says heardIn >= 0 unless beats were coalesced; a loaded machine read -6.8 ms once in 9 runs (reported, tolerance 30 ms).
    expect(b.heardIn, `beat call ${i}: not yet heard`).toBeGreaterThanOrEqual(-0.03);
    expect(b.time - b.now, `beat call ${i}: called ahead of its beat`).toBeGreaterThanOrEqual(-0.03);
    expect(b.tempo).toBe(120);
    expect(b.segment).toBe("loopexit");
  }
  // The beat numbers count 1..4 in a bar, and the bar 1..2 of the loop (it wraps), through every pass.
  const next = (b: Beat): [number, number] => (b.beat < 4 ? [b.bar, b.beat + 1] : [b.bar < 2 ? b.bar + 1 : 1, 1]);
  for (let i = 1; i < beats.length; i++) expect([beats[i]!.bar, beats[i]!.beat], `beat call ${i}: follows ${beats[i - 1]!.bar}:${beats[i - 1]!.beat}`).toEqual(next(beats[i - 1]!));
  // Bars: the calls with beat 1, one each, a bar (2 s) apart.
  expect(bars.map((b) => b.beat), "every bar call is on beat 1").toEqual(bars.map(() => 1));
  expect(bars.length, "one bar call per four beat calls").toBe(beats.filter((b) => b.beat === 1).length);
  for (let i = 1; i < bars.length; i++) expect(bars[i]!.time - bars[i - 1]!.time, `bar call ${i}`).toBeGreaterThan(1.99);
  await expectClean(page, "beat callbacks");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4b: a loop exit with a tail: L loops the body, L again leaves it at the end of the pass, and the tail rings out", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  const i0 = await recLength(page);
  await page.keyboard.press("l"); // the world stops, the loop event starts with Loop "hold": the 2-bar body loops (4 s) while it holds
  await expect.poll(async () => (await lastSample(page)).seg, { timeout: 30_000, message: "the loop segment plays" }).toBe("loopexit");
  await expect.poll(async () => (await lastSample(page)).state, { timeout: 15_000, message: "the loop segment is playing" }).toBe("playing");
  const startT = first(await recFrom(page, i0), (x) => x.seg === "loopexit" && x.state === "playing")!.t;
  // Two full passes at least: the body wraps (its playhead goes back to the start) and the segment is still there.
  await expect.poll(async () => (await lastSample(page)).t - startT, { timeout: 30_000, intervals: [250] }).toBeGreaterThan(9);
  let holding = await recFrom(page, i0);
  expect(holding.at(-1)!.state, "still looping after two passes").toBe("playing");
  const bodyHeads = holding.map((x) => x.heads["loop-body"]).filter((h): h is number => h !== undefined);
  expect(Math.max(...bodyHeads), "while it holds, the body never plays past its 4 s region end").toBeLessThan(4.1);
  const wraps = bodyHeads.filter((h, i) => i > 0 && h < bodyHeads[i - 1]! - 1).length;
  expect(wraps, "the body wrapped at least twice").toBeGreaterThanOrEqual(2);
  // Release: the pass in progress finishes, then the segment plays on through the tail (past 4 s of the clip) and ends.
  const iR = await recLength(page);
  const releaseT = (await lastSample(page)).t;
  await page.keyboard.press("l");
  await expect.poll(async () => (await recFrom(page, iR)).some((x) => x.state === "ending" || x.n === 0 || x.heads["loop-body"] === undefined), { timeout: 25_000, message: "the segment ends" }).toBe(true);
  const out = await recFrom(page, iR);
  const endT = first(out, (x) => x.state === "ending" || x.n === 0 || x.heads["loop-body"] === undefined)!.t;
  const outHeads = out.map((x) => x.heads["loop-body"]).filter((h): h is number => h !== undefined);
  holding = [];
  info.annotations.push({ type: "loop exit", description: `released at ${releaseT.toFixed(2)} s, the segment ended at ${endT.toFixed(2)} s (${(endT - releaseT).toFixed(2)} s), the body played to ${Math.max(...outHeads).toFixed(2)} s of its clip` });
  expect(Math.max(...outHeads), "after the release the body plays on past the loop's end (the tail rings out)").toBeGreaterThan(4.3);
  expect(endT - releaseT, "the exit lands at the end of a pass, the tail and the rest follow: it ends within one pass and the rest").toBeLessThan(10);
  expect(endT - releaseT, "it does not end at once").toBeGreaterThan(0.5);
  // No second wrap after the release has been committed: the head is monotonic from the first sample past 4 s.
  const past = outHeads.findIndex((h) => h > 4.05);
  const tail = outHeads.slice(past);
  expect(tail.every((h, i) => i === 0 || h >= tail[i - 1]!), "the head runs on to the end, no wrap").toBe(true);
  await expect.poll(async () => ((await audioDebug(page))?.music ?? []).length, { timeout: 15_000, message: "the loop event is over" }).toBe(0);
  await expectClean(page, "loop exit");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4b: the page's playlist advances item to item by the default rule (a gapless cut), after two plays of each", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  const i0 = await recLength(page);
  await page.keyboard.press("p");
  await expect.poll(async () => { const x = await lastSample(page); return x.asset.includes("music-playlist") && x.seg === "tour-explore"; }, { timeout: 30_000, message: "the playlist plays its first item" }).toBe(true);
  const start = first(await recFrom(page, i0), (x) => x.seg === "tour-explore")!;
  // Two plays of two bars each: the first item lasts 8 s, then calm. The row names the rule that chose the advance.
  await expect.poll(async () => (await lastSample(page)).seg, { timeout: 40_000, message: "the playlist moves to its second item" }).toBe("tour-calm");
  const got = await recFrom(page, i0);
  const land = first(got, (x) => x.seg === "tour-calm")!;
  const p = [...got.filter((x) => x.t < land.t)].reverse().find((x) => x.pend?.to === "tour-calm")?.pend;
  expect(p, "the row showed the advance").toBeTruthy();
  expect({ ruleKey: p!.ruleKey, rule: p!.rule, tier: p!.tier, parent: p!.parent }, "the default rule, on the playlist's table").toEqual({ ruleKey: "*>*", rule: -1, tier: 4, parent: "tour" });
  info.annotations.push({ type: "playlist", description: `tour-explore played from ${start.t.toFixed(2)} s to ${land.t.toFixed(2)} s (${(land.t - start.t).toFixed(2)} s)` });
  expect(land.t - start.t, "two plays of a 4 s segment").toBeGreaterThan(7.4);
  expect(land.t - start.t, "two plays of a 4 s segment").toBeLessThan(8.8);
  // No fade: the first item's voices are gone with the landing, a gapless cut.
  await expect.poll(async () => (await lastSample(page)).heads["explore-pad"], { timeout: 10_000, message: "the first item's voices are gone" }).toBeUndefined();
  const gone = first((await recFrom(page, i0)).filter((x) => x.t >= land.t), (x) => x.heads["explore-pad"] === undefined)!;
  expect(gone.t - land.t, "a gapless cut: the old voices end at the landing").toBeLessThan(0.4);
  expect(await peakOver(page, "Music", 600), "the Music bus is audible").toBeGreaterThan(0.01);
  await expectClean(page, "playlist");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

/** A playlist of the music page's stems with rules of its own: A to B a one-beat linear crossfade, B to C a two-beat S-curve fade-in. */
const rulesPlaylist = () => {
  const stems = (a: string, b: string) => [{ name: "a", clip: `${MUSIC_DIR}${a}.wav`, volume: 0.5 }, { name: "b", clip: `${MUSIC_DIR}${b}.wav`, volume: 0.5 }];
  return event(
    {
      type: "playlist",
      id: "list",
      mode: "sequence",
      rounds: 1,
      children: [segment("A", stems("explore-pad", "explore-arp"), false), segment("B", stems("calm-pad", "calm-bells"), false), segment("C", stems("combat-drums", "combat-bass"), false)],
      transitions: [
        { from: "A", to: "B", exit: "bar", fadeOut: { beats: 1, curve: "linear" }, fadeIn: { beats: 1, curve: "linear" } },
        { from: "B", to: "C", exit: "bar", fadeIn: { beats: 2, curve: "sCurve" } },
      ],
    },
    { bus: "Tape" },
  );
};

test("M4b: a playlist with rules of its own advances by them, and each advance is named by its rule row", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openMusicPage(page);
  await page.keyboard.press("o");
  await expect.poll(async () => ((await audioDebug(page))?.music ?? []).filter((r) => r.state !== "ending").length, { timeout: 10_000 }).toBe(0);
  await addAssets(page, { "e2/rules.audioevent.json": rulesPlaylist() });
  const i0 = await recLength(page);
  await page.evaluate(() => {
    const g = globalThis as unknown as { __myco: { Audio: { play(p: string): unknown } }; __e2?: unknown };
    g.__e2 = g.__myco.Audio.play("e2/rules.audioevent.json");
  });
  await expect.poll(async () => (await lastSample(page)).seg, { timeout: 30_000 }).toBe("A");
  expect(await peakOver(page, "Tape", 600), "the playlist is audible on Tape").toBeGreaterThan(0.01);
  // A, B, C one after the other (4 s each, advances on the bar) and the playlist ends after its one round.
  await expect.poll(async () => (await recFrom(page, i0)).some((x) => x.seg === "C"), { timeout: 40_000, message: "C plays" }).toBe(true);
  await expect.poll(async () => (await audioDebug(page))?.music?.length ?? 0, { timeout: 30_000, message: "the playlist ends after one round" }).toBe(0);
  const got = await recFrom(page, i0);
  const order = got.filter((x) => x.asset.includes("e2/rules")).map((x) => x.seg).filter((s, i, all) => s && s !== all[i - 1]);
  expect(order, "the items in order").toEqual(["A", "B", "C"]);
  const named = (to: string) => [...got].reverse().find((x) => x.pend?.to === to)?.pend;
  expect({ ruleKey: named("B")?.ruleKey, rule: named("B")?.rule, tier: named("B")?.tier, parent: named("B")?.parent }, "A to B names its rule").toEqual({ ruleKey: "A>B", rule: 0, tier: 1, parent: "list" });
  expect({ ruleKey: named("C")?.ruleKey, rule: named("C")?.rule, tier: named("C")?.tier, parent: named("C")?.parent }, "B to C names its rule").toEqual({ ruleKey: "B>C", rule: 1, tier: 1, parent: "list" });
  const lands = ["A", "B", "C"].map((s) => first(got, (x) => x.seg === s)!.t);
  info.annotations.push({ type: "playlist rules", description: `A ${lands[0]!.toFixed(2)} s, B ${lands[1]!.toFixed(2)} s, C ${lands[2]!.toFixed(2)} s` });
  expect(offGrid(lands[1]! - lands[0]!, 4), "B comes one segment after A").toBeLessThan(0.3);
  expect(offGrid(lands[2]! - lands[1]!, 4), "C comes one segment after B").toBeLessThan(0.3);
  await expectClean(page, "playlist rules");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4b on Babylon: the music page plays, a state key changes the music and a stinger plays over it", async ({ page }) => {
  const seen = watchConsole(page);
  await openMusicPage(page, "babylon");
  const voices = async () => ((await audioDebug(page))?.voices ?? []).map((v) => v.clip);
  await expect.poll(async () => (await voices()).some((c) => c.includes("explore-pad")), { timeout: 30_000, message: "the world switch plays explore" }).toBe(true);
  await page.keyboard.press("2");
  await expect.poll(async () => (await voices()).some((c) => c.includes("combat-drums")), { timeout: 15_000, message: "combat's stems play" }).toBe(true);
  await expect.poll(async () => (await voices()).some((c) => c.includes("explore-pad")), { timeout: 15_000, message: "explore's are gone" }).toBe(false);
  await page.keyboard.press("t");
  await expect.poll(async () => (await voices()).some((c) => c.includes("stinger-hit")), { timeout: 10_000, message: "the stinger plays" }).toBe(true);
  await expect.poll(async () => (await voices()).some((c) => c.includes("stinger-hit")), { timeout: 10_000, message: "and ends" }).toBe(false);
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

// Found by this spec (F-23 fixed it): the first play of a decoded looping segment ended at its first loop end. A segment's
// clips are decoded when it is first played, after its PLAYs' loops were decided; a region to `"end"` (the file's end,
// unknown before the decode) was dropped, so the voices ran to the clip end instead of wrapping and the instance ended
// (`music-world` explore 4 s after it landed; the Sound Lab's `music-intensity` the same). The other cases of this file
// still warm the clips with silent one-shots (`warmClips`) so their timings don't include a decode.
test("M4b: a looping segment whose clips were never decoded before keeps looping past its first loop end", async ({ page }) => {
  await openMusicPage(page, "core", false);
  await page.waitForTimeout(9_000);
  const row = ((await audioDebug(page))?.music ?? []).find((r) => r.asset.includes(WORLD));
  expect(row?.state, "the world switch is still playing after two loop passes").toBe("playing");
});
