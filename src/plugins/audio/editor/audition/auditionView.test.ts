// ADR 0268: what the audition's views decide on their own. The audition itself is tested through its interface in audition.test.ts.
import { describe, expect, it } from "vitest";
import { auditionBackend, buttonStates, limitRows, stingerNames } from "./auditionView";

describe("buttons and rows", () => {
  it("enables the buttons by phase", () => {
    expect(buttonStates("idle")).toEqual({ play: true, stop: false, release: false });
    expect(buttonStates("playing")).toEqual({ play: true, stop: true, release: true });
    expect(buttonStates("released")).toEqual({ play: true, stop: true, release: false });
    expect(buttonStates("ended", false)).toEqual({ play: false, stop: false, release: false });
  });
  it("limits the rows shown", () => {
    expect(limitRows([1, 2, 3], 2)).toEqual({ shown: [1, 2], hidden: 1 });
    expect(limitRows([1], 2)).toEqual({ shown: [1], hidden: 0 });
  });
});

describe("backend label", () => {
  it("names the core without a note", () => {
    expect(auditionBackend("core")).toEqual({ label: "Audio core", skipsFilterAndSends: false, note: null });
  });
  it("names the Babylon fallback and says filters and aux sends are skipped", () => {
    const b = auditionBackend("babylon");
    expect(b.label).toBe("Babylon fallback");
    expect(b.skipsFilterAndSends).toBe(true);
    expect(b.note).toMatch(/filters and aux sends/);
  });
  it("says the core is loading while the stand-in plays, and falls back to a name for a fake", () => {
    expect(auditionBackend("pending").label).toBe("Audio core loading");
    expect(auditionBackend("fake").label).toBe("fake");
    expect(auditionBackend(undefined).label).toBe("Audio core");
  });
});

describe("stinger names", () => {
  it("lists stinger trigger names across the tree without repeats", () => {
    const stinger = (trigger: string) => ({ trigger, segment: "s", at: "beat" });
    const root = {
      type: "playlist", stingers: [stinger("hit"), stinger("win")], library: [],
      children: [{ type: "musicSwitch", stingers: [stinger("hit"), stinger("lose")], library: [], children: [{ type: "segment" }] }],
    };
    expect(stingerNames(root as never)).toEqual(["hit", "win", "lose"]);
    expect(stingerNames(undefined)).toEqual([]);
  });
});
