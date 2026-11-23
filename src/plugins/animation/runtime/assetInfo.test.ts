// The host's readers of animation files (ADR 0371; T17), on the committed fixtures that anim-format and anim-compress
// wrote (`wasm/fixtures/`, see native/anim/crates/anim-wasm/tests/fixtures.rs): the skeleton's bones, rest pose and bind
// matrices, a clip's header and root curve, and leniency on bytes that aren't such files.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { multiply34 } from "./affine";
import { readClipInfo, readSkeletonInfo } from "./assetInfo";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./wasm/fixtures/${name}`, import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("./wasm/fixtures/expected.json", import.meta.url), "utf8")) as { bones: number };

describe("readSkeletonInfo", () => {
  it("reads bones, parents first, with names, rest pose and bind matrices", () => {
    const s = readSkeletonInfo(fixture("small.skel"))!;
    expect(s.bones).toBe(expected.bones);
    expect(s.names).toHaveLength(s.bones);
    expect(s.parents[0]).toBe(-1);
    for (let b = 1; b < s.bones; b++) expect(s.parents[b]).toBeLessThan(b);
    for (const [i, name] of s.names.entries()) if (name) expect(s.indexOf(name)).toBe(i);
    expect(s.indexOf("no such bone")).toBe(-1);
    // The fixture's inverse bind matrices invert its rest pose's model space (f32 file, f64 reference): so bind ≈ rest
    // model, and inverse bind × bind ≈ identity. Tolerance 1e-5: a few f32 ulps over the short chain.
    const product = new Float64Array(12);
    for (let b = 0; b < s.bones; b++) {
      for (let k = 0; k < 12; k++) expect(Math.abs(s.bind[b * 12 + k]! - s.restModel[b * 12 + k]!)).toBeLessThan(1e-5);
      multiply34(product, 0, s.inverseBind, b * 12, s.bind, b * 12);
      expect([...product].map((v) => Math.round(v * 1e5) / 1e5 + 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    }
    expect(s.radius).toBeGreaterThan(0);
  });

  it("answers null for bytes that aren't a skeleton", () => {
    expect(readSkeletonInfo(new Uint8Array(4))).toBeNull();
    expect(readSkeletonInfo(fixture("walk.anim"))).toBeNull();
    const cut = fixture("small.skel").slice(0, 64);
    expect(readSkeletonInfo(cut)).toBeNull();
  });
});

describe("readClipInfo", () => {
  it("reads the header and the root curve (frame 0 at the origin)", () => {
    const c = readClipInfo(fixture("walk.anim"))!;
    expect(c.duration).toBeCloseTo(2, 5);
    expect(c.sampleRate).toBe(30);
    expect(c.looping).toBe(true);
    expect(c.additive).toBe(false);
    expect(c.rootBone).toBe(0);
    expect(c.rootCurve).not.toBeNull();
    expect(c.rootCurve!.length).toBe(c.frameCount * 4);
    expect([...c.rootCurve!.subarray(0, 3)]).toEqual([0, 0, 0]);
  });

  it("answers null for bytes that aren't a clip", () => {
    expect(readClipInfo(fixture("small.skel"))).toBeNull();
    expect(readClipInfo(new Uint8Array(100))).toBeNull();
  });
});
