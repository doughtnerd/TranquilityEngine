// ADR 0166 R4b: `while` releases through the whole runtime on the real core, deterministic (`testing/loopbackClock.ts`).
// Every output sample is checked against a reference built from the clip: the loop's passes (with R4a's tail at each
// wrap that happens), then, from the released wrap on, the audio after the region (no tail there: the segment plays
// into the same audio itself) to the file's end. The release is a decoded member's SET_LOOP; the streamed member's
// path is `core/musicStreamRelease.test.ts`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE } from "./testing/loopbackClock";
import { musicPlayers } from "./musicSystem";

afterEach(() => resetMusicLoopback());

/** 120 bpm 4/4 at 48 kHz: a beat is 24,000 frames, a bar 96,000. */
const BEAT = RATE / 2;
const BAR = 4 * BEAT;

/** A clip whose every frame is distinct enough to show a misplaced sample (0.02..0.12). */
const signal = (i: number): number => 0.02 + 0.1 * (((i * 7919) % 10007) / 10007);
/** The clip as the core holds it: int16 (the fixture stores f32, `fakeDecoder` scales by 32767 and rounds), read back as v / 32768. */
const clip = (i: number): number => (i >= 0 ? Math.fround(Math.round(Math.fround(signal(i)) * 32767) / 32768) : 0);

/**
 * The reference of a member looping `[from, to)` (frames) from frame 0 with `tail` frames of tail rung at each wrap
 * that happens, released at the end of pass `last`, then playing the file on to `fileFrames`.
 */
function released(from: number, to: number, last: number, tail: number, fileFrames: number): (k: number) => number {
  const len = to - from;
  const exit = to + (last - 1) * len; // the released wrap
  return (k) => {
    if (k < 0) return 0;
    let v: number;
    if (k < to) v = clip(k);
    else if (k < exit) v = clip(from + ((k - to) % len));
    else v = k - exit + to < fileFrames ? clip(k - exit + to) : 0;
    for (let j = 1; j < last; j++) {
      const w = to + (j - 1) * len;
      if (k >= w && k < w + tail) v = Math.fround(v + clip(to + k - w));
    }
    return v;
  };
}

const loopEvent = (region: Record<string, unknown>): unknown => ({
  format: "myco.audioevent@1",
  bus: "Music",
  parameters: [{ name: "Loop", labels: ["hold", "release"], default: "hold" }],
  root: { type: "segment", id: "A", tracks: [{ name: "t0", clip: "a.wav" }], regions: [region] },
});

describe("while releases on the real core (R4b)", () => {
  it("a decoded release: the loop runs until the condition goes false, then plays on at the next wrap, sample-exact", async (ctx) => {
    const seconds = 6; // three bars
    const r = await musicLoopback({
      clips: { "a.wav": { signal, seconds } },
      events: { "m.audioevent.json": loopEvent({ id: "loop", from: "1:1:0", to: "2:1:0", count: 0, tailBeats: 2, while: { parameter: "Loop", is: "hold" } }) },
    });
    if (!r) return ctx.skip();
    const h = r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const run = r.player()!.run!;
    const f0 = r.frameOfTime(run.startAt);
    expect(r.firstDeparture(0, 0)).toBe(f0);
    // Release half way through pass 3: passes 1-3 loop (tails at wraps 1 and 2), the wrap ending pass 3 is the exit.
    await r.stepUntil(() => r.backend.time >= run.startAt + 2.5 * 2);
    h.setParameter("Loop", "release");
    const fileFrames = seconds * RATE;
    const ref = released(0, BAR, 3, 2 * BEAT, fileFrames);
    const end = f0 + 3 * BAR + (fileFrames - BAR);
    await r.stepToFrame(end + 8 * r.frameFrames);
    expect(r.maxError(0, end + 8 * r.frameFrames, (n) => ref(n - f0))).toBeLessThan(1e-6);
    expect(musicPlayers()).toHaveLength(0); // the segment ended at its end: the instance is over
    r.dispose();
  });

  it("a release asked after the commit point waits one more pass", async (ctx) => {
    const seconds = 6;
    const r = await musicLoopback({
      clips: { "a.wav": { signal, seconds } },
      events: { "m.audioevent.json": loopEvent({ id: "loop", from: "1:1:0", to: "2:1:0", count: 0, while: { parameter: "Loop", is: "hold" } }) },
    });
    if (!r) return ctx.skip();
    const h = r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const run = r.player()!.run!;
    const f0 = r.frameOfTime(run.startAt);
    // The condition for the wrap at 2 s has been read (hold) once its commit point passed; set release right after.
    await r.stepUntil(() => (r.player()?.regions?.reads ?? 0) >= 1);
    expect(run.startAt + 2 - r.backend.time).toBeGreaterThan(0);
    h.setParameter("Loop", "release");
    const fileFrames = seconds * RATE;
    const ref = released(0, BAR, 2, 0, fileFrames); // wraps once more, released at the end of pass 2
    const end = f0 + 2 * BAR + (fileFrames - BAR);
    await r.stepToFrame(end + 8 * r.frameFrames);
    expect(r.maxError(0, end + 8 * r.frameFrames, (n) => ref(n - f0))).toBeLessThan(1e-6);
    r.dispose();
  });

  it("the Sound Lab's loop event (L releases it): the 2-bar body loops with its tail, then plays its last bar and ends", async (ctx) => {
    const path = "audio/music/music-loop.audioevent.json";
    const json = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../samples/sound-lab/${path}`, import.meta.url)), "utf8"));
    const seconds = 6; // the sample's loop-body.wav: three bars
    const r = await musicLoopback({ clips: { "audio/music/loop-body.wav": { signal, seconds } }, events: { [path]: json } });
    if (!r) return ctx.skip();
    const h = r.play(path);
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const run = r.player()!.run!;
    const f0 = r.frameOfTime(run.startAt);
    // L during pass 2: the wrap ending it (8 s in) is the exit; one tail (4 beats) rang at the first wrap (4 s).
    await r.stepUntil(() => r.backend.time >= run.startAt + 5);
    h.setParameter("Loop", "release");
    const fileFrames = seconds * RATE;
    const vol = Math.fround(0.9);
    const ref = released(0, 2 * BAR, 2, 4 * BEAT, fileFrames);
    const end = f0 + 4 * BAR + BAR;
    await r.stepToFrame(end + 8 * r.frameFrames);
    expect(r.maxError(0, end + 8 * r.frameFrames, (n) => Math.fround(ref(n - f0) * vol))).toBeLessThan(2e-6);
    expect(musicPlayers()).toHaveLength(0);
    r.dispose();
  });
});
