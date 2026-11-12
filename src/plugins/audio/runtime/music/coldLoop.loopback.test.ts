// F-23: a looping segment whose clips were never decoded before (cold) keeps looping on its first play. The PLAY's loop
// is decided at admission, before the admission's own acquire has decoded the clip, so a region bounded by `"end"` (the
// file's end, unknown without the clip's length) must still loop the member. Real core, deterministic
// (`testing/loopbackClock.ts` with `cold`: no clip is preloaded).
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE } from "./testing/loopbackClock";
import { musicPlayers } from "./musicSystem";

afterEach(() => resetMusicLoopback());

/** As the Sound Lab's `music-intensity`: a forever loop from bar 1 to the file's end, exit at the end, three stems. */
const event = {
  format: "myco.audioevent@1",
  bus: "Music",
  root: {
    type: "segment",
    id: "intensity",
    tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }],
    cues: [{ name: "entry", at: "1:1:0" }, { name: "exit", at: "end" }],
    entry: "entry",
    exit: "exit",
    regions: [{ id: "loop", from: "1:1:0", to: "end", count: 0 }],
    tracks: [
      { name: "pad", clip: "pad.wav" },
      { name: "pulse", clip: "pulse.wav" },
      { name: "lead", clip: "lead.wav" },
    ],
  },
};

describe("a cold looping segment (F-23)", () => {
  for (const cold of [true, false]) {
    it(`loops past its first loop end with its clips ${cold ? "cold" : "preloaded"}`, async (ctx) => {
      const seconds = 2;
      const r = await musicLoopback({
        cold,
        clips: { "pad.wav": { level: 0.1, seconds }, "pulse.wav": { level: 0.05, seconds }, "lead.wav": { level: 0.025, seconds } },
        events: { "m.audioevent.json": event },
      });
      if (!r) return ctx.skip();
      r.play("m.audioevent.json");
      await r.stepUntil(() => r.player()?.run?.state === "playing");
      const run = r.player()!.run!;
      for (const s of run.stems) expect(s.streamed).toBe(false);
      const f0 = r.frameOfTime(run.startAt);
      // Three and a half passes: the stems wrap at every file end, the output holds the stems' sum, the instance plays on.
      const end = f0 + Math.round(3.5 * seconds * RATE);
      await r.stepToFrame(end);
      expect(r.firstDeparture(f0 + 64, 0.175, 1e-3)).toBe(-1);
      expect(musicPlayers()).toHaveLength(1);
      expect(r.player()!.run?.state).toBe("playing");
      r.dispose();
    });
  }
});
