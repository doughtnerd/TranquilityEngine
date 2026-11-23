import { describe, expect, it } from "vitest";
import { localisedParts, variantPath } from "./variants";

const files = new Set([
  "audio/vo/en/ch1/intro_01.wav",
  "audio/vo/fr/ch1/intro_01.wav",
  "audio/vo/en/ch1/intro_02.wav",
  "audio/vo/en/grunt_03.wav",
  "audio/vo/fr/grunt_03.wav",
  "audio/vo/radio/en/static.wav",
  "audio/vo/radio/de/static.wav",
  "images/loc/en/logo.png",
]);
const exists = (p: string) => files.has(p);
const roots = ["audio/vo", "audio/vo/radio/", "images/loc"];

describe("localisedParts", () => {
  it("splits a path under the longest root into root, language folder and rest", () => {
    expect(localisedParts("audio/vo/en/ch1/intro_01.wav", roots)).toEqual({ root: "audio/vo", code: "en", rest: "ch1/intro_01.wav" });
    expect(localisedParts("audio/vo/radio/en/static.wav", roots)).toEqual({ root: "audio/vo/radio", code: "en", rest: "static.wav" });
  });
  it("is null outside every root, directly in a root, or on a partial segment match", () => {
    expect(localisedParts("audio/sfx/door.wav", roots)).toBeNull();
    expect(localisedParts("audio/vo/readme.txt", roots)).toBeNull();
    expect(localisedParts("audio/voices/en/x.wav", roots)).toBeNull();
    expect(localisedParts("audio/vo/en/", roots)).toBeNull();
  });
});

describe("variantPath", () => {
  it("returns a path outside every root unchanged, with no language", () => {
    expect(variantPath("audio/sfx/door.wav", ["fr", "en"], roots, exists)).toEqual({ path: "audio/sfx/door.wav", language: null });
  });

  it("swaps the language through the chain, first that exists", () => {
    expect(variantPath("audio/vo/en/ch1/intro_01.wav", ["fr", "en"], roots, exists)).toEqual({ path: "audio/vo/fr/ch1/intro_01.wav", language: "fr" });
    expect(variantPath("audio/vo/en/ch1/intro_02.wav", ["fr-CA", "fr", "en"], roots, exists)).toEqual({ path: "audio/vo/en/ch1/intro_02.wav", language: "en" });
    expect(variantPath("audio/vo/radio/en/static.wav", ["de", "en"], roots, exists)).toEqual({ path: "audio/vo/radio/de/static.wav", language: "de" });
  });

  it("treats a reference into another language's folder the same", () => {
    expect(variantPath("audio/vo/fr/grunt_03.wav", ["en"], roots, exists)).toEqual({ path: "audio/vo/en/grunt_03.wav", language: "en" });
  });

  it("is null when no language of the chain has the file (missing)", () => {
    expect(variantPath("audio/vo/en/ch1/intro_02.wav", ["de", "fr"], roots, exists)).toBeNull();
    expect(variantPath("images/loc/en/logo.png", ["ja"], roots, exists)).toBeNull();
  });

  it("works for asset roots too (0356 §10)", () => {
    expect(variantPath("images/loc/en/logo.png", ["ja", "en"], roots, exists)).toEqual({ path: "images/loc/en/logo.png", language: "en" });
  });
});
