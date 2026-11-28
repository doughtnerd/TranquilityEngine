// What compiled clips are named by (T19): the content key is stable (same inputs, same key, on any machine; a golden
// value pins the hash rule) and changes with each input; build paths sit beside the source; the settings record has
// `anim-editor-wasm`'s layout.
import { describe, expect, it } from "vitest";
import {
  clipContentKey, CLIP_COMPILER_VERSION, clipRefKind, compiledClipPath, compiledSkeletonPath, compressionRecord, isClipSource, keyOfCacheFile, modelClipOf, modelSkeletonOf,
} from "./keys";
import { BUILTIN_COMPRESSION } from "./settings";

const inputs = () => ({ raw: Uint8Array.from([1, 2, 3, 4]), skeleton: Uint8Array.from([5, 6]), record: Float32Array.from([1e-4, 1e-4, 0, 32, 0, -1, 0, 0]) });

describe("content keys", () => {
  it("are stable: the same inputs give the same 20-hex key (golden value)", async () => {
    const a = await clipContentKey(inputs());
    expect(a).toMatch(/^[0-9a-f]{20}$/);
    expect(await clipContentKey(inputs())).toBe(a);
    expect(CLIP_COMPILER_VERSION).toBe(1);
    // SHA-256 over the length-prefixed parts, computed independently (Python hashlib) for these inputs.
    expect(a).toBe("36c62baeb8081a6ef607");
  });

  it("change with the raw clip, the skeleton and the settings", async () => {
    const base = await clipContentKey(inputs());
    expect(await clipContentKey({ ...inputs(), raw: Uint8Array.from([1, 2, 3, 5]) })).not.toBe(base);
    expect(await clipContentKey({ ...inputs(), skeleton: new Uint8Array(0) })).not.toBe(base);
    expect(await clipContentKey({ ...inputs(), record: Float32Array.from([2e-4, 1e-4, 0, 32, 0, -1, 0, 0]) })).not.toBe(base);
    // Parts are length-prefixed: moving a byte from one part to the next changes the key.
    expect(await clipContentKey({ ...inputs(), raw: Uint8Array.from([1, 2, 3]), skeleton: Uint8Array.from([4, 5, 6]) })).not.toBe(base);
  });

  it("name cache files", () => {
    expect(keyOfCacheFile("0123456789abcdef0123.anim.bin")).toBe("0123456789abcdef0123");
    expect(keyOfCacheFile("0123456789abcdef0123.report.json")).toBe("0123456789abcdef0123");
    expect(keyOfCacheFile("index.json")).toBeNull();
    expect(keyOfCacheFile("0123.anim.bin")).toBeNull();
  });
});

describe("references and build paths", () => {
  it("tell clip sources and model sub-assets apart", () => {
    expect(isClipSource("asset:clips/walk.anim.json")).toBe(true);
    expect(isClipSource("models/hero.glb#Anim/Run")).toBe(true);
    expect(isClipSource("clips/walk.anim.bin")).toBe(false);
    expect(isClipSource("models/hero.glb#Skeleton")).toBe(false);
    expect(modelClipOf("asset:models/hero.glb#Anim/Run Fast")).toEqual({ model: "models/hero.glb", name: "Run Fast" });
    expect(modelClipOf("models/hero.glb#Anim/")).toBeNull();
    expect(modelSkeletonOf("asset:models/hero.glb#Skeleton")).toBe("models/hero.glb");
    expect(modelSkeletonOf("rigs/hero.skel")).toBeNull();
  });

  it("classify clip references in any letter case (ADR 0460)", () => {
    expect(clipRefKind("asset:./clips/Walk.Anim.JSON")).toBe("source");
    expect(clipRefKind("tl/Intro.TIMELINE.json")).toBe("timeline");
    expect(clipRefKind("clips/walk.ANIM.BIN")).toBe("compiled");
    expect(clipRefKind("models/hero.glb#Anim/Run")).toBe("model");
    expect(clipRefKind("models/hero.glb#Skeleton")).toBeNull();
    expect(clipRefKind("images/a.png")).toBeNull();
  });

  it("put compiled files beside their source", () => {
    expect(compiledClipPath("asset:clips/walk.anim.json", null)).toBe("clips/walk.anim.bin");
    expect(compiledClipPath("models/hero.glb#Anim/Run", null)).toBe("models/hero.glb.anim/Run.anim.bin");
    expect(compiledClipPath("models/hero.glb#Anim/a.b/c", "x")).toBe("models/hero.glb.anim/a%2Eb%2Fc.anim.bin");
    expect(compiledSkeletonPath("asset:models/hero.glb#Skeleton")).toBe("models/hero.glb.anim/Skeleton.skel.bin");
    expect(compiledSkeletonPath("rigs/hero.skel")).toBeNull();
  });

  it("tag an authored clip with the skeleton it binds, the same for any spelling of the reference", () => {
    const a = compiledClipPath("clips/wave.anim.json", "asset:models/hero.glb#Skeleton");
    expect(a).toMatch(/^clips\/wave\.[0-9a-f]{8}\.anim\.bin$/);
    expect(compiledClipPath("clips/wave.anim.json", "models/hero.glb#Skeleton")).toBe(a);
    expect(compiledClipPath("clips/wave.anim.json", "models/other.glb#Skeleton")).not.toBe(a);
  });
});

describe("the settings record", () => {
  it("has anim-editor-wasm's layout: metres, a resample rate only for faster clips, the root bone with its axes", () => {
    expect([...compressionRecord(BUILTIN_COMPRESSION, 30, -1, 0)]).toEqual([Math.fround(1e-4), Math.fround(1e-4), 0, 32, 0, -1, 0, 0]);
    expect(compressionRecord({ ...BUILTIN_COMPRESSION, maxRate: 15 }, 30, 0, 9)[2]).toBe(15);
    expect(compressionRecord({ ...BUILTIN_COMPRESSION, maxRate: 60 }, 30, 0, 9)[2]).toBe(0);
    expect([...compressionRecord(BUILTIN_COMPRESSION, 30, 2, 13).subarray(5, 7)]).toEqual([2, 13]);
    expect(compressionRecord(BUILTIN_COMPRESSION, 30, 2, 0)[5]).toBe(-1); // no axes: no root curve
  });
});
