import { expect, type Page, test } from "./fixtures";
import { addAssets, audioDebug, bootSample, event, LAB, readLate, segment, STEM, watchConsole } from "./audioMusic";

// Interactive music, milestone M4c (ADR 0166/0167; waves plan, task E3): the milestone's seams in the real browser, on the core
// backend. Two halves.
//
// Callbacks reach a script (K2, K5): a component's `onMusicBeat`/`onMusicBar`/`onMusicCue` hooks (an `AudioSource` on a node with
// a behavior that has them) and `handle.onMusic(kind, fn)` (a script that `Audio.play`s the music itself), each beat once, 0.5 s
// apart on the 120 bpm grid, called ahead of the heard time and within about two display frames of it (`LEAD_MAX`), and none
// after the unsubscribe.
//
// Calibration and the tap game (Rh2, Rh3): the Sound Lab's rhythm page (key R on the tour; `scripts/behaviors/RhythmLab.ts`; keys
// C calibrate, G tap game, X reset, O stop, SPACE tap). A tap is a SPACE `keydown` whose `event.timeStamp` the page reads through
// `handle.music.positionAt`, or a call of `globalThis.__rhythmLab.tap(performanceTime)`. The spec injects taps on known offsets
// from the beat: it asks the playing handle for the next beat's heard time (`nextGrid("beat")`), turns it into the
// `performance.now()` base with `Audio.timeAt`, and adds the offset it wants. The page reports each tap's offset, so the proof is
// what the page read against what was injected. The headless run has no sound output; the ear's check is the listening
// section (audio-music-listening.spec.ts, M4c).
//
// Every case ends with the core's counters clean (no group late, held or abandoned, no slip, no split) and no error or audio or
// music warning on the page. M4c's exit check, "E3 3 of 3", is
// `npm run test:e2e -- audio-music-c --repeat-each 3 --project chromium ` with every case passing each time.
test.describe.configure({ timeout: 150_000 });

type Api = { Audio: { time: number; calibration: number; calibrationStale: boolean; timeAt(p: number): number; debug(): unknown }; GameBehavior: new () => object; AudioSource: unknown; getComponentClass(id: string): unknown };
type Beat = { bar: number; beat: number; time: number; heardIn: number; missed: number; segment: string; tempo: number; now: number; cue?: string };
type Grid = { beats: Beat[]; bars: Beat[]; cues: Beat[] };
type RhythmState = {
  mode: "" | "calibrate" | "game";
  tapsWanted: number;
  taps: number;
  offsetsMs: number[];
  result: { offsetMs: number; spreadMs: number; confidence: number; used: number; discarded: number; steady: boolean; applied: boolean } | null;
  calibrationMs: number;
  calibrationStale: boolean;
  rhythmMode: boolean;
  latencyMs: { base: number; output: number; limiter: number; total: number; reliable: boolean };
  beats: number;
  lastBeat: string;
  last: { offsetMs: number; judgedMs: number; bar: number; beat: number; grade: string } | null;
  hits: number;
  misses: number;
  streak: number;
  bestStreak: number;
};
type G = { __myco: Api; __lis?: Grid; __sub?: Grid; __subOff?: () => void; __h?: { stop(s?: number): void }; __rhythmLab: { state(): RhythmState; tap(t: number): unknown; page: { node: { addBehavior(t: unknown, init?: object): unknown }; handle: unknown } } };

/**
 * A call is made ahead of its heard time by the prediction horizon and the display frame (100 ms here, the frame cap of
 * tests/e2e/README.md): about two frames at most (`LEAD_MAX`). It is never later than the frame that delivered it was long (D15:
 * a beat is delivered in the first frame after its heard time), plus 30 ms (E2 read -6.8 ms once under load): see `expectGrid`.
 */
const LEAD_MAX = 0.35;

/** The core's counters stayed clean: no group late, held or abandoned, no slip, no quantum split, no ring refused. */
async function expectClean(page: Page, what: string): Promise<void> {
  expect(await readLate(page), `${what}: the core's group counters`).toEqual({ groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 });
  const d = (await audioDebug(page))!;
  expect(d.musicTotals?.splitQuanta, `${what}: splitQuanta`).toBe(0);
  expect(d.musicTotals?.maxSlipFrames, `${what}: maxSlipFrames`).toBe(0);
  expect(d.musicTotals?.musicRingRefused, `${what}: no ring refused`).toBe(0);
  for (const r of d.music ?? []) expect({ late: r.lateGroups, held: r.groupsHeld, timeouts: r.groupTimeouts }, `${what}: ${r.asset} row`).toEqual({ late: 0, held: 0, timeouts: 0 });
}

const audioTime = (page: Page) => page.evaluate(() => (globalThis as unknown as G).__myco.Audio.time);

/** A silent one-shot of each clip: decoded before the music asks for them (a segment's first play with undecoded clips, F-23). */
async function warm(page: Page, clips: string[]): Promise<void> {
  await page.evaluate((cs) => {
    const { Audio } = (globalThis as unknown as { __myco: { Audio: { playOneShot(c: string, o?: object): unknown } } }).__myco;
    for (const c of cs) Audio.playOneShot(c, { volume: 0.0001, bus: "UI" });
  }, clips);
  await page.waitForTimeout(2_500);
}

