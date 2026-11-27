import { describe, expect, it } from "vitest";
import { decodeMappings, generatedPosition, originalPosition } from "./sourceMaps";

describe("reading a source map back", () => {
  // Line 1 ends with a one-field segment (no original position); line 3's original column is 2 + 16 ("gB").
  const mappings = decodeMappings("AAAA;AACA,EAAE,C;;AAAgB");

  it("decodes segments per generated line, relative fields summed", () => {
    expect(mappings).toEqual([[[0, 0, 0]], [[0, 1, 0], [2, 1, 2]], [], [[0, 1, 18]]]);
  });

  it("finds the segment at or before a column, or none", () => {
    expect(originalPosition(mappings, 1, 1)).toEqual({ line: 1, column: 0 });
    expect(originalPosition(mappings, 1, 9)).toEqual({ line: 1, column: 2 });
    expect(originalPosition(mappings, 2, 0)).toBeNull();
    expect(originalPosition(mappings, 9, 0)).toBeNull();
  });

  it("finds the generated position of an original one from the closest segment at or before it on its line, or none", () => {
    expect(generatedPosition(mappings, 0, 0)).toEqual({ line: 0, column: 0 });
    expect(generatedPosition(mappings, 1, 1)).toEqual({ line: 1, column: 1 });
    expect(generatedPosition(mappings, 1, 5)).toEqual({ line: 1, column: 5 });
    expect(generatedPosition(mappings, 1, 20)).toEqual({ line: 3, column: 2 });
    expect(generatedPosition(mappings, 2, 0)).toBeNull();
  });

  it("refuses characters that aren't base64", () => {
    expect(() => decodeMappings("A!AA")).toThrow(/Bad source map/);
  });
});
