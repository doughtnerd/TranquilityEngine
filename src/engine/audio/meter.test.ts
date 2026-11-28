import { describe, expect, it } from "vitest";
import { LenientReader } from "./lenientRead";
import { DEFAULT_METER, isMeter, meterParts, parseMeter } from "./meter";

describe("meter", () => {
  it("knows a valid meter: one or two digits each side, neither zero", () => {
    expect(["4/4", "7/8", "12/16", "3/4"].every(isMeter)).toBe(true);
    expect(["0/4", "4/0", "4", "4/4/4", "123/4", " 4/4", "a/b", ""].some(isMeter)).toBe(false);
    expect(isMeter(4)).toBe(false);
  });

  it("reads a format's meter leniently, one problem for a bad one", () => {
    const problems: string[] = [];
    const r = new LenientReader(problems);
    expect(parseMeter("6/8", "t.meter", r)).toBe("6/8");
    expect(parseMeter(undefined, "t.meter", r)).toBe(DEFAULT_METER);
    expect(problems).toEqual([]);
    expect(parseMeter("0/4", "t.meter", r)).toBe("4/4");
    expect(parseMeter(3, "t.meter", r)).toBe("4/4");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("t.meter");
  });

  it("splits a meter into beats per bar and beat unit, 4/4 for anything else", () => {
    expect(meterParts("7/8")).toEqual({ beatsPerBar: 7, beatUnit: 8 });
    expect(meterParts("3/4")).toEqual({ beatsPerBar: 3, beatUnit: 4 });
    for (const bad of [undefined, null, "", "x/4", "0/4", "4/0", "3.5/4", "4", "4/4/4"]) expect(meterParts(bad)).toEqual({ beatsPerBar: 4, beatUnit: 4 });
  });
});
