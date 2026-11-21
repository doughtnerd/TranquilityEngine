// Ld5 (ADR 0171 §2.1, api-and-models §7): the logic behind the Audio section's meter toggle, loudness targets table and
// reset option. The view is thin over these functions; a case per control option. A refusal is the edit's own result
// (ADR 0313): the meter box's disabled reason is `refusalOf(setBusMeter(d, bus, true))`.
import { describe, expect, it } from "vitest";
import { audioSection } from "../../../engine/audio/audioSection";
import type { AudioSettings } from "../../../engine/audio/settings";
import { readDraft } from "../../../editor/testing";
import { addBus, addLoudnessTarget, isBusMetered, loudnessTargets, removeLoudnessTarget, setBusMeter, setLoudnessResetOnPlay, setLoudnessTarget, MAX_LOUDNESS_TARGETS } from "./audioSettingsModel";
import { audioSettings } from "./audioDraft";
import { refusalOf, type EditResult } from "./editResult";

/** The accepted draft of an edit (ADR 0307), or the test fails with its refusal. */
const nextOf = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

/** Non-root buses that are metered, as the saved settings say. */
const meteredBusCount = (a: AudioSettings): number => a.buses.filter((b, i) => i > 0 && b.meter !== undefined).length;

const empty = () => readDraft({});
const NINTH = "At most 8 buses can be metered";

/** Master plus `n` more buses under it (the defaults already hold Music, SFX, UI, Voice). */
function withBuses(n: number) {
  let d = empty();
  while (audioSettings.read(d).buses.length < n + 1) d = nextOf(addBus(d));
  return d;
}
const names = (d: ReturnType<typeof empty>) => audioSettings.read(d).buses.map((b) => b.name);

describe("the meter toggle", () => {
  it("meters and unmeters a non-root bus; the key is absent when off", () => {
    const on = nextOf(setBusMeter(empty(), "Voice", true));
    expect(isBusMetered(audioSettings.read(on), "Voice")).toBe(true);
    expect(meteredBusCount(audioSettings.read(on))).toBe(1);
    expect(refusalOf(setBusMeter(on, "Voice", true))).toBeNull();
    const off = nextOf(setBusMeter(on, "Voice", false));
    expect(audioSettings.read(off).buses.find((b) => b.name === "Voice")!.meter).toBeUndefined();
    expect(JSON.stringify(off.audio)).not.toContain("meter");
  });
  it("the root is always metered and its toggle changes nothing", () => {
    const d = empty();
    expect(isBusMetered(audioSettings.read(d), "Master")).toBe(true);
    expect(setBusMeter(d, "Master", true)).toEqual({ refused: "Master is always metered" });
    expect(meteredBusCount(audioSettings.read(d))).toBe(0);
  });
  it("the eighth bus meters and the ninth is refused with its message, the draft unchanged", () => {
    let d = withBuses(9);
    const all = names(d).slice(1);
    for (const n of all.slice(0, 8)) {
      expect(refusalOf(setBusMeter(d, n, true))).toBeNull();
      d = nextOf(setBusMeter(d, n, true));
    }
    expect(meteredBusCount(audioSettings.read(d))).toBe(8);
    expect(setBusMeter(d, all[8], true)).toEqual({ refused: NINTH });
    expect(audioSection(d.audio).problems).toEqual([]);
    // Turning one off frees a place; already-metered buses are never refused.
    expect(refusalOf(setBusMeter(d, all[0], true))).toBeNull();
    expect(meteredBusCount(audioSettings.read(nextOf(setBusMeter(nextOf(setBusMeter(d, all[0], false)), all[8], true))))).toBe(8);
  });
});

