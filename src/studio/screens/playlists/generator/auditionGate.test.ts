// The audition gate (ADR 0360 §9) through its interface: a held source starts one voice and keys it off when let go,
// auto-repeat starts nothing, several keys play several notes, and the DAW key layout.
import { describe, expect, it } from "vitest";
import { EMPTY_GATE, gateOpen, gatePress, gateRelease, gateReleaseAll, keyPitchText, keySource, noteOfKey, octaveKeys } from "./auditionGate";

describe("the audition gate", () => {
  it("starts on press and releases on let go", () => {
    const a = gatePress(EMPTY_GATE, "space");
    expect(a.commands).toEqual([{ kind: "start", source: "space", semitones: 0, pitch: 1 }]);
    expect(gateOpen(a.state)).toBe(true);
    const b = gateRelease(a.state, "space");
    expect(b.commands).toEqual([{ kind: "release", source: "space" }]);
    expect(gateOpen(b.state)).toBe(false);
  });

  it("ignores a held key's auto-repeat and a release of nothing", () => {
    const a = gatePress(EMPTY_GATE, keySource("a"), 0);
    const repeat = gatePress(a.state, keySource("A"), 0);
    expect(repeat.commands).toEqual([]);
    expect(repeat.state).toBe(a.state);
    expect(gateRelease(EMPTY_GATE, "space").commands).toEqual([]);
  });

  it("plays several notes at once and lets them all go", () => {
    let s = gatePress(EMPTY_GATE, keySource("a"), 0).state;
    const fifth = gatePress(s, keySource("g"), 7);
    expect(fifth.commands[0]).toMatchObject({ kind: "start", semitones: 7 });
    expect((fifth.commands[0] as { pitch: number }).pitch).toBeCloseTo(1.4983, 4);
    s = fifth.state;
    const one = gateRelease(s, keySource("a"));
    expect(gateOpen(one.state)).toBe(true);
    const all = gateReleaseAll(fifth.state);
    expect(all.commands.map((c) => c.source).sort()).toEqual(["key:A", "key:G"]);
    expect(gateOpen(all.state)).toBe(false);
  });

  it("maps the DAW keys to one octave", () => {
    expect(["A", "w", "K", "H", "Z", "Space"].map(noteOfKey)).toEqual([0, 1, 12, 9, null, null]);
    const keys = octaveKeys();
    expect(keys).toHaveLength(13);
    expect(keys.filter((k) => k.black).map((k) => k.key)).toEqual(["W", "E", "T", "Y", "U"]);
    expect(gatePress(EMPTY_GATE, "note:12", 12).commands[0]).toMatchObject({ kind: "start", pitch: 2 });
    expect(keyPitchText(12, 440)).toBe("+12 st · 880 Hz");
    expect(keyPitchText(0, null)).toBe("root");
  });
});
