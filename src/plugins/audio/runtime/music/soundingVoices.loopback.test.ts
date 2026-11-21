// ADR 0320: a music event instance's sounding voices come from one walk, so its voice count and its controls (pause,
// resume, fade) reach every kind of music voice at once: the stem, a loop tail ringing over the wrap (R4a) and a
// stinger (R5). On the real core (`testing/loopbackClock.ts`), read off the output: a voice the walk missed would
// still be heard.
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const event = {
  format: "myco.audioevent@1",
  bus: "Music",
  root: {
    type: "playlist", id: "p", mode: "sequence",
    children: [{ type: "segment", id: "A", tracks: [{ name: "t", clip: "a.wav" }], regions: [{ id: "loop", from: "1:1:0", to: "2:1:0", count: 0, tailBeats: 4 }] }],
    library: [{ type: "segment", id: "hit", tracks: [{ name: "t", clip: "hit.wav" }] }],
    stingers: [{ trigger: "hit", segment: "hit", at: "beat" }],
  },
};

describe("a music instance's sounding voices (ADR 0320)", () => {
  it("counts, pauses, resumes and fades the stem, the loop tail and the stinger together", async (ctx) => {
    const r = await musicLoopback({
      clips: { "a.wav": { level: 0.1, seconds: 4 }, "hit.wav": { level: 0.05, seconds: 4 } },
      events: { "m.audioevent.json": event },
    });
    if (!r) return ctx.skip();
    const handle = r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const p = r.player()!;
    const wrap = p.run!.startAt + 2; // one bar at 120 bpm
    await r.stepToFrame(r.frameOfTime(p.run!.startAt + 1));
    expect(handle.trigger("hit")).toBe(true);
    // Past the wrap: the stem's next pass, its tail ringing, and the stinger, all sounding.
    await r.stepToFrame(r.frameOfTime(wrap) + 10 * r.frameFrames);
    expect(p.tails?.ringing).toHaveLength(1);
    expect(p.stingers?.sounding).toHaveLength(1);
    const inst = p.instance;
    expect(inst.voiceCount).toBe(3);
    expect(handle.playing).toBe(true);

    inst.pause();
    await r.step(10);
    let from = r.out.length - 5 * r.frameFrames;
    expect(r.maxError(from, r.out.length, 0)).toBe(0);

    inst.resume();
    await r.step(10);
    from = r.out.length - 5 * r.frameFrames;
    // All three again: stem 0.1, tail 0.1, stinger 0.05.
    expect(r.out[from]!).toBeCloseTo(0.25, 3);

    handle.fade(0, 0);
    await r.step(10);
    from = r.out.length - 5 * r.frameFrames;
    expect(r.maxError(from, r.out.length, 0)).toBe(0);
    expect(inst.voiceCount).toBe(3); // faded to silence, still playing
    handle.stop();
    r.dispose();
  });
});