// ---------------------------------------------------------------------------------------------------------------------
// Callbacks

/** A looping 120 bpm segment of the Sound Lab's pad (4 s: two bars) with a cue "drop" on its second bar. */
const CUES = "e3/cues.audioevent.json";
const cueEvent = () =>
  event(segment("cues", [{ name: "pad", clip: STEM.pad, volume: 0.1 }], true, { cues: [{ name: "drop", at: "2:1:0" }] }));

/**
 * The gap (seconds of audio clock) of the display frame that delivered a call made at `now`: the frame's time less the frame
 * before it, from the `FrameLog` behavior's per-frame readings. A call is delivered in the first frame after its heard time
 * (D15), so a frame that stalled for 300 ms can make it 300 ms late: the frame's own gap is what it may be late by.
 */
function gapOf(frames: number[], now: number): number {
  const k = frames.findIndex((f) => f >= now - 0.002);
  if (k < 1) return frames.length > 1 ? frames.at(-1)! - frames.at(-2)! : 0;
  return frames[k]! - frames[k - 1]!;
}

/**
 * What one run of callbacks may say, whichever way they were delivered, on the 120 bpm grid: beats 0.5 s, bars 2 s, the cue 4 s
 * apart, each call's time on the grid, counting 1..4 in a bar and 1..2 over the loop. `missed` is the number of beats (bars,
 * cues) coalesced into a call, so the heard times of consecutive calls are `(1 + missed)` periods apart: none is lost silently.
 * A call is made ahead of its heard time (`heardIn` up to `LEAD_MAX`, two display frames) and is never later than the
 * frame that delivered it was long: `heardIn >= -(that frame's gap) - 30 ms`; a call is coalesced only when a frame's gap
 * (a stalled main thread) held more than one beat: `missed <= ceil(gap / period)`.
 */
function expectGrid(g: Grid, what: string, seconds: number, frames: number[]): void {
  const { beats, bars, cues } = g;
  let stalled = 0;
  const maxGap = Math.max(...frames.slice(1).map((f, i) => f - frames[i]!));
  for (const [kind, calls, period] of [["beat", beats, 0.5], ["bar", bars, 2], ["cue", cues, 4]] as const) {
    for (let i = 1; i < calls.length; i++) {
      const d = calls[i]!.time - calls[i - 1]!.time;
      expect(d, `${what}: ${kind} call ${i}: ${1 + calls[i]!.missed} periods after the one before`).toBeGreaterThan(period * (1 + calls[i]!.missed) - 0.01);
      expect(d, `${what}: ${kind} call ${i}: ${1 + calls[i]!.missed} periods after the one before`).toBeLessThan(period * (1 + calls[i]!.missed) + 0.01);
    }
    for (const [i, c] of calls.entries()) {
      const gap = gapOf(frames, c.now);
      expect(c.heardIn, `${what}: ${kind} call ${i}: not later than its delivering frame (gap ${(gap * 1000).toFixed(0)} ms) + 30 ms`).toBeGreaterThanOrEqual(-gap - 0.03);
      expect(c.time - c.now, `${what}: ${kind} call ${i}: the same, by Audio.time`).toBeGreaterThanOrEqual(-gap - 0.03);
      expect(c.heardIn, `${what}: ${kind} call ${i}: within two display frames of its heard time`).toBeLessThanOrEqual(LEAD_MAX);
      expect(c.time - c.now, `${what}: ${kind} call ${i}: called within two display frames of it`).toBeLessThanOrEqual(LEAD_MAX);
      expect(c.missed, `${what}: ${kind} call ${i}: coalesced only inside a stalled gap (${(gap * 1000).toFixed(0)} ms)`).toBeLessThanOrEqual(Math.ceil(gap / period));
      if (c.missed > 0) stalled++;
      expect(c.tempo).toBe(120);
      expect(c.segment).toBe("cues");
    }
  }
  info_stalled = { stalled, maxGap };
  expect(beats.reduce((n, b) => n + 1 + b.missed, 0), `${what}: every beat of the grid is a call or counted in one`).toBeGreaterThanOrEqual(Math.floor(seconds * 2) - 1);
  const next = (b: Beat, n: number): [number, number] => {
    let bar = b.bar, beat = b.beat;
    for (let k = 0; k < n; k++) { if (beat < 4) beat++; else { beat = 1; bar = bar < 2 ? bar + 1 : 1; } }
    return [bar, beat];
  };
  for (let i = 1; i < beats.length; i++) expect([beats[i]!.bar, beats[i]!.beat], `${what}: beat call ${i} follows ${beats[i - 1]!.bar}:${beats[i - 1]!.beat}`).toEqual(next(beats[i - 1]!, 1 + beats[i]!.missed));
  expect(bars.map((b) => b.beat), `${what}: every bar call is on beat 1`).toEqual(bars.map(() => 1));
  // The cue "drop" is on bar 2 beat 1: named, and on the grid.
  expect(cues.length, `${what}: a cue each pass`).toBeGreaterThanOrEqual(Math.floor(seconds / 4) - 1);
  for (const [i, c] of cues.entries()) {
    expect(c.cue, `${what}: cue call ${i}: the cue's name`).toBe("drop");
    expect([c.bar, c.beat], `${what}: cue call ${i}: on bar 2, beat 1`).toEqual([2, 1]);
  }
  // Every call is on the beat grid of the first call's heard time.
  for (const c of [...beats, ...bars, ...cues]) {
    const r = (((c.time - beats[0]!.time) % 0.5) + 0.5) % 0.5;
    expect(Math.min(r, 0.5 - r), `${what}: a call's heard time is on the grid`).toBeLessThan(0.002);
  }
  // With no stalled frame no beat is coalesced; when one is, it is in this run's annotation.
  if (maxGap < 0.4) expect(stalled, `${what}: no stalled frame, so no coalesced call`).toBe(0);
}
let info_stalled = { stalled: 0, maxGap: 0 };

