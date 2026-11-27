import { describe, expect, it } from "vitest";
import { envelopePoints, formatSeconds, impulseDuration, impulsePresetOf, noiseSummary } from "./shakeSectionLogic";

describe("camera shake Inspector section logic", () => {
  it("reads only known presets", () => {
    expect(impulsePresetOf("explosion")).toBe("explosion");
    expect(impulsePresetOf("boom")).toBeNull();
    expect(impulsePresetOf(3)).toBeNull();
  });

  it("uses the source's duration when above 0, else the preset's", () => {
    expect(impulseDuration("bump", 0)).toBe(0.3);
    expect(impulseDuration("rumble", -1)).toBe(2);
    expect(impulseDuration("bump", 1.25)).toBe(1.25);
    expect(formatSeconds(0.3)).toBe("0.3 s");
    expect(formatSeconds(2)).toBe("2 s");
  });

  it("samples the envelope from the bottom-left, peaking at the top", () => {
    const pts = envelopePoints("bump", 100, 10, 21).split(" ").map((p) => p.split(",").map(Number));
    expect(pts).toHaveLength(21);
    expect(pts[0]).toEqual([0, 10]); // strength 0 at the start
    expect(pts[20]).toEqual([100, 10]); // and at the end
    expect(Math.min(...pts.map((p) => p[1]!))).toBeLessThan(0.5); // reaches about 1 in between
  });

  it("summarises a noise profile, none for none", () => {
    expect(noiseSummary("none")).toBeNull();
    expect(noiseSummary("nonsense")).toBeNull();
    expect(noiseSummary("handheld")).toBe("2 octaves, 0.3–1.1 Hz, turns up to 0.8°");
    expect(noiseSummary("handheldWild")).toBe("3 octaves, 0.6–6 Hz, turns up to 2.5°");
  });
});
