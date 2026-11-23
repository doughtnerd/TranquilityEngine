// The Studio kit's field models: label scrubbing (the owner's prototype rules), the number field's typed text and
// steps, the colour picker's colour maths and keys, and the waveform's mirrored envelope.
import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex, hueKey, readHex, removeColour, saveColour, svKey } from "./colourPickerModel";
import { numberText, parseNumber, stepNumber } from "./numberFieldModel";
import { SCRUB_TOOLTIP, formatTimecode, parseTimecode, scrubKind, scrubNumber, startTextScrub, textScrubValue } from "./scrubModel";
import { envelopeRuns } from "./waveformModel";

describe("label scrubbing", () => {
  it("moves one step per 2 px, ×10 with Shift, ×0.1 with Alt, within min..max", () => {
    expect(scrubNumber(10, 1, 1)).toBe(11); // 1 px rounds to half a step: one step (Math.round(0.5) = 1)
    expect(scrubNumber(10, 1, 20)).toBe(20);
    expect(scrubNumber(10, 1, -20)).toBe(0);
    expect(scrubNumber(10, 1, 20, { shift: true })).toBe(110);
    expect(scrubNumber(10, 1, 20, { alt: true })).toBe(11);
    expect(scrubNumber(0.5, 0.1, 6, { alt: true })).toBe(0.53); // a fine drag keeps one more decimal, no float noise
    expect(scrubNumber(10, 1, 400, {}, { min: 0, max: 100 })).toBe(100);
    expect(scrubNumber(10, 1, -400, {}, { min: 0, max: 100 })).toBe(0);
    expect(SCRUB_TOOLTIP).toBe("Drag left or right to change (Shift ×10, Alt fine)");
  });
  it("scrubs number inputs, plain decimals and timecodes, and nothing else", () => {
    expect(scrubKind("number", "")).toBe("number");
    expect(scrubKind("text", "1.25")).toBe("decimal");
    expect(scrubKind(null, "00:01.250")).toBe("timecode");
    expect(scrubKind("text", "Engine")).toBeNull();
    expect(scrubKind("search", "12")).toBeNull();
    expect(scrubKind("range", "12")).toBeNull();
  });
  it("steps a field by its step attribute, its last decimal, or 10 ms of timecode", () => {
    const n = startTextScrub({ type: "number", value: "4", step: "0.5", min: "0", max: "6" })!;
    expect(textScrubValue(n, 4)).toBe("5.0");
    expect(textScrubValue(n, 40)).toBe("6.0"); // clamped to max
    const d = startTextScrub({ type: "text", value: "1.25" })!;
    expect(textScrubValue(d, 2)).toBe("1.26");
    expect(textScrubValue(d, 2, { alt: true })).toBe("1.251");
    const t = startTextScrub({ value: "00:59.995" })!;
    expect(textScrubValue(t, 2)).toBe("01:00.005");
    expect(textScrubValue(t, -100000)).toBe("00:00.000"); // never below zero
    expect(startTextScrub({ type: "text", value: "abc" })).toBeNull();
  });
  it("reads and writes timecodes with two-digit minutes", () => {
    expect(parseTimecode("01:02.500")).toBe(62.5);
    expect(parseTimecode("1:02")).toBeNull();
    expect(formatTimecode(62.5)).toBe("01:02.500");
    expect(formatTimecode(59.9996)).toBe("01:00.000");
  });
});

describe("number field", () => {
  it("reads typed numbers leniently, clamped to its range and decimals", () => {
    const r = { min: -60, max: 6, step: 0.5 };
    expect(parseNumber("−3", r)).toBe(-3);
    expect(parseNumber("1,5", r)).toBe(1.5);
    expect(parseNumber("12 dB", r)).toBe(6);
    expect(parseNumber("-100", r)).toBe(-60);
    expect(parseNumber("2.4k", { step: 1 })).toBe(2400);
    expect(parseNumber("loud", r)).toBeNull();
    expect(parseNumber("", r)).toBeNull();
  });
  it("steps with the arrows (Shift ×10, Alt ×0.1) and writes the value without trailing zeros", () => {
    expect(stepNumber(1, 1, {}, { step: 0.5 })).toBe(1.5);
    expect(stepNumber(1, -1, { shift: true }, { step: 0.5, min: -2 })).toBe(-2);
    expect(stepNumber(1, 1, { alt: true }, { step: 1 })).toBe(1.1);
    expect(numberText(2.5, { step: 0.5 })).toBe("2.5");
    expect(numberText(3, { step: 0.5 })).toBe("3");
    expect(numberText(1.23456, { digits: 2 })).toBe("1.23");
  });
});

describe("colour picker", () => {
  it("converts hex and HSV both ways and reads typed hex leniently", () => {
    expect(hsvToHex(hexToHsv("#6aa8ff"))).toBe("#6aa8ff");
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
    expect(readHex("ABC")).toBe("#aabbcc");
    expect(readHex(" #6AA8FF ")).toBe("#6aa8ff");
    expect(readHex("blue")).toBeNull();
  });
  it("moves the square and the hue strip with keys", () => {
    expect(svKey({ h: 0, s: 0.5, v: 0.5 }, "ArrowRight", false)).toEqual({ h: 0, s: 0.52, v: 0.5 });
    expect(svKey({ h: 0, s: 0.5, v: 0.95 }, "ArrowUp", true)).toEqual({ h: 0, s: 0.5, v: 1 });
    expect(svKey({ h: 0, s: 0.5, v: 0.5 }, "x", false)).toBeNull();
    expect(hueKey(358, "ArrowRight", false)).toBe(1);
    expect(hueKey(10, "ArrowLeft", true)).toBe(355);
    expect(hueKey(100, "End", false)).toBe(359);
    expect(hueKey(100, "PageUp", false)).toBe(130);
  });
  it("keeps one project palette without duplicates", () => {
    expect(saveColour(["#111111", "#222222"], "#111111")).toEqual(["#222222", "#111111"]);
    expect(removeColour(["#111111", "#222222"], "#111111")).toEqual(["#222222"]);
  });
});

describe("waveform envelope", () => {
  it("mirrors each column's larger excursion, split at gaps", () => {
    const cols = { min: new Float32Array([-0.5, -0.1, NaN, -0.9]), max: new Float32Array([0.2, 0.3, NaN, 1.5]) };
    const runs = envelopeRuns(cols);
    expect(runs.map((r) => r.x)).toEqual([0, 3]);
    expect(runs[0]!.amps.map((a) => Number(a.toFixed(2)))).toEqual([0.5, 0.3]);
    expect(runs[1]!.amps).toEqual([1]);
  });
});
