// Ld5 (ADR 0171 §2.1, api-and-models §7): the logic behind the Audio section's meter toggle, loudness targets table and
// reset option. The view is thin over these functions; a case per control option.
import { describe, expect, it } from "vitest";
import { readDraft } from "../../../editor/projectSettingsModel";
import {
  addBus, addLoudnessTarget, audioOf, audioProblems, busMeterRefusal, isBusMetered, loudnessTargetRefusal, loudnessTargets, meteredBusCount,
  removeLoudnessTarget, setBusMeter, setLoudnessResetOnPlay, setLoudnessTarget, MAX_LOUDNESS_TARGETS,
} from "./audioSettingsModel";

const empty = () => readDraft({});
const NINTH = "At most 8 buses can be metered";

/** Master plus `n` more buses under it (the defaults already hold Music, SFX, UI, Voice). */
function withBuses(n: number) {
  let d = empty();
  while (audioOf(d).buses.length < n + 1) d = addBus(d);
  return d;
}
const names = (d: ReturnType<typeof empty>) => audioOf(d).buses.map((b) => b.name);

describe("the meter toggle", () => {
  it("meters and unmeters a non-root bus; the key is absent when off", () => {
    const on = setBusMeter(empty(), "Voice", true);
    expect(isBusMetered(audioOf(on), "Voice")).toBe(true);
    expect(meteredBusCount(audioOf(on))).toBe(1);
    expect(busMeterRefusal(on, "Voice")).toBeNull();
    const off = setBusMeter(on, "Voice", false);
    expect(audioOf(off).buses.find((b) => b.name === "Voice")!.meter).toBeUndefined();
    expect(JSON.stringify(off.audio)).not.toContain("meter");
  });
  it("the root is always metered and its toggle changes nothing", () => {
    const d = empty();
    expect(isBusMetered(audioOf(d), "Master")).toBe(true);
    expect(setBusMeter(d, "Master", true)).toEqual(d);
    expect(meteredBusCount(audioOf(d))).toBe(0);
  });
  it("the eighth bus meters and the ninth is refused with its message, the draft unchanged", () => {
    let d = withBuses(9);
    const all = names(d).slice(1);
    for (const n of all.slice(0, 8)) {
      expect(busMeterRefusal(d, n)).toBeNull();
      d = setBusMeter(d, n, true);
    }
    expect(meteredBusCount(audioOf(d))).toBe(8);
    expect(busMeterRefusal(d, all[8])).toBe(NINTH);
    const same = setBusMeter(d, all[8], true);
    expect(same).toBe(d);
    expect(audioProblems(same)).toEqual([]);
    // Turning one off frees a place; already-metered buses are never refused.
    expect(busMeterRefusal(d, all[0])).toBeNull();
    expect(meteredBusCount(audioOf(setBusMeter(setBusMeter(d, all[0], false), all[8], true)))).toBe(8);
  });
});

describe("the loudness targets table", () => {
  it("shows the two owner defaults and writes nothing for them", () => {
    expect(loudnessTargets(audioOf(empty()))).toEqual([
      { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
      { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
    ]);
    expect("loudnessTargets" in (empty().audio as object ?? {})).toBe(false);
  });
  it("adds a target with a unique name up to the limit, then refuses", () => {
    let d = empty();
    for (let i = 2; i < MAX_LOUDNESS_TARGETS; i++) d = addLoudnessTarget(d);
    expect(loudnessTargets(audioOf(d)).map((t) => t.name)).toEqual(["console", "mobile", "Target", "Target 2", "Target 3", "Target 4", "Target 5", "Target 6"]);
    expect(addLoudnessTarget(d)).toBe(d);
  });
  it("removes a target but keeps the last one", () => {
    let d = removeLoudnessTarget(empty(), 0);
    expect(loudnessTargets(audioOf(d)).map((t) => t.name)).toEqual(["mobile"]);
    expect(removeLoudnessTarget(d, 0)).toBe(d);
    d = addLoudnessTarget(d);
    expect(loudnessTargets(audioOf(d)).map((t) => t.name)).toEqual(["mobile", "Target"]);
  });
  it("edits each field inside its range", () => {
    let d = setLoudnessTarget(empty(), 0, { name: " film " });
    d = setLoudnessTarget(d, 0, { integrated: -27 });
    d = setLoudnessTarget(d, 0, { tolerance: 0.5 });
    d = setLoudnessTarget(d, 0, { truePeak: -2 });
    expect(loudnessTargets(audioOf(d))[0]).toEqual({ name: "film", integrated: -27, tolerance: 0.5, truePeak: -2 });
  });
  it.each([
    ["integrated", -70, 0, -70.5, 0.5],
    ["tolerance", 0, 12, -0.5, 12.5],
    ["truePeak", -20, 0, -20.5, 0.5],
  ] as const)("%s accepts both ends of its range and refuses past them", (key, lo, hi, below, above) => {
    const d = empty();
    expect(loudnessTargets(audioOf(setLoudnessTarget(d, 0, { [key]: lo })))[0][key]).toBe(lo);
    expect(loudnessTargets(audioOf(setLoudnessTarget(d, 0, { [key]: hi })))[0][key]).toBe(hi);
    for (const bad of [below, above, Number.NaN]) {
      expect(loudnessTargetRefusal(d, 0, { [key]: bad })).toMatch(/must be/);
      expect(setLoudnessTarget(d, 0, { [key]: bad })).toBe(d);
    }
    expect(loudnessTargetRefusal(d, 0, { [key]: lo })).toBeNull();
  });
  it("refuses an empty, over-long or taken name, and an unknown row", () => {
    const d = empty();
    expect(loudnessTargetRefusal(d, 0, { name: "   " })).toMatch(/1 to 32/);
    expect(loudnessTargetRefusal(d, 0, { name: "x".repeat(33) })).toMatch(/1 to 32/);
    expect(loudnessTargetRefusal(d, 0, { name: "x".repeat(32) })).toBeNull();
    expect(loudnessTargetRefusal(d, 1, { name: "console" })).toMatch(/already named "console"/);
    expect(loudnessTargetRefusal(d, 0, { name: "console" })).toBeNull();
    expect(loudnessTargetRefusal(d, 5, { name: "a" })).toMatch(/No loudness target/);
    expect(setLoudnessTarget(d, 1, { name: "console" })).toBe(d);
  });
  it("an edit that gives back the default list is not written", () => {
    const d = setLoudnessTarget(empty(), 0, { integrated: -20 });
    expect("loudnessTargets" in (d.audio as object)).toBe(true);
    expect("loudnessTargets" in (setLoudnessTarget(d, 0, { integrated: -24 }).audio as object)).toBe(false);
  });
});

describe("loudnessResetOnPlay", () => {
  it("is on by default, written only when off", () => {
    expect(audioOf(empty()).loudnessResetOnPlay ?? true).toBe(true);
    const off = setLoudnessResetOnPlay(empty(), false);
    expect(audioOf(off).loudnessResetOnPlay).toBe(false);
    expect("loudnessResetOnPlay" in (setLoudnessResetOnPlay(off, true).audio as object)).toBe(false);
  });
});