describe("the loudness targets table", () => {
  it("shows the two owner defaults and writes nothing for them", () => {
    expect(loudnessTargets(audioSettings.read(empty()))).toEqual([
      { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
      { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
    ]);
    expect("loudnessTargets" in (empty().audio as object ?? {})).toBe(false);
  });
  it("adds a target with a unique name up to the limit, then refuses", () => {
    let d = empty();
    for (let i = 2; i < MAX_LOUDNESS_TARGETS; i++) d = nextOf(addLoudnessTarget(d));
    expect(loudnessTargets(audioSettings.read(d)).map((t) => t.name)).toEqual(["console", "mobile", "Target", "Target 2", "Target 3", "Target 4", "Target 5", "Target 6"]);
    expect(refusalOf(addLoudnessTarget(d))).not.toBeNull();
  });
  it("removes a target but keeps the last one", () => {
    let d = nextOf(removeLoudnessTarget(empty(), 0));
    expect(loudnessTargets(audioSettings.read(d)).map((t) => t.name)).toEqual(["mobile"]);
    expect(refusalOf(removeLoudnessTarget(d, 0))).not.toBeNull();
    d = nextOf(addLoudnessTarget(d));
    expect(loudnessTargets(audioSettings.read(d)).map((t) => t.name)).toEqual(["mobile", "Target"]);
  });
  it("edits each field inside its range", () => {
    let d = nextOf(setLoudnessTarget(empty(), 0, { name: " film " }));
    d = nextOf(setLoudnessTarget(d, 0, { integrated: -27 }));
    d = nextOf(setLoudnessTarget(d, 0, { tolerance: 0.5 }));
    d = nextOf(setLoudnessTarget(d, 0, { truePeak: -2 }));
    expect(loudnessTargets(audioSettings.read(d))[0]).toEqual({ name: "film", integrated: -27, tolerance: 0.5, truePeak: -2 });
  });
  it.each([
    ["integrated", -70, 0, -70.5, 0.5],
    ["tolerance", 0, 12, -0.5, 12.5],
    ["truePeak", -20, 0, -20.5, 0.5],
  ] as const)("%s accepts both ends of its range and refuses past them", (key, lo, hi, below, above) => {
    const d = empty();
    expect(loudnessTargets(audioSettings.read(nextOf(setLoudnessTarget(d, 0, { [key]: lo }))))[0][key]).toBe(lo);
    expect(loudnessTargets(audioSettings.read(nextOf(setLoudnessTarget(d, 0, { [key]: hi }))))[0][key]).toBe(hi);
    for (const bad of [below, above, Number.NaN]) {
      expect(refusalOf(setLoudnessTarget(d, 0, { [key]: bad }))).toMatch(/must be/);
    }
    expect(refusalOf(setLoudnessTarget(d, 0, { [key]: lo }))).toBeNull();
  });
  it("refuses an empty, over-long or taken name, and an unknown row", () => {
    const d = empty();
    expect(refusalOf(setLoudnessTarget(d, 0, { name: "   " }))).toMatch(/1 to 32/);
    expect(refusalOf(setLoudnessTarget(d, 0, { name: "x".repeat(33) }))).toMatch(/1 to 32/);
    expect(refusalOf(setLoudnessTarget(d, 0, { name: "x".repeat(32) }))).toBeNull();
    expect(refusalOf(setLoudnessTarget(d, 1, { name: "console" }))).toMatch(/already named "console"/);
    expect(setLoudnessTarget(d, 0, { name: "console" })).toEqual({ next: d });
    expect(refusalOf(setLoudnessTarget(d, 5, { name: "a" }))).toBe("No loudness target 6.");
  });
  it("an edit that gives back the default list is not written", () => {
    const d = nextOf(setLoudnessTarget(empty(), 0, { integrated: -20 }));
    expect("loudnessTargets" in (d.audio as object)).toBe(true);
    expect("loudnessTargets" in (nextOf(setLoudnessTarget(d, 0, { integrated: -24 })).audio as object)).toBe(false);
  });
});

describe("loudnessResetOnPlay", () => {
  it("is on by default, written only when off", () => {
    expect(audioSettings.read(empty()).loudnessResetOnPlay ?? true).toBe(true);
    const off = nextOf(setLoudnessResetOnPlay(empty(), false));
    expect(audioSettings.read(off).loudnessResetOnPlay).toBe(false);
    expect("loudnessResetOnPlay" in (nextOf(setLoudnessResetOnPlay(off, true)).audio as object)).toBe(false);
  });
});
