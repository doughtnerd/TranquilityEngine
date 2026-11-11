/**
 * R5's pure stinger decision table (api-and-models §2.5). Leaf **L-R5a** fills the skipped cases and
 * `decideStinger`. Inputs are plain seconds, so every expected value is read straight off the input.
 */
import { describe, it } from "vitest";
import { decideStinger, type StingerPolicyInput } from "./stingerPolicy";

/** A trigger on time with nothing sounding; override per case. */
export function input(over: Partial<StingerPolicyInput> = {}): StingerPolicyInput {
  return {
    now: 10, earliest: 10.1, point: 12, nextPoint: 14, ifTooLate: "nextGrid", dontRepeat: 0, lastPlayed: NaN, sounding: 0,
    ...over,
  };
}
void input;
void decideStinger;

describe("decideStinger: on time", () => {
  it.skip("L-R5a: point at or after earliest plays at point, late false, steal false", () => {});
  it.skip("L-R5a: point exactly equal to earliest is on time", () => {});
  it.skip("L-R5a: an on-time stinger ignores ifTooLate (all three values play at point)", () => {});
});

describe("decideStinger: too late (point < earliest)", () => {
  it.skip("L-R5a: nextGrid plays at nextPoint with late true", () => {});
  it.skip("L-R5a: nextGrid with nextPoint NaN drops with reason noPoint", () => {});
  it.skip("L-R5a: nextGrid with nextPoint still before earliest drops with reason noPoint", () => {});
  it.skip("L-R5a: playNow plays at earliest with late true", () => {});
  it.skip("L-R5a: skip drops with reason skip", () => {});
});

describe("decideStinger: no point", () => {
  it.skip("L-R5a: point NaN (no cue ahead) drops with reason noPoint, whatever ifTooLate says", () => {});
});

describe("decideStinger: dontRepeat", () => {
  it.skip("L-R5a: 0 never drops, even with lastPlayed equal to now", () => {});
  it.skip("L-R5a: lastPlayed NaN (never played) never drops", () => {});
  it.skip("L-R5a: now - lastPlayed below dontRepeat drops with reason dontRepeat", () => {});
  it.skip("L-R5a: now - lastPlayed exactly dontRepeat plays", () => {});
  it.skip("L-R5a: dontRepeat is checked before ifTooLate (a late skip stinger inside the window reports dontRepeat)", () => {});
});

describe("decideStinger: at most 4 at once", () => {
  it.skip("L-R5a: sounding 0 to 3 plays with steal false", () => {});
  it.skip("L-R5a: sounding 4 plays with steal true", () => {});
  it.skip("L-R5a: sounding above 4 plays with steal true", () => {});
  it.skip("L-R5a: a dropped stinger (dontRepeat, skip, noPoint) never reports steal", () => {});
});