/** Opens the Sound Lab on its rhythm page (R; nothing plays there until a key), warmed, with the cue event added. */
async function openForCallbacks(page: Page): Promise<void> {
  await bootSample(page, LAB);
  await addAssets(page, { [CUES]: cueEvent() });
  await warm(page, [STEM.pad]);
  await page.keyboard.press("r");
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<G>).__rhythmLab, undefined, { timeout: 15_000 });
  // The per-frame clock: one reading of Audio.time in every frame's update, so each call's delivering frame has a known gap.
  await page.evaluate(`(() => {
    const g = globalThis;
    class FrameLog extends g.__myco.GameBehavior { update() { (g.__frames ??= []).push(g.__myco.Audio.time); } }
    g.__rhythmLab.page.node.addBehavior(FrameLog);
  })()`);
}
const frameLog = (page: Page) => page.evaluate(() => (globalThis as unknown as { __frames: number[] }).__frames);

/** Waits until the audio clock is `seconds` past `t0`. */
const waitSeconds = (page: Page, t0: number, seconds: number) =>
  expect.poll(async () => (await audioTime(page)) - t0, { timeout: 40_000, intervals: [250] }).toBeGreaterThan(seconds);

test("M4c: onMusicBeat, onMusicBar and onMusicCue of a component are called once per beat, bar and cue, ahead of the heard time", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openForCallbacks(page);
  // The hooks sit on the rhythm page's node (the AudioSource and the behavior are siblings on it).
  await page.evaluate(`(() => {
    const g = globalThis;
    const call = (e) => ({ bar: e.bar, beat: e.beat, time: e.time, heardIn: e.heardIn, missed: e.missed, segment: e.segment, tempo: e.tempo, cue: e.cue, now: g.__myco.Audio.time });
    class Hooks extends g.__myco.GameBehavior {
      beats = []; bars = []; cues = [];
      onMusicBeat(e) { this.beats.push(call(e)); }
      onMusicBar(e) { this.bars.push(call(e)); }
      onMusicCue(e) { this.cues.push(call(e)); }
    }
    const node = g.__rhythmLab.page.node;
    const l = node.addBehavior(Hooks);
    const src = node.addBehavior(g.__myco.AudioSource, { clip: "asset:${CUES}", playOnAwake: false });
    src.play();
    l.src = src;
    g.__lis = l;
  })()`);
  const t0 = await audioTime(page);
  await expect.poll(async () => await page.evaluate(() => (globalThis as unknown as G).__lis!.beats.length), { timeout: 30_000, message: "beats arrive" }).toBeGreaterThan(0);
  await waitSeconds(page, t0, 17);
  const got = await page.evaluate(() => {
    const l = (globalThis as unknown as G & { __lis: Grid & { src: { stop(): void } } }).__lis;
    l.src.stop();
    return { beats: l.beats, bars: l.bars, cues: l.cues };
  });
  info.annotations.push({ type: "hooks", description: `${got.beats.length} beats, ${got.bars.length} bars, ${got.cues.length} cues; heardIn ${Math.min(...got.beats.map((b) => b.heardIn)).toFixed(3)}..${Math.max(...got.beats.map((b) => b.heardIn)).toFixed(3)} s` });
  for (const a of info.annotations) console.log(`[music-c] ${a.type}: ${a.description}`);
  expectGrid(got, "hooks", 17, await frameLog(page));
  console.log(`[music-c] hooks: ${info_stalled.stalled} coalesced calls, longest frame ${(info_stalled.maxGap * 1000).toFixed(0)} ms`);
  await expectClean(page, "hooks");
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4c: handle.onMusic delivers beat, bar and cue events to a script, and none after its unsubscribe", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openForCallbacks(page);
  // A script that plays the music itself (no node): three subscriptions on the handle, and a second beat listener that stays.
  await page.evaluate(`(() => {
    const g = globalThis;
    const call = (e) => ({ bar: e.bar, beat: e.beat, time: e.time, heardIn: e.heardIn, missed: e.missed, segment: e.segment, tempo: e.tempo, cue: e.cue, now: g.__myco.Audio.time, same: e.handle === h });
    const h = g.__myco.Audio.play(${JSON.stringify(CUES)});
    const l = { beats: [], bars: [], cues: [], beats2: [] };
    const off = { beat: h.onMusic("beat", (e) => l.beats.push(call(e))), bar: h.onMusic("bar", (e) => l.bars.push(call(e))), cue: h.onMusic("cue", (e) => l.cues.push(call(e))) };
    h.onMusic("beat", (e) => l.beats2.push(call(e)));
    g.__sub = l; g.__subOff = off.beat; g.__h = h; g.__subAll = off;
  })()`);
  const t0 = await audioTime(page);
  await expect.poll(async () => await page.evaluate(() => (globalThis as unknown as G).__sub!.beats.length), { timeout: 30_000, message: "beats arrive" }).toBeGreaterThan(0);
  await waitSeconds(page, t0, 17);
  // Unsubscribe the beat listener: it hears nothing more, while the bars, the cues and the other beat listener carry on.
  const counts = (page: Page) =>
    page.evaluate(() => {
      const s = (globalThis as unknown as G & { __sub: Grid & { beats2: Beat[] } }).__sub;
      return { beats: s.beats.length, bars: s.bars.length, cues: s.cues.length, beats2: s.beats2.length };
    });
  await page.evaluate(() => (globalThis as unknown as G & { __subOff: () => void }).__subOff());
  const before = await counts(page);
  await page.waitForTimeout(4_500);
  const mid = await counts(page);
  expect(mid.beats, "no beat call after its unsubscribe").toBe(before.beats);
  expect(mid.beats2, "the other beat listener still hears every beat").toBeGreaterThanOrEqual(before.beats2 + 7);
  expect(mid.bars, "the bar listener is not affected").toBeGreaterThan(before.bars);
  expect(mid.cues, "the cue listener is not affected").toBeGreaterThan(before.cues);
  // Unsubscribing twice is harmless; then the rest of the kinds go, and the music plays on without a call.
  await page.evaluate(() => {
    const g = globalThis as unknown as G & { __subOff: () => void; __subAll: Record<string, () => void> };
    g.__subOff();
    g.__subAll.bar!();
    g.__subAll.cue!();
  });
  const n = await counts(page);
  await page.waitForTimeout(4_500);
  const then = await counts(page);
  expect(then.bars, "no bar call after its unsubscribe").toBe(n.bars);
  expect(then.cues, "no cue call after its unsubscribe").toBe(n.cues);
  expect(then.beats2, "the last beat listener still hears").toBeGreaterThan(n.beats2);
  expect(await page.evaluate(() => (globalThis as unknown as { __h: { playing: boolean } }).__h.playing), "the music itself played on").toBe(true);
  const got = await page.evaluate(() => {
    const g = globalThis as unknown as G & { __sub: Grid & { beats2: Beat[] } };
    g.__h!.stop();
    return { beats: g.__sub.beats as (Beat & { same: boolean })[], bars: g.__sub.bars, cues: g.__sub.cues, beats2: g.__sub.beats2 };
  });
  info.annotations.push({ type: "onMusic", description: `${got.beats.length} beats (then unsubscribed), ${got.bars.length} bars, ${got.cues.length} cues; beat heardIn ${Math.min(...got.beats.map((b) => b.heardIn)).toFixed(3)}..${Math.max(...got.beats.map((b) => b.heardIn)).toFixed(3)} s` });
  expectGrid({ beats: got.beats, bars: got.bars.filter((b) => b.time <= got.beats.at(-1)!.time), cues: got.cues.filter((c) => c.time <= got.beats.at(-1)!.time) }, "handle.onMusic", 17, await frameLog(page));
  console.log(`[music-c] handle.onMusic: ${info_stalled.stalled} coalesced calls, longest frame ${(info_stalled.maxGap * 1000).toFixed(0)} ms`);
  expect(got.beats2.slice(0, got.beats.length).map((b) => b.time), "both beat listeners heard the same beats").toEqual(got.beats.map((b) => b.time));
  expect(got.beats.every((b) => b.same), "MusicEvent.handle is the object Audio.play returned").toBe(true);
  await expectClean(page, "handle.onMusic");
  for (const a of info.annotations) console.log(`[music-c] ${a.type}: ${a.description}`);
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The rhythm page: calibration and the tap game

/** The Sound Lab's click track and the tap game's two stems: decoded before the page asks for them. */
const RHYTHM_CLIPS = ["audio/music/click-track.wav", "audio/music/combat-drums.wav", "audio/music/combat-bass.wav"];

/** Opens the Sound Lab, warms the rhythm page's clips and goes to the rhythm page (key R). */
async function openRhythm(page: Page, warmClips = true): Promise<void> {
  // The context's `sinkchange` target, for the stale-flag case: the host listens on it, and a spec cannot reach the context.
  await page.addInitScript(() => {
    const g = globalThis as unknown as { __sinkTargets?: EventTarget[] };
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | AddEventListenerOptions)?]) {
      if (type === "sinkchange") (g.__sinkTargets ??= []).push(this);
      return add.call(this, type, ...rest);
    } as typeof add;
  });
  await bootSample(page, LAB);
  if (warmClips) await warm(page, RHYTHM_CLIPS);
  await page.keyboard.press("r");
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<G>).__rhythmLab, undefined, { timeout: 15_000 });
}

