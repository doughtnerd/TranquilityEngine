import { describe, expect, it } from "vitest";
import { auditionBackend, auditionNotice, buttonStates, instanceAlive, instanceVoices, isStale, limitRows, newInstanceId, nextPhase, parameterChanges } from "./auditionHost";

describe("audition state machine", () => {
  it("plays, releases once, and ends", () => {
    let p = nextPhase("idle", "play");
    expect(p).toBe("playing");
    p = nextPhase(p, "release");
    expect(p).toBe("released");
    expect(nextPhase(p, "release")).toBe("released");
    expect(nextPhase(p, "finished")).toBe("ended");
    expect(nextPhase("playing", "stop")).toBe("ended");
    expect(nextPhase("idle", "stop")).toBe("idle");
    expect(nextPhase("ended", "release")).toBe("ended");
    expect(nextPhase("idle", "refused")).toBe("ended");
    expect(nextPhase("ended", "play")).toBe("playing");
  });
  it("enables the buttons by phase", () => {
    expect(buttonStates("idle")).toEqual({ play: true, stop: false, release: false });
    expect(buttonStates("playing")).toEqual({ play: true, stop: true, release: true });
    expect(buttonStates("released")).toEqual({ play: true, stop: true, release: false });
    expect(buttonStates("ended", false)).toEqual({ play: false, stop: false, release: false });
  });
});

describe("instance rows", () => {
  const rows = [{ id: 1, asset: "a.audioevent.json" }, { id: 4, asset: "b.audioevent.json" }, { id: 5, asset: "b.audioevent.json" }];
  it("finds the instance a play made, not an older one of the same asset", () => {
    expect(newInstanceId([4], rows, "b.audioevent.json")).toBe(5);
    expect(newInstanceId([1, 4, 5], rows, "b.audioevent.json")).toBeNull();
    expect(newInstanceId([], rows, "asset:a.audioevent.json")).toBe(1);
  });
  it("keeps only the instance's voices", () => {
    const v = [{ id: 1, clip: "x", state: "playing", gain: 1, event: 5 }, { id: 2, clip: "y", state: "playing", gain: 1, event: 4 }, { id: 3, clip: "z", state: "playing", gain: 1 }];
    expect(instanceVoices(v, 5).map((x) => x.id)).toEqual([1]);
    expect(instanceVoices(v, null)).toEqual([]);
  });
  it("knows whether the instance is listed", () => {
    expect(instanceAlive(rows, 5)).toBe(true);
    expect(instanceAlive(rows, 9)).toBe(false);
    expect(instanceAlive(rows, null)).toBe(false);
  });
  it("limits the rows shown", () => {
    expect(limitRows([1, 2, 3], 2)).toEqual({ shown: [1, 2], hidden: 1 });
    expect(limitRows([1], 2)).toEqual({ shown: [1], hidden: 0 });
  });
});

describe("parameters and cache", () => {
  it("lists only changed or new parameters", () => {
    expect(parameterChanges({ a: 1, b: "x" }, { a: 1, b: "y", c: 2 })).toEqual([["b", "y"], ["c", 2]]);
    expect(parameterChanges({}, {})).toEqual([]);
  });
  it("is stale only when a different asset object replaced the started one", () => {
    const a = {}, b = {};
    expect(isStale(a, a)).toBe(false);
    expect(isStale(a, b)).toBe(true);
    expect(isStale(undefined, b)).toBe(false);
    expect(isStale(a, undefined)).toBe(false);
  });
});

describe("notice", () => {
  it("names a failed backend first", () => expect(auditionNotice("failed", "idle", null, false)).toMatch(/failed/));
  it("says nothing before the first play", () => expect(auditionNotice("running", "idle", null, false)).toBeNull());
  it("explains locked audio", () => expect(auditionNotice("locked", "playing", "locked", true)).toMatch(/locked/));
  it("explains a play that made nothing", () => expect(auditionNotice("running", "ended", null, false)).toMatch(/Nothing played/));
  it("is quiet while playing normally", () => expect(auditionNotice("running", "playing", null, true)).toBeNull());
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
