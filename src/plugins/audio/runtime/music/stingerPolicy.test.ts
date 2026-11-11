/**
 * R5's pure stinger decision table (api-and-models §2.5). Leaf **L-R5a** fills the skipped cases and
 * `decideStinger`. Inputs are plain seconds, so every expected value is read straight off the input.
 */
import { describe, expect, it } from "vitest";
import { decideStinger, type StingerPolicyInput } from "./stingerPolicy";

/** A trigger on time with nothing sounding; override per case. */
export function input(over: Partial<StingerPolicyInput> = {}): StingerPolicyInput {
  return {
    now: 10, earliest: 10.1, point: 12, nextPoint: 14, ifTooLate: "nextGrid", dontRepeat: 0, lastPlayed: NaN, sounding: 0,
    ...over,
  };
}

describe("decideStinger: on time", () => {
  it("L-R5a: point at or after earliest plays at point, late false, steal false", () => {
    const i = input({ point: 12, earliest: 10.1 });
    expect(decideStinger(i)).toEqual({ play: true, at: 12, late: false, steal: false });
  });
  it("L-R5a: point exactly equal to earliest is on time", () => {
    const i = input({ point: 10.1, earliest: 10.1 });
    expect(decideStinger(i)).toEqual({ play: true, at: 10.1, late: false, steal: false });
  });
  it("L-R5a: an on-time stinger ignores ifTooLate (all three values play at point)", () => {
    for (const ifTooLate of ["nextGrid", "playNow", "skip"] as const) {
      const i = input({ point: 12, earliest: 10.1, ifTooLate });
      expect(decideStinger(i)).toEqual({ play: true, at: 12, late: false, steal: false });
    }
  });
});

describe("decideStinger: too late (point < earliest)", () => {
  it("L-R5a: nextGrid plays at nextPoint with late true", () => {
    const i = input({ point: 10.05, earliest: 10.1, nextPoint: 14, ifTooLate: "nextGrid" });
    expect(decideStinger(i)).toEqual({ play: true, at: 14, late: true, steal: false });
  });
  it("L-R5a: nextGrid with nextPoint NaN drops with reason noPoint", () => {
    const i = input({ point: 10.05, earliest: 10.1, nextPoint: NaN, ifTooLate: "nextGrid" });
    expect(decideStinger(i)).toEqual({ play: false, reason: "noPoint" });
  });
  it("L-R5a: nextGrid with nextPoint still before earliest drops with reason noPoint", () => {
    const i = input({ point: 10.05, earliest: 10.1, nextPoint: 10.08, ifTooLate: "nextGrid" });
    expect(decideStinger(i)).toEqual({ play: false, reason: "noPoint" });
  });
  it("L-R5a: playNow plays at earliest with late true", () => {
    const i = input({ point: 10.05, earliest: 10.1, ifTooLate: "playNow" });
    expect(decideStinger(i)).toEqual({ play: true, at: 10.1, late: true, steal: false });
  });
  it("L-R5a: skip drops with reason skip", () => {
    const i = input({ point: 10.05, earliest: 10.1, ifTooLate: "skip" });
    expect(decideStinger(i)).toEqual({ play: false, reason: "skip" });
  });
});

describe("decideStinger: no point", () => {
  it("L-R5a: point NaN (no cue ahead) drops with reason noPoint, whatever ifTooLate says", () => {
    for (const ifTooLate of ["nextGrid", "playNow", "skip"] as const) {
      const i = input({ point: NaN, nextPoint: 14, ifTooLate });
      expect(decideStinger(i)).toEqual({ play: false, reason: "noPoint" });
    }
  });
});

describe("decideStinger: dontRepeat", () => {
  it("L-R5a: 0 never drops, even with lastPlayed equal to now", () => {
    const i = input({ now: 10, dontRepeat: 0, lastPlayed: 10 });
    expect(decideStinger(i)).toEqual({ play: true, at: 12, late: false, steal: false });
  });
  it("L-R5a: lastPlayed NaN (never played) never drops", () => {
    const i = input({ dontRepeat: 5, lastPlayed: NaN });
    expect(decideStinger(i)).toEqual({ play: true, at: 12, late: false, steal: false });
  });
  it("L-R5a: now - lastPlayed below dontRepeat drops with reason dontRepeat", () => {
    const i = input({ now: 10, dontRepeat: 5, lastPlayed: 8 });
    expect(decideStinger(i)).toEqual({ play: false, reason: "dontRepeat" });
  });
  it("L-R5a: now - lastPlayed exactly dontRepeat plays", () => {
    const i = input({ now: 10, dontRepeat: 2, lastPlayed: 8 });
    expect(decideStinger(i)).toEqual({ play: true, at: 12, late: false, steal: false });
  });
  it("L-R5a: dontRepeat is checked before ifTooLate (a late skip stinger inside the window reports dontRepeat)", () => {
    const i = input({ now: 10, point: 10.05, earliest: 10.1, dontRepeat: 5, lastPlayed: 9, ifTooLate: "skip" });
    expect(decideStinger(i)).toEqual({ play: false, reason: "dontRepeat" });
  });
});

describe("decideStinger: at most 4 at once", () => {
  it("L-R5a: sounding 0 to 3 plays with steal false", () => {
    for (const sounding of [0, 1, 2, 3]) {
      expect(decideStinger(input({ sounding }))).toEqual({ play: true, at: 12, late: false, steal: false });
    }
  });
  it("L-R5a: sounding 4 plays with steal true", () => {
    expect(decideStinger(input({ sounding: 4 }))).toEqual({ play: true, at: 12, late: false, steal: true });
  });
  it("L-R5a: sounding above 4 plays with steal true", () => {
    expect(decideStinger(input({ sounding: 7 }))).toEqual({ play: true, at: 12, late: false, steal: true });
  });
  it("L-R5a: a dropped stinger (dontRepeat, skip, noPoint) never reports steal", () => {
    const drops = [
      input({ sounding: 4, now: 10, dontRepeat: 5, lastPlayed: 9 }),
      input({ sounding: 4, point: 10.05, earliest: 10.1, ifTooLate: "skip" }),
      input({ sounding: 4, point: NaN }),
    ];
    for (const i of drops) {
      const d = decideStinger(i);
      expect(d.play).toBe(false);
      expect(d).not.toHaveProperty("steal");
    }
  });
});
