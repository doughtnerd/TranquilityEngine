// ADR 0348 "Replay": a take records the pick generator state of the World plays go to, and replay restarts that World's
// generator from it, so the picks after it are the recording's. Through `Audio.play` on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "../playlists/testKit";
import { activeWorldRandomState, reseedActiveWorld } from "./takeSeed";

const kit = eventKit();
const FOUR = [sample("a.wav"), sample("b.wav"), sample("c.wav"), sample("d.wav")];

/** The sample paths `n` triggers of `path` played. */
function picks(path: string, n: number): string[] {
  const from = kit.fake.plays.length;
  for (let i = 0; i < n; i++) Audio.play(path);
  return kit.fake.plays.slice(from).map((p) => p.path);
}

describe("take reseed (ADR 0348)", () => {
  it("restarting from a recorded state repeats the picks made after it", async () => {
    await kit.boot({ "r.playlist.json": pla("queue", FOUR, { queue: { pick: "random", avoidRepeat: 0 } }) });
    picks("r.playlist.json", 3); // the game ran a while before the take began
    const state = activeWorldRandomState();
    expect(state).not.toBeNull();
    const recorded = picks("r.playlist.json", 12);
    picks("r.playlist.json", 7); // and on after it
    expect(reseedActiveWorld(state!)).toBe(true);
    expect(picks("r.playlist.json", 12)).toEqual(recorded);
    expect(activeWorldRandomState()).not.toBe(state);
  });

  it("forgets the pick history, so a shuffle starts its bag again as the recording's did", async () => {
    await kit.boot({ "s.playlist.json": pla("queue", FOUR, { queue: { pick: "shuffle" } }) });
    const state = activeWorldRandomState()!;
    const recorded = picks("s.playlist.json", 6);
    picks("s.playlist.json", 1); // mid-bag
    reseedActiveWorld(state);
    expect(picks("s.playlist.json", 6)).toEqual(recorded);
  });

  it("reseeds a World whose project has no seed, and answers null for its state before", async () => {
    await kit.boot({ "r.playlist.json": pla("queue", FOUR, { queue: { pick: "random", avoidRepeat: 0 } }) }, { seed: undefined });
    expect(activeWorldRandomState()).toBeNull();
    reseedActiveWorld(12345);
    const a = picks("r.playlist.json", 8);
    reseedActiveWorld(12345);
    expect(picks("r.playlist.json", 8)).toEqual(a);
  });
});
