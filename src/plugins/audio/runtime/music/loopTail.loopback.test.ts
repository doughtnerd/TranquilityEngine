// ADR 0166 R4a: loop tails and counted loops through the whole runtime on the real core, deterministic
// (`testing/loopbackClock.ts`). Every output sample is checked against a reference built from the clip: the member's
// region walk (passes, the next region, the exit) plus, at each wrap, the tail span stamped at the wrap.
import { afterEach, describe, expect, it, vi } from "vitest";
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

function event(regions: unknown[], tracks: unknown[] = [{ name: "t0", clip: "a.wav" }]): unknown {
  return { format: "myco.audioevent@1", bus: "Music", root: { type: "segment", id: "A", tracks, regions } };
}

describe("loop tails and counted loops (R4a)", () => {
  it("a tail rings over each wrap and a counted loop exits on time: sample-exact against the reference", async (ctx) => {
    const seconds = 6; // three bars
    const r = await musicLoopback({
      clips: { "a.wav": { signal, seconds } },
      events: { "m.audioevent.json": event([{ id: "loop", from: "1:1:0", to: "2:1:0", count: 3, tailBeats: 2 }]) },
    });
    if (!r) return ctx.skip();
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const run = r.player()!.run!;
    const f0 = r.frameOfTime(run.startAt);
    expect(r.firstDeparture(0, 0)).toBe(f0);
    const fileFrames = seconds * RATE;
    const tail = 2 * BEAT;
    // The member: passes 1..3 over bar 1, then on from bar 2 to the file's end. Tails at wraps 1 and 2 only (the
    // last pass's end plays on into the same audio by itself).
    const ref = (n: number): number => {
      const k = n - f0;
      if (k < 0) return 0;
      let v = 0;
      if (k < 3 * BAR) v = clip(k % BAR);
      else if (k - 2 * BAR < fileFrames) v = clip(k - 2 * BAR);
      for (const j of [1, 2]) if (k >= j * BAR && k < j * BAR + tail) v = Math.fround(v + clip(BAR + k - j * BAR));
      return v;
    };
    const end = f0 + fileFrames + 2 * BAR;
    await r.stepToFrame(end + 4 * r.frameFrames);
    // The tails were stamped at the wraps the anchor predicts.
    expect(r.frameOfTime(run.startAt + 2)).toBe(f0 + BAR);
    expect(r.maxError(0, end + 4 * r.frameFrames, ref)).toBeLessThan(1e-6);
    expect(r.player()?.counters.refusals.tailLate ?? 0).toBe(0);
    r.dispose();
  });

  it("several regions: the members move on to the next region after the first's last pass, then exit", async (ctx) => {
    const seconds = 8; // four bars
    const r = await musicLoopback({
      clips: { "a.wav": { signal, seconds } },
      events: {
        "m.audioevent.json": event([
          { id: "a", from: "1:1:0", to: "2:1:0", count: 2 },
          { id: "b", from: "2:1:0", to: "3:1:0", count: 2 },
        ]),
      },
    });
    if (!r) return ctx.skip();
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const f0 = r.frameOfTime(r.player()!.run!.startAt);
    const fileFrames = seconds * RATE;
    const ref = (n: number): number => {
      const k = n - f0;
      if (k < 0) return 0;
      if (k < 2 * BAR) return clip(k % BAR);
      if (k < 4 * BAR) return clip(BAR + ((k - 2 * BAR) % BAR));
      return k - 2 * BAR < fileFrames ? clip(k - 2 * BAR) : 0;
    };
    const end = f0 + fileFrames + 2 * BAR + 4 * r.frameFrames;
    await r.stepToFrame(end);
    expect(r.maxError(0, end, ref)).toBeLessThan(1e-6);
    r.dispose();
  });

  it("a refused tail span drops the tail with one warning (tailRefused) and the loop goes on", async (ctx) => {
    const r = await musicLoopback({
      clips: { "a.wav": { signal, seconds: 4 } },
      events: { "m.audioevent.json": event([{ id: "loop", from: "1:1:0", to: "2:1:0", count: 0, tailBeats: 2 }]) },
    });
    if (!r) return ctx.skip();
    vi.spyOn(r.backend, "holdSpan").mockReturnValue({ state: "failed", failure: "refusedCeiling", release: () => {} });
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const f0 = r.frameOfTime(r.player()!.run!.startAt);
    const end = f0 + 3 * BAR + BEAT;
    await r.stepToFrame(end);
    expect(r.maxError(0, end, (n) => (n < f0 ? 0 : clip((n - f0) % BAR)))).toBeLessThan(1e-6);
    expect(r.player()!.counters.refusals.tailRefused).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("loop tail"))).toHaveLength(1);
    r.dispose();
  });

  it("tail voices count as the instance's voices and handle.stop stops them with the stems", async (ctx) => {
    const r = await musicLoopback({
      clips: { "a.wav": { signal, seconds: 4 }, "b.wav": { level: 0.05, seconds: 4 } },
      events: {
        "m.audioevent.json": event(
          [{ id: "loop", from: "1:1:0", to: "2:1:0", count: 0, tailBeats: 4 }],
          [{ name: "t0", clip: "a.wav" }, { name: "t1", clip: "b.wav" }],
        ),
      },
    });
    if (!r) return ctx.skip();
    const handle = r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const p = r.player()!;
    const wrap = p.run!.startAt + 2;
    // Into the second pass: both stems' tails ring.
    await r.stepToFrame(r.frameOfTime(wrap) + 10 * r.frameFrames);
    expect(p.tails?.ringing).toHaveLength(2);
    expect(p.tails!.ringing.every((t) => Math.abs(t.at - wrap) < 1e-9 && t.voice.playing)).toBe(true);
    expect(p.instance.voiceCount).toBe(4); // two stems, two tails
    handle.stop(0.05);
    await r.step(40);
    const quiet = r.out.length - 10 * r.frameFrames;
    expect(r.maxError(quiet, r.out.length, 0)).toBe(0);
    expect(p.tails!.ringing.every((t) => !(t.voice.alive ?? t.voice.playing))).toBe(true);
    expect(musicPlayers()).toHaveLength(0);
    r.dispose();
  });

  it("an outgoing playlist item ringing past its exit cue is tracked: counted, and stopped by handle.stop (P4's point)", async (ctx) => {
    // A's exit cue is at bar 2 but its file runs a bar longer: that bar rings on under B.
    const seg = (id: string, clipPath: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, tracks: [{ name: "t", clip: clipPath }], ...extra });
    const r = await musicLoopback({
      clips: { "a.wav": { level: 0.1, seconds: 4 }, "b.wav": { level: 0.2, seconds: 8 } },
      events: {
        "p.audioevent.json": {
          format: "myco.audioevent@1",
          bus: "Music",
          root: { type: "playlist", id: "p", mode: "sequence", children: [seg("A", "a.wav", { cues: [{ name: "exit", at: "2:1:0" }] }), seg("B", "b.wav")] },
        },
      },
    });
    if (!r) return ctx.skip();
    const handle = r.play("p.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.node.id === "B");
    const p = r.player()!;
    await r.step(10);
    expect(p.tails?.runs.map((x) => x.node.id)).toEqual(["A"]);
    const a = p.tails!.runs[0]!.stems[0]!.voice!;
    expect(a.playing).toBe(true);
    expect(p.instance.voiceCount).toBe(2); // B's stem and A's ringing one
    handle.stop(0.05);
    await r.step(40);
    expect(a.alive ?? a.playing).toBe(false);
    expect(r.maxError(r.out.length - 10 * r.frameFrames, r.out.length, 0)).toBe(0);
    expect(musicPlayers()).toHaveLength(0);
    r.dispose();
  });
});
