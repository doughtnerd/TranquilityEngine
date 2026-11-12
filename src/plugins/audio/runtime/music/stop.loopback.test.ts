// F-17: a stopped music event leaves the registry on the core. `handle.stop(fade)` retires the instance at once, while
// its stems still fade; the event runtime holds it until the last stem voice is freed, then the player is disposed
// (`endMusic`: out of `musicPlayers()` and `Audio.debug().music`, the instance's encoded bytes released). On the
// deterministic-clock fixture (`testing/loopbackClock.ts`), the real core, nothing else playing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { musicLoopback, resetMusicLoopback } from "./testing/loopbackClock";
import { musicPlayers } from "./musicSystem";

afterEach(() => resetMusicLoopback());

const event = {
  format: "myco.audioevent@1",
  bus: "Music",
  root: { type: "segment", id: "A", tracks: [{ name: "t0", clip: "s0.wav" }, { name: "t1", clip: "s1.wav" }] },
};
const clips = { "s0.wav": { level: 0.1, seconds: 3 }, "s1.wav": { level: 0.05, seconds: 3 } };

describe("a stopped music event (F-17)", () => {
  it("leaves musicPlayers() and Audio.debug().music once its stems have faded, and releases its instance", async (ctx) => {
    const r = await musicLoopback({ clips, events: { "m.audioevent.json": event } });
    if (!r) return ctx.skip();
    const handle = r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    await r.step(5);
    const released = vi.spyOn(r.backend.musicOps, "releaseInstance");
    const group = r.player()!.instance.group;
    expect(r.backend.debug().music).toHaveLength(1);
    handle.stop(0.2);
    // The fade is 0.2 s (about 13 frames here); allow it, the core's end report and the free.
    await r.step(40);
    expect(musicPlayers()).toHaveLength(0);
    expect(r.backend.debug().music).toEqual([]);
    expect(released).toHaveBeenCalledWith(group);
    r.dispose();
  });
});
