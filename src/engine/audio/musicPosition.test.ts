/**
 * Musical position grammar (`api-and-models.md` §2.2, L-F1ab): parse, format, canonical text, ordering and snaps.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalPosition,
  comparePositions,
  formatPosition,
  parsePosition,
  positionProblem,
  snapToBeat,
  snapToNextBar,
  type BarBeatTick,
  type MusicPosition,
} from "./musicPosition";

const words = { start: true, end: true } as const;

describe("parsePosition", () => {
  it.each<[string, BarBeatTick]>([
    ["1:1:0", { bar: 1, beat: 1, tick: 0 }],
    ["1:1:959", { bar: 1, beat: 1, tick: 959 }],
    ["3:3:480", { bar: 3, beat: 3, tick: 480 }],
    ["99999:32:959", { bar: 99999, beat: 32, tick: 959 }],
    ["01:1:000", { bar: 1, beat: 1, tick: 0 }],
    ["0001:0002:0010", { bar: 1, beat: 2, tick: 10 }],
  ])("accepts %j as %j", (raw, expected) => {
    expect(parsePosition(raw)).toEqual(expected);
  });

  it.each([
    "0:1:0", // bar 0
    "100000:1:0", // bar past 99999
    "1:0:0", // beat 0
    "1:33:0", // beat past 32
    "1:1:960", // tick past 959
    "-1:1:0", // sign
    "+1:1:0", // sign
    "1: 1:0", // space
    "1:1:0 ", // trailing space
    " 1:1:0", // leading space
    "1.5:1:0", // fraction
    "1:1.0:0", // fraction
    "1:1:0.5", // fraction
    "1:1", // two parts
    "1:1:0:0", // four parts
    "1::0", // empty beat
    "", // empty
    "a:1:0", // not digits
    "start", // word without allow
    "end", // word without allow
    "START", // word case
  ])("rejects %j", (raw) => {
    expect(parsePosition(raw)).toBeNull();
  });

  it("parses the words only when allow names them", () => {
    expect(parsePosition("start", { start: true })).toBe("start");
    expect(parsePosition("end", { end: true })).toBe("end");
    expect(parsePosition("start", { end: true })).toBeNull();
    expect(parsePosition("end", { start: true })).toBeNull();
    expect(parsePosition("end", words)).toBe("end");
  });

  it("returns null for non-string input", () => {
    const inputs: unknown[] = [null, undefined, 0, 1, 1.5, true, {}, [], ["1:1:0"], { bar: 1, beat: 1, tick: 0 }];
    for (const raw of inputs) {
      expect(parsePosition(raw)).toBeNull();
      expect(parsePosition(raw, words)).toBeNull();
      expect(positionProblem(raw)).toContain('"bar:beat:tick"');
    }
  });
});

describe("positionProblem", () => {
  it("is null for every valid position", () => {
    expect(positionProblem("1:1:0")).toBeNull();
    expect(positionProblem("99999:32:959")).toBeNull();
    expect(positionProblem("end", words)).toBeNull();
    expect(positionProblem("start", words)).toBeNull();
  });

  it("names the failing part", () => {
    expect(positionProblem("1:1:960")).toContain("tick 960 is past 959");
    expect(positionProblem("0:1:0")).toContain("bar 0 is below 1");
    expect(positionProblem("100000:1:0")).toContain("bar 100000 is past 99999");
    expect(positionProblem("1:0:0")).toContain("beat 0 is below 1");
    expect(positionProblem("1:33:0")).toContain("beat 33 is past 32");
    expect(positionProblem("1:x:0")).toContain('beat "x" is not a whole number');
    expect(positionProblem("1:1:0 ")).toContain('tick "0 " is not a whole number');
  });

  it("states the shape and mentions the allowed words", () => {
    const plain = positionProblem("1:1");
    expect(plain).toContain('"bar:beat:tick"');
    expect(plain).not.toContain('"end"');
    expect(positionProblem("1:1", { end: true })).toContain('"end"');
    expect(positionProblem("1:1", words)).toContain('"start" or "end"');
  });

  it("says a word is not allowed where it is not", () => {
    const problem = positionProblem("end");
    expect(problem).toContain('"end" is not allowed here');
    expect(problem).toContain('"bar:beat:tick"');
  });

  it("is non-null exactly when parsePosition is null", () => {
    const cases: unknown[] = ["1:1:0", "1:1:960", "end", "end ", 3, null, "1:1:0 ", "01:1:0", "start"];
    for (const raw of cases) {
      for (const allow of [undefined, words]) {
        expect(positionProblem(raw, allow) === null).toBe(parsePosition(raw, allow) !== null);
      }
    }
  });
});

describe("formatPosition and canonicalPosition", () => {
  it("formats canonically, with no leading zeros", () => {
    expect(formatPosition({ bar: 1, beat: 1, tick: 0 })).toBe("1:1:0");
    expect(formatPosition({ bar: 12, beat: 3, tick: 480 })).toBe("12:3:480");
    expect(formatPosition("end")).toBe("end");
    expect(formatPosition("start")).toBe("start");
  });

  it("round-trips parse(format(p))", () => {
    const samples: MusicPosition[] = [
      { bar: 1, beat: 1, tick: 0 },
      { bar: 99999, beat: 32, tick: 959 },
      { bar: 7, beat: 4, tick: 1 },
      "start",
      "end",
    ];
    for (const p of samples) {
      expect(parsePosition(formatPosition(p), words)).toEqual(p);
    }
  });

  it("canonicalPosition drops leading zeros and returns null for invalid input", () => {
    expect(canonicalPosition("01:01:000")).toBe("1:1:0");
    expect(canonicalPosition("end", words)).toBe("end");
    expect(canonicalPosition("end")).toBeNull();
    expect(canonicalPosition("1:1")).toBeNull();
    expect(canonicalPosition(42)).toBeNull();
  });
});

describe("comparePositions", () => {
  const at = (bar: number, beat: number, tick: number): BarBeatTick => ({ bar, beat, tick });

  it("orders by bar, then beat, then tick", () => {
    expect(comparePositions(at(1, 1, 0), at(1, 1, 0))).toBe(0);
    expect(comparePositions(at(1, 1, 0), at(1, 1, 1))).toBeLessThan(0);
    expect(comparePositions(at(1, 2, 0), at(1, 1, 959))).toBeGreaterThan(0);
    expect(comparePositions(at(2, 1, 0), at(1, 4, 959))).toBeGreaterThan(0);
    expect(comparePositions(at(9, 3, 5), at(10, 1, 0))).toBeLessThan(0);
  });

  it("sorts a list into musical order", () => {
    const list = [at(3, 1, 0), at(1, 2, 0), at(1, 1, 960 - 1), at(2, 4, 10), at(1, 1, 0)];
    const sorted = [...list].sort(comparePositions).map(formatPosition);
    expect(sorted).toEqual(["1:1:0", "1:1:959", "1:2:0", "2:4:10", "3:1:0"]);
  });
});

describe("snapToBeat", () => {
  it("sets the tick to 0 and keeps bar and beat", () => {
    expect(snapToBeat(at(4, 2, 719))).toEqual({ bar: 4, beat: 2, tick: 0 });
    expect(snapToBeat(at(4, 2, 0))).toEqual({ bar: 4, beat: 2, tick: 0 });
  });
});

describe("snapToNextBar", () => {
  it("returns the next bar's beat 1 tick 0 for any other position", () => {
    expect(snapToNextBar(at(4, 1, 1))).toEqual({ bar: 5, beat: 1, tick: 0 });
    expect(snapToNextBar(at(4, 3, 0))).toEqual({ bar: 5, beat: 1, tick: 0 });
    expect(snapToNextBar(at(4, 1, 959))).toEqual({ bar: 5, beat: 1, tick: 0 });
  });

  it("returns a position already at 1:0 of a bar unchanged", () => {
    const p = at(4, 1, 0);
    expect(snapToNextBar(p)).toBe(p);
  });
});

function at(bar: number, beat: number, tick: number): BarBeatTick {
  return { bar, beat, tick };
}