const rhythm = (page: Page) => page.evaluate(() => (globalThis as unknown as G).__rhythmLab.state());
const pageText = (page: Page) =>
  page.evaluate(() => {
    const g = globalThis as unknown as G & { __myco: { Text: unknown } };
    return (g.__rhythmLab.page.node as unknown as { getBehavior(t: unknown): { text: string } | null }).getBehavior(g.__myco.Text)?.text ?? "";
  });

/**
 * Installs the page-side tapper. The tap is aimed at the next beat of the playing handle (`music.nextGrid("beat")`, a heard
 * time), turned into the `performance.now()` base with `Audio.timeAt`, and moved by `off` ms (positive: late):
 *   direct(off)  calls `__rhythmLab.tap(performanceTime)` and returns what the page read;
 *   key(off)     dispatches a SPACE `keydown` on the window at that time; its `timeStamp` is the event's own, which is what the
 *                page reads (`event.timeStamp`), and resolves once it was sent.
 */
async function installTapper(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const g = globalThis;
    const A = g.__myco.Audio;
    const beatPerf = (minAhead) => {
      const m = g.__rhythmLab.page.handle.music;
      let T = m.nextGrid("beat").time;
      const p0 = performance.now();
      const a0 = A.timeAt(p0);
      while (T - a0 < minAhead) T += 0.5;
      return p0 + (T - a0) * 1000;
    };
    g.__tapper = {
      direct: (off) => g.__rhythmLab.tap(beatPerf(0) + off),
      key: (off) => new Promise((done) => {
        const at = beatPerf(0.2) + off;
        setTimeout(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); done(performance.now() - at); }, Math.max(0, at - performance.now()));
      }),
    };
  })()`);
}
type Tap = { offsetMs: number; judgedMs: number; bar: number; beat: number; grade: string } | null;
const tapDirect = (page: Page, off: number) => page.evaluate((o) => (globalThis as unknown as { __tapper: { direct(o: number): Tap } }).__tapper.direct(o), off);
/** A SPACE keydown aimed `off` ms from a beat; resolves with how late (ms) the timer fired against its aim. */
const tapKey = (page: Page, off: number) => page.evaluate((o) => (globalThis as unknown as { __tapper: { key(o: number): Promise<number> } }).__tapper.key(o), off);

/** The spec's taps on the click track: `warm` junk taps first, then jittered ones, as the page wants them (20 in all). */
const JITTER = [-6, 4, -2, 7, 0, -4, 3, -7, 5, -1, 2, -5, 6, 1, -3, 0]; // median 0, spread (MAD) 3.5 ms
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Starts a calibration run (C) and waits for the click track's first beat call. */
async function startCalibration(page: Page): Promise<void> {
  await page.keyboard.press("c");
  await expect.poll(async () => (await rhythm(page)).mode, { timeout: 20_000, message: "C starts the calibration" }).toBe("calibrate");
  await expect.poll(async () => (await rhythm(page)).beats, { timeout: 20_000, message: "the click track's beats are counted" }).toBeGreaterThan(1);
  await installTapper(page);
}

/**
 * Plays one calibration run: every tap on its own beat (500 ms apart), the first `realKeys` of them as real SPACE key presses
 * (their offsets are wherever the press falls), then `warm` warm-up taps at `warmMs`, then 16 at `base` + the jitter. `via` is how
 * the injected ones arrive. Returns the largest gap (ms) between an injected offset and what the page read.
 */
async function runCalibration(page: Page, base: number, via: "direct" | "key", options: { warmMs?: number; jitter?: number[]; realKeys?: number } = {}): Promise<{ maxError: number; injected: number[] }> {
  const jit = options.jitter ?? JITTER;
  const real = options.realKeys ?? 0;
  const injected: number[] = [];
  for (let i = 0; i < 20; i++) {
    let off: number;
    if (i < real) {
      await page.keyboard.press("Space");
      off = Number.NaN;
    } else {
      off = i < 4 ? (options.warmMs ?? 110) : base + jit[i - 4]!;
      if (via === "direct") await tapDirect(page, off);
      else off = wrapBeat(off + (await tapKey(page, off))); // the timer's own lateness (a busy page) is part of what was injected
    }
    injected.push(off);
    await expect.poll(async () => (await rhythm(page)).taps >= i + 1 || (await rhythm(page)).result !== null, { timeout: 5_000, message: `tap ${i + 1} is counted` }).toBe(true);
    if (i < 19) await page.waitForTimeout(420);
  }
  await expect.poll(async () => (await rhythm(page)).result, { timeout: 10_000, message: "the run ends with a result" }).not.toBeNull();
  const done = await rhythm(page);
  const got = done.offsetsMs;
  expect(got.length, "the page kept the 20 raw offsets").toBe(20);
  let maxError = 0;
  for (let i = 0; i < 20; i++) {
    if (Number.isNaN(injected[i]!)) {
      expect(Math.abs(got[i]!), `tap ${i + 1} (a real key press) is within half a beat of a click`).toBeLessThanOrEqual(250);
      continue;
    }
    maxError = Math.max(maxError, Math.abs(got[i]! - injected[i]!));
  }
  return { maxError, injected };
}

/** An offset from the nearest beat: a tap more than half a beat (250 ms) late is early for the next one. */
const wrapBeat = (ms: number) => ((((ms + 250) % 500) + 500) % 500) - 250;
const closeTo = (what: string, got: number, want: number, tol: number) => expect(Math.abs(got - want), `${what}: ${got.toFixed(2)} ms, wanted ${want.toFixed(2)} ms +-${tol}`).toBeLessThanOrEqual(tol);

test("M4c: the calibration flow reads the injected offset, sets Audio.calibration, keeps it across a reload, and X resets it", async ({ page }, info) => {
  info.setTimeout(240_000);
  const seen = watchConsole(page);
  await openRhythm(page);
  let s = await rhythm(page);
  expect({ mode: s.mode, calibrationMs: s.calibrationMs, stale: s.calibrationStale, rhythmMode: s.rhythmMode, result: s.result }, "the idle page").toEqual({ mode: "", calibrationMs: 0, stale: false, rhythmMode: false, result: null });
  expect(s.tapsWanted).toBe(20);
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the idle page tells the keys" }).toContain("Press C to calibrate");

  // Run 1: C; a real SPACE press (the first warm-up tap), then taps injected as `tap(performanceTime)` on +42 ms (late).
  await startCalibration(page);
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page shows the run" }).toContain("Calibrating");
  const r1 = await runCalibration(page, 42, "direct", { realKeys: 1 });
  s = await rhythm(page);
  info.annotations.push({ type: "run 1 (+42 ms, direct taps)", description: `offset ${s.result!.offsetMs.toFixed(2)} ms, spread ${s.result!.spreadMs.toFixed(2)} ms, used ${s.result!.used}, injected-vs-read error up to ${r1.maxError.toFixed(2)} ms` });
  closeTo("run 1: every injected tap is read as injected", r1.maxError, 0, 10);
  expect(s.result, "a steady run is applied").toMatchObject({ steady: true, applied: true, used: 16, discarded: 4 });
  closeTo("run 1: the offset", s.result!.offsetMs, 42 + median(JITTER), 10);
  closeTo("run 1: the spread", s.result!.spreadMs, 3.5, 4);
  expect(s.result!.confidence, "run 1: confidence").toBeGreaterThan(0.8);
  expect(s.mode, "the run is over").toBe("");
  const stored = s.calibrationMs;
  closeTo("Audio.calibration is the result's offset", stored, s.result!.offsetMs, 0.001);
  expect(await page.evaluate(() => (globalThis as unknown as G).__myco.Audio.calibration), "Audio.calibration, in seconds").toBeCloseTo(stored / 1000, 9);
  expect(s.calibrationStale).toBe(false);
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page says it is applied and stored" }).toContain("Steady: applied");
  await expect.poll(async () => (await audioDebug(page))?.music?.filter((r) => r.state !== "ending").length, { timeout: 10_000, message: "the click track stops after the run" }).toBe(0);

  // Reload: the stored offset reads back (Rh3's acceptance, end to end).
  await bootSample(page, LAB);
  await page.keyboard.press("r");
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<G>).__rhythmLab, undefined, { timeout: 15_000 });
  await expect.poll(async () => (await rhythm(page)).calibrationMs, { timeout: 10_000, message: "the stored offset is read back after a reload" }).toBeCloseTo(stored, 6);
  s = await rhythm(page);
  expect({ mode: s.mode, result: s.result, stale: s.calibrationStale }, "after the reload: no run, no result, not stale").toEqual({ mode: "", result: null, stale: false });
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page shows the stored value" }).toMatch(/Audio\.calibration \+4\d\.\d ms/);

  // Run 2: another offset, early (-35 ms), through SPACE keydown events timed on the event's own timestamp. It replaces the value.
  await warm(page, RHYTHM_CLIPS);
  await startCalibration(page);
  const r2 = await runCalibration(page, -35, "key");
  s = await rhythm(page);
  info.annotations.push({ type: "run 2 (-35 ms, SPACE keydown events)", description: `offset ${s.result!.offsetMs.toFixed(2)} ms, spread ${s.result!.spreadMs.toFixed(2)} ms, injected-vs-read error up to ${r2.maxError.toFixed(2)} ms` });
  expect(s.result, "run 2 is steady and applied").toMatchObject({ steady: true, applied: true });
  closeTo("run 2: every tap is read as the keydown happened (aim plus the timer's lateness)", r2.maxError, 0, 8);
  closeTo("run 2: the offset is the median of what was injected", s.result!.offsetMs, median(r2.injected.slice(4)), 6);
  closeTo("run 2: and near the aim of -35 ms", s.result!.offsetMs, -35, 40);
  closeTo("Audio.calibration was replaced by run 2's offset", s.calibrationMs, s.result!.offsetMs, 0.001);
  const second = s.calibrationMs;

  // Run 3: unsteady taps (alternately 120 ms early and late) are shown but not applied: the stored value is kept.
  await startCalibration(page);
  await runCalibration(page, 0, "direct", { jitter: JITTER.map((_, i) => (i % 2 ? 120 : -120)) });
  s = await rhythm(page);
  info.annotations.push({ type: "run 3 (unsteady)", description: `spread ${s.result!.spreadMs.toFixed(1)} ms, steady ${s.result!.steady}, applied ${s.result!.applied}` });
  expect(s.result, "an unsteady run is not applied").toMatchObject({ steady: false, applied: false });
  expect(s.result!.spreadMs, "its spread is large").toBeGreaterThan(40);
  expect(s.calibrationMs, "Audio.calibration is untouched").toBe(second);
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page says so" }).toContain("Unsteady: NOT applied");

  // Reload again: run 2's value (not run 3's) is what comes back; then X sets it to 0, and 0 is what the next reload reads.
  await bootSample(page, LAB);
  await page.keyboard.press("r");
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<G>).__rhythmLab, undefined, { timeout: 15_000 });
  await expect.poll(async () => (await rhythm(page)).calibrationMs, { timeout: 10_000, message: "run 2's offset is read back" }).toBeCloseTo(second, 6);
  await page.keyboard.press("x");
  await expect.poll(async () => (await rhythm(page)).calibrationMs, { timeout: 10_000, message: "X resets the calibration to 0" }).toBe(0);
  expect(await page.evaluate(() => (globalThis as unknown as G).__myco.Audio.calibration), "Audio.calibration after X").toBe(0);
  await bootSample(page, LAB);
  await page.keyboard.press("r");
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<G>).__rhythmLab, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1_000); // the stored read has finished by now: 0 is what it holds
  expect((await rhythm(page)).calibrationMs, "the reset is stored too: a reload reads 0").toBe(0);
  for (const a of info.annotations) console.log(`[music-c] ${a.type}: ${a.description}`);
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4c: the tap game grades taps by their offset from the beat (perfect <= 30 ms, good <= 80 ms), against the calibration", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openRhythm(page);
  await page.keyboard.press("g");
  await expect.poll(async () => (await rhythm(page)).mode, { timeout: 20_000, message: "G starts the game" }).toBe("game");
  // The page's beat marker is in step with the music: a beat counted for every beat of the grid, named bar:beat.
  const b0 = (await rhythm(page)).beats;
  await page.waitForTimeout(3_000);
  const b1 = await rhythm(page);
  expect(b1.beats - b0, "about two beats a second for 3 s").toBeGreaterThanOrEqual(5);
  expect(b1.beats - b0).toBeLessThanOrEqual(7);
  expect(b1.lastBeat, "the last beat is named bar:beat").toMatch(/^\d+:[1-4]$/);
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page shows the game" }).toContain("Tap game");
  await installTapper(page);

  // Offsets chosen away from the windows (30 and 80 ms), so the clock's few ms cannot move a grade: late is positive.
  const sequence: { off: number; grade: "perfect" | "good" | "miss" }[] = [
    { off: 0, grade: "perfect" }, { off: 22, grade: "perfect" }, { off: -22, grade: "perfect" },
    { off: 38, grade: "good" }, { off: -38, grade: "good" }, { off: 72, grade: "good" },
    { off: 88, grade: "miss" }, { off: 0, grade: "perfect" }, { off: -72, grade: "good" },
    { off: -88, grade: "miss" }, { off: 130, grade: "miss" }, { off: -130, grade: "miss" },
  ];
  let hits = 0, misses = 0, streak = 0, best = 0;
  for (const t of sequence) {
    const tap = await tapDirect(page, t.off);
    expect(tap, `tap ${t.off} ms: the music was playing`).not.toBeNull();
    closeTo(`tap ${t.off} ms: read as injected`, tap!.offsetMs, t.off, 10);
    closeTo(`tap ${t.off} ms: judged = raw, with no calibration`, tap!.judgedMs, t.off, 10);
    expect(tap!.grade, `tap ${t.off} ms: graded`).toBe(t.grade);
    if (t.grade === "miss") { misses++; streak = 0; } else { hits++; best = Math.max(best, ++streak); }
    const s = await rhythm(page);
    expect({ hits: s.hits, misses: s.misses, streak: s.streak, best: s.bestStreak }, `after tap ${t.off} ms`).toEqual({ hits, misses, streak, best });
    expect(s.last!.grade, "the page's last tap").toBe(t.grade);
    await page.waitForTimeout(300);
  }
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page grades the last tap in ms, early" }).toMatch(/MISS: -\d+\.\d ms \(early\)/);

  // A SPACE keydown on the beat: timed from the event's timestamp, the page reads it as a PERFECT.
  const hitsBefore = (await rhythm(page)).hits;
  const fired = await tapKey(page, 0);
  await expect.poll(async () => (await rhythm(page)).hits, { timeout: 5_000, message: "the SPACE keydown is judged" }).toBe(hitsBefore + 1);
  const key = (await rhythm(page)).last!;
  info.annotations.push({ type: "key tap", description: `timer fired ${fired.toFixed(1)} ms off its aim; the page read ${key.offsetMs.toFixed(1)} ms, ${key.grade}` });
  // The timer may fire late on a busy page (`fired` ms after its aim): the page must read what happened, and grade it so.
  closeTo("the SPACE keydown is read at its own time stamp", key.offsetMs, wrapBeat(fired), 8);
  const a = Math.abs(key.judgedMs);
  if (a < 22) expect(key.grade).toBe("perfect");
  else if (a > 38 && a < 72) expect(key.grade).toBe("good");
  else if (a > 88) expect(key.grade).toBe("miss"); // (within a few ms of a window edge either grade is right)

  // The calibration moves the zero: with 50 ms calibrated, a tap 50 ms late is a perfect (judged 0, raw 50) ...
  await page.evaluate(() => { (globalThis as unknown as G).__myco.Audio.calibration = 0.05; });
  expect((await rhythm(page)).calibrationMs).toBeCloseTo(50, 6);
  let tap = (await tapDirect(page, 50))!;
  closeTo("calibrated: raw", tap.offsetMs, 50, 10);
  closeTo("calibrated: judged", tap.judgedMs, 0, 10);
  expect(tap.grade, "calibrated 50 ms: a tap 50 ms late is perfect").toBe("perfect");
  tap = (await tapDirect(page, 0))!;
  closeTo("calibrated: judged of an on-beat tap", tap.judgedMs, -50, 10);
  expect(tap.grade, "calibrated 50 ms: a tap on the beat is now 50 ms early: good").toBe("good");
  // ... and X sets it back to 0: the same tap, 50 ms late, is only good.
  await page.keyboard.press("x");
  await expect.poll(async () => (await rhythm(page)).calibrationMs, { timeout: 5_000, message: "X resets the calibration" }).toBe(0);
  tap = (await tapDirect(page, 50))!;
  closeTo("reset: judged", tap.judgedMs, 50, 10);
  expect(tap.grade, "after X, a tap 50 ms late is good").toBe("good");
  // G again restarts the game from zero; O stops it.
  await page.keyboard.press("g"); // G while playing the game stops it (the key toggles)
  await expect.poll(async () => (await rhythm(page)).mode, { timeout: 5_000 }).toBe("");
  await page.keyboard.press("g");
  await expect.poll(async () => (await rhythm(page)).mode, { timeout: 5_000 }).toBe("game");
  const fresh = await rhythm(page);
  expect({ hits: fresh.hits, misses: fresh.misses, streak: fresh.streak, last: fresh.last }, "a new game starts from zero").toEqual({ hits: 0, misses: 0, streak: 0, last: null });
  await page.keyboard.press("o");
  await expect.poll(async () => (await audioDebug(page))?.music?.filter((r) => r.state !== "ending").length, { timeout: 10_000, message: "O stops the music" }).toBe(0);
  await expectClean(page, "tap game");
  for (const a of info.annotations) console.log(`[music-c] ${a.type}: ${a.description}`);
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("M4c: a device change sets Audio.calibrationStale, keeps the value, and a new calibration clears it", async ({ page }, info) => {
  const seen = watchConsole(page);
  await openRhythm(page, false);
  await page.evaluate(() => { (globalThis as unknown as G).__myco.Audio.calibration = 0.03; });
  await expect.poll(async () => (await rhythm(page)).calibrationMs, { timeout: 5_000 }).toBeCloseTo(30, 6);
  expect((await rhythm(page)).calibrationStale, "a calibration just set is not stale").toBe(false);
  await expect.poll(() => pageText(page), { timeout: 5_000 }).not.toContain("STALE");

  // The browser's `devicechange` (on navigator.mediaDevices), as the host listens for it.
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event("devicechange")));
  await expect.poll(async () => await page.evaluate(() => (globalThis as unknown as G).__myco.Audio.calibrationStale), { timeout: 10_000, message: "devicechange sets Audio.calibrationStale" }).toBe(true);
  let s = await rhythm(page);
  expect(s.calibrationStale, "the page reads it").toBe(true);
  expect(s.calibrationMs, "the value is kept").toBeCloseTo(30, 6);
  await expect.poll(() => pageText(page), { timeout: 5_000, message: "the page shows STALE" }).toContain("STALE");

  // Setting a calibration (a run, X, or the property) clears it.
  await page.keyboard.press("x");
  await expect.poll(async () => (await rhythm(page)).calibrationStale, { timeout: 5_000, message: "X clears the stale flag" }).toBe(false);
  expect((await rhythm(page)).calibrationMs).toBe(0);
  await expect.poll(() => pageText(page), { timeout: 5_000 }).not.toContain("STALE");

  // The context's `sinkchange` (Chromium's output-device event), dispatched on the context the host listens on.
  const targets = await page.evaluate(() => (globalThis as unknown as { __sinkTargets?: EventTarget[] }).__sinkTargets?.length ?? 0);
  expect(targets, "the host listens for sinkchange on the context").toBeGreaterThan(0);
  await page.evaluate(() => { for (const t of (globalThis as unknown as { __sinkTargets: EventTarget[] }).__sinkTargets) t.dispatchEvent(new Event("sinkchange")); });
  await expect.poll(async () => (await rhythm(page)).calibrationStale, { timeout: 10_000, message: "sinkchange sets Audio.calibrationStale" }).toBe(true);

  // A calibration run clears it: C, taps on the click track.
  await warm(page, RHYTHM_CLIPS);
  await startCalibration(page);
  await runCalibration(page, 10, "direct");
  s = await rhythm(page);
  expect(s.result).toMatchObject({ steady: true, applied: true });
  expect(s.calibrationStale, "a steady calibration run clears the stale flag").toBe(false);
  closeTo("the new calibration", s.calibrationMs, 10, 10);

  // A stale flag is not stored: after a reload it is false, with the stored value.
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event("devicechange")));
  await expect.poll(async () => (await rhythm(page)).calibrationStale, { timeout: 10_000 }).toBe(true);
  const kept = (await rhythm(page)).calibrationMs;
  await bootSample(page, LAB);
  await page.keyboard.press("r");
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<G>).__rhythmLab, undefined, { timeout: 15_000 });
  await expect.poll(async () => (await rhythm(page)).calibrationMs, { timeout: 10_000, message: "the stored value is read back" }).toBeCloseTo(kept, 6);
  expect((await rhythm(page)).calibrationStale, "the stale flag does not survive a reload").toBe(false);
  for (const a of info.annotations) console.log(`[music-c] ${a.type}: ${a.description}`);
  expect(seen.errors).toEqual([]);
  expect(seen.warnings).toEqual([]);
});
