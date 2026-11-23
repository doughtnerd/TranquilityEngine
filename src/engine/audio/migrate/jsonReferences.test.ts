/** `rewriteJsonReferences` and `movedReference`: reference strings move, everything else stays byte for byte. */
import { describe, expect, it } from "vitest";
import { movedReference, rewriteJsonReferences } from "./jsonReferences";

const MOVES = new Map([["a/x.audioevent.json", "a/x.playlist.json"], ["sheet.png", "img/sheet.png"]]);

describe("movedReference", () => {
  it("keeps the prefix and slice and moves the path", () => {
    expect(movedReference("a/x.audioevent.json", MOVES)).toBe("a/x.playlist.json");
    expect(movedReference("asset:a/x.audioevent.json", MOVES)).toBe("asset:a/x.playlist.json");
    expect(movedReference("asset:./sheet.png#walk_0", MOVES)).toBe("asset:./img/sheet.png#walk_0");
    expect(movedReference("/sheet.png", MOVES)).toBe("/img/sheet.png");
  });

  it("gives null for other paths, longer paths and folders", () => {
    expect(movedReference("b/x.audioevent.json", MOVES)).toBeNull();
    expect(movedReference("a/x.audioevent.json.bak", MOVES)).toBeNull();
    expect(movedReference("a", MOVES)).toBeNull();
  });
});

describe("rewriteJsonReferences", () => {
  it("rewrites values only, keeping layout, keys and escapes", () => {
    const text = '{\n  "clip" :  "asset:a/x.audioevent.json",\n  "a/x.audioevent.json": ["sheet.png#idle", "say \\"hi\\""],\n\t"n": 1\n}';
    expect(rewriteJsonReferences(text, MOVES)).toBe('{\n  "clip" :  "asset:a/x.playlist.json",\n  "a/x.audioevent.json": ["img/sheet.png#idle", "say \\"hi\\""],\n\t"n": 1\n}');
  });

  it("reads escaped strings as their value", () => {
    expect(rewriteJsonReferences('["a\\/x.audioevent.json"]', MOVES)).toBe('["a/x.playlist.json"]');
  });

  it("gives null when nothing changes, for no moves and for text that isn't JSON", () => {
    expect(rewriteJsonReferences('{"clip": "b.wav"}', MOVES)).toBeNull();
    expect(rewriteJsonReferences('{"clip": "a/x.audioevent.json"}', new Map())).toBeNull();
    expect(rewriteJsonReferences('{"clip": "a/x.audioevent.json"', MOVES)).toBeNull();
  });
});
