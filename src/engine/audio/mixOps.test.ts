// L-Mo1a (api-and-models §6.2; the M5c table row's acceptance): `invert` round trip for every op, and `diffOps(a, b)`
// applied to `a` gives `b`, including property-style random settings pairs. Skeleton by Mo1; the leaf fills the cases.
import { describe, it } from "vitest";

describe("invert: applying op then its inverse gives the settings back (L-Mo1a)", () => {
  it.skip("setBus volume, mute, maxVoices (set and null), bed (set and null), bedPriority (set and null), meter (on and off)", () => {});
  it.skip("addBus at the end, at an index, under an unknown parent (falls back to the root)", () => {});
  it.skip("removeBus of a leaf, and of a bus with descendants, effects, snapshot entries, ducking rules, automation and a meter", () => {});
  it.skip("renameBus (references in snapshots, ducking and automation follow)", () => {});
  it.skip("moveBus", () => {});
  it.skip("addEffect at the end and before the end", () => {});
  it.skip("removeEffect", () => {});
  it.skip("moveEffect forwards and backwards", () => {});
  it.skip("setEffect on a filter, a compressor and a reverb send", () => {});
  it.skip("addSnapshot with and without a name", () => {});
  it.skip("removeSnapshot with volume and low-pass entries", () => {});
  it.skip("renameSnapshot", () => {});
  it.skip("setSnapshot volume and lowpass, set and null", () => {});
  it.skip("setDucking insert, replace and remove (level and presence rules)", () => {});
  it.skip("setAutomation insert, replace and remove", () => {});
  it.skip("setTarget insert, replace and remove, from the default list and from an authored one", () => {});
  it.skip("setOption loudnessResetOnPlay both ways", () => {});
  it.skip("a refused or no-op op inverts to no ops", () => {});
});

describe("diffOps(a, b) applied to a gives b (L-Mo1a)", () => {
  it.skip("identical settings give no ops and no restartRequired", () => {});
  it.skip("one case per op kind: the single edit's settings pair diffs back to b", () => {});
  it.skip("a rename it can't see is remove plus add; a reordered bus list still lands on b", () => {});
  it.skip("a changed root name lands on b", () => {});
  it.skip("swapped snapshot and target names land on b", () => {});
  it.skip("keys outside LIVE_KEYS are listed in restartRequired and give no ops", () => {});
  it.skip("property: random canonical settings pairs (seeded, ≥ 500 pairs) diff and apply to b", () => {});
  it.skip("property: diffOps' ops are each accepted (opRefusal null) at the point they apply", () => {});
});
