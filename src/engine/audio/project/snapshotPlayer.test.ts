// ADR 0330 "Snapshots blend": the snapshot player through its interface — start kinds, linear fades, hold, interrupted
// fades, conditions on parameters, live edits — and the blend it feeds (`resolveAt`: priority, Add, effect overrides).
import { describe, expect, it } from "vitest";
import type { ParameterDef } from "../eventFormat";
import { SnapshotPlayer } from "./snapshotPlayer";
import type { Snapshot } from "./types";

const snap = (s: Partial<Snapshot> & { name: string }): Snapshot => ({
  folder: "", start: { kind: "code" }, fadeInMs: 1000, fadeOutMs: 1000, holdMs: 0, priority: 0, combine: "override", buses: {}, effects: {}, ...s,
});
const PARAMS: ParameterDef[] = [
  { name: "depth", min: 0, max: 10, default: 0 } as ParameterDef,
  { name: "state", labels: ["Play", "Paused"], default: "Play" } as ParameterDef,
];

describe("SnapshotPlayer", () => {
  it("base snapshots and conditions that hold are on at full weight at configure; code and never ones are off", () => {
    const p = new SnapshotPlayer();
    p.configure([
      snap({ name: "Base", start: { kind: "base" }, buses: { Music: -3 } }),
      snap({ name: "Deep", start: { kind: "conditions", match: "all", conditions: [{ parameter: "depth", op: "gt", value: 1 }] }, buses: { SFX: -6 } }),
      snap({ name: "Code", buses: { UI: -9 } }),
      snap({ name: "Never", start: { kind: "never" }, buses: { UI: -9 } }),
    ], PARAMS, { depth: 2 });
    expect(p.resolveAt(0).levels).toEqual({ Music: -3, SFX: -6 });
    expect(p.isActive("Code", 0)).toBe(false);
    expect(p.stop("Base", 0)).toBe(false); // always on
  });

  it("a fade is a linear ramp of the weight, so the offset is linear in dB; a stop part-way turns round over its share", () => {
    const p = new SnapshotPlayer();
    p.configure([snap({ name: "A", buses: { Music: -12 }, fadeInMs: 1000, fadeOutMs: 500 })], PARAMS);
    expect(p.start("A", 10)).toBe(true);
    expect(p.resolveAt(10.25).levels.Music).toBeCloseTo(-3, 9);
    expect(p.resolveAt(10.5).levels.Music).toBeCloseTo(-6, 9);
    expect(p.nextBreak(10.25)).toBe(11);
    // Stopped half-way in: half of the 0.5 s fade out, from -6 dB.
    p.stop("A", 10.5);
    expect(p.resolveAt(10.625).levels.Music).toBeCloseTo(-3, 9);
    expect(p.isActive("A", 10.7)).toBe(true);
    expect(p.resolveAt(10.75).levels.Music).toBeUndefined();
    p.prune(10.75);
    expect(p.isActive("A", 10.75)).toBe(false);
  });

  it("a stop inside the hold fades out when the hold ends; a start or stop can pass its own fade", () => {
    const p = new SnapshotPlayer();
    p.configure([snap({ name: "A", buses: { Music: -10 }, holdMs: 2000, fadeOutMs: 1000 })], PARAMS);
    p.start("A", 0, 0);
    p.stop("A", 0.5);
    expect(p.resolveAt(1.9).levels.Music).toBe(-10);
    expect(p.resolveAt(2.5).levels.Music).toBeCloseTo(-5, 9);
    p.start("A", 2.5, 0.5); // turns round: from weight 0.5 over half of 0.5 s
    expect(p.resolveAt(2.75).levels.Music).toBeCloseTo(-10, 9);
  });

  it("conditions follow their parameters (labels by name or index); a script start holds it past its conditions until stopped", () => {
    const p = new SnapshotPlayer();
    p.configure([
      snap({ name: "Pause", fadeInMs: 0, fadeOutMs: 0, start: { kind: "conditions", match: "any", conditions: [{ parameter: "state", op: "is", value: "Paused" }] }, buses: { Music: -20 } }),
    ], PARAMS);
    expect(p.setParameter("state", "Paused", 1)).toBe(true);
    expect(p.resolveAt(1).levels.Music).toBe(-20);
    expect(p.setParameter("state", 1, 2)).toBe(false); // the same value
    expect(p.setParameter("state", "Play", 3)).toBe(true);
    expect(p.resolveAt(3).levels.Music).toBeUndefined();
    expect(p.setParameter("depth", 4, 4)).toBe(false); // not read by any condition
  });

  it("feeds the blend: Override by priority (equal: the one started last), Add on top, overrides from the winner only", () => {
    const p = new SnapshotPlayer();
    p.configure([
      snap({ name: "Low", priority: 10, fadeInMs: 0, buses: { Music: -6 }, effects: { Music: { fx1: { cutoff: 800 } } } }),
      snap({ name: "High", priority: 40, fadeInMs: 0, buses: { Music: -14 }, effects: { Music: { fx1: { cutoff: 2000 } } } }),
      snap({ name: "Add", combine: "add", fadeInMs: 0, buses: { Music: -2 }, effects: { Music: { fx1: { cutoff: 100 } } } }),
      snap({ name: "Peer", priority: 40, fadeInMs: 0, buses: { Music: -1 } }),
    ], PARAMS);
    p.start("High", 0);
    p.start("Low", 1);
    p.start("Add", 2);
    let mix = p.resolveAt(3);
    expect(mix.levels.Music).toBe(-16);
    expect(mix.effects.Music!.fx1!.cutoff).toEqual({ value: 2000, from: "High" });
    p.start("Peer", 4);
    mix = p.resolveAt(5);
    expect(mix.levels.Music).toBe(-3); // Peer started last at the same priority, plus Add
  });

  it("a higher-priority snapshot fading in crossfades from the one under it instead of jumping", () => {
    const p = new SnapshotPlayer();
    p.configure([
      snap({ name: "Under", priority: 0, fadeInMs: 0, buses: { Music: -6 } }),
      snap({ name: "Over", priority: 50, fadeInMs: 1000, buses: { Music: -20 } }),
    ], PARAMS);
    p.start("Under", 0);
    p.start("Over", 1);
    expect(p.resolveAt(1).levels.Music).toBe(-6);
    expect(p.resolveAt(1.5).levels.Music).toBeCloseTo(-13, 9);
    expect(p.resolveAt(2).levels.Music).toBe(-20);
  });

  it("a live edit keeps fade state under the new definition; a renamed one stays on; a removed one leaves; stopCode spares the others", () => {
    const p = new SnapshotPlayer();
    p.configure([snap({ name: "A", fadeInMs: 0, buses: { Music: -6 } }), snap({ name: "B", fadeInMs: 0, buses: { SFX: -6 } })], PARAMS);
    p.start("A", 0);
    p.start("B", 0, undefined, false);
    p.setSnapshots([snap({ name: "Hush", fadeInMs: 0, buses: { Music: -9 } }), snap({ name: "B", fadeInMs: 0, buses: { SFX: -6 } })], PARAMS, 1, new Map([["A", "Hush"]]));
    expect(p.resolveAt(1).levels).toEqual({ Music: -9, SFX: -6 });
    expect(p.latestCode()).toBe("Hush");
    p.stopCode(2, 0);
    expect(p.isActive("Hush", 2)).toBe(false);
    expect(p.isActive("B", 2)).toBe(true); // not started by code
    p.setSnapshots([], PARAMS, 3);
    expect(p.resolveAt(3).levels).toEqual({});
  });
});
