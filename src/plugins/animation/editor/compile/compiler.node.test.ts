// T19 (ADR 0370, 0371, D79): the editor's compile module (`anim-editor-wasm`) in Node, beside the runtime core. It
// compresses an authored clip's raw form (`compileRawClip`) into a clip the runtime core accepts, and the compressed
// clip plays within the compressor's reported error of the raw one: both play in a headless Engine through the public
// API, and each bone's virtual vertices (ACL's metric, decision D21: `(d,0,0)`, `(0,d,0)`, `(0,0,d)` in bone space at the
// shell distance `d = max(3 cm, longest child offset)`) are compared after the skinning matrices (`skinningMatrices`,
// what T16 reads) carry them. Tolerance: the report's maximum error plus 2e-5 m, because the compressor measures in f64
// at the frames while the core evaluates in f32 (simd) at the playhead the Engine's clock gives (frames 1/30 s apart
// accumulate f32 rounding). The module's version and hash are checked against the TypeScript key and its hash.json.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { emptyAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { readAnimationHeader, type ClipInfo } from "../../../../engine/animation/binaryHeader";
import { CLIP_COMPILER_VERSION, compressionRecord } from "../../../../engine/animation/compile/keys";
import { compileRawClip } from "../../../../engine/animation/compile/rawClip";
import { BUILTIN_COMPRESSION } from "../../../../engine/animation/compile/settings";
import { readSkeletonInfo } from "../../runtime/assetInfo";
import { instanceForSkeleton, skinningMatrices } from "../../runtime/skeletonInstances";
import { loadAnimationCompiler, type AnimationCompiler, type ClipReport } from "./compiler";

const fixtureUrl = (name: string) => new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(fixtureUrl(name)));
const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
const json = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as { sourceHash: string; bytes: Record<string, number> };
const dt = 1 / 30;

const SKEL_BYTES = fixture("small.skel");
const skeleton = readSkeletonInfo(SKEL_BYTES)!;

/** 1.2 s at 30 Hz: bones 1–6 swing about two axes and bone 1 travels, with a tempo no frame grid matches exactly. */
function swing(): AnimSource {
  const keys = (b: number) => Array.from({ length: 7 }, (_, i) => {
    const t = i * 0.2;
    const a = 0.3 * Math.sin(2.1 * t + b), c = 0.2 * Math.cos(1.3 * t - b);
    const n = Math.hypot(Math.sin(a), Math.sin(c), 1);
    return [t, Math.sin(a) / n, Math.sin(c) / n, 0, 1 / n] as const;
  });
  const tracks = [1, 2, 3, 4, 5, 6].map((b) => ({
    kind: "bone" as const, bone: `bone${b}`, scale: [],
    rotation: keys(b),
    translation: b === 1 ? Array.from({ length: 7 }, (_, i) => [i * 0.2, 0.05 * Math.sin(3 * i * 0.2), 0, 0] as const) : [],
  }));
  return { ...emptyAnimSource(), name: "Swing", duration: 1.2, loop: true, tracks };
}

let compiler: AnimationCompiler;
let engine: Engine;
let world: World;
let raw: Uint8Array;
let compressed: Uint8Array;
let report: ClipReport;

beforeAll(async () => {
  compiler = await loadAnimationCompiler();
  raw = compileRawClip(swing(), skeleton).bytes;
  const out = compiler.compressClip(raw, SKEL_BYTES, compressionRecord(BUILTIN_COMPRESSION, 30, -1, 0));
  if (!out.ok) throw new Error(out.error);
  compressed = out.bytes;
  report = out.report;
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "anim/small.skel": fixtureUrl("small.skel").href, "anim/raw.anim": dataUrl(raw), "anim/compressed.anim": dataUrl(compressed) }));
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

describe("the editor's compile module", () => {
  it("is the version the content keys hash, built from the sources its hash.json names", () => {
    expect(compiler.version).toBe(CLIP_COMPILER_VERSION);
    const editor = json(new URL("../../runtime/wasm/editor/hash.json", import.meta.url));
    expect(compiler.sourceHash).toBe(editor.sourceHash);
    expect(editor.bytes["myco_anim_editor_bg.wasm"]).toBe(readFileSync(new URL("../../runtime/wasm/editor/myco_anim_editor_bg.wasm", import.meta.url)).length);
    // Both modules come from one source tree (build.mjs builds them together).
    expect(json(new URL("../../runtime/wasm/hash.json", import.meta.url)).sourceHash).toBe(editor.sourceHash);
  });

  it("compresses a raw clip within the default bound, deterministically, with its report", () => {
    const h = readAnimationHeader(compressed, "myco.anim@1");
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.header.info).toMatchObject({ compressed: true, raw: false, bones: skeleton.bones, frames: 37 } satisfies Partial<ClipInfo>);
    expect(report).toMatchObject({ withinBounds: true, fileSize: compressed.length });
    expect(report.maxError).toBeLessThanOrEqual(1e-4);
    expect(report.compressedSize).toBeLessThan(report.rawSize);
    const again = compiler.compressClip(raw, SKEL_BYTES, compressionRecord(BUILTIN_COMPRESSION, 30, -1, 0));
    expect(again.ok && again.bytes).toEqual(compressed);
    const loose = compiler.compressClip(raw, SKEL_BYTES, compressionRecord({ ...BUILTIN_COMPRESSION, error: 5 }, 30, -1, 0));
    expect(loose.ok && loose.bytes.length).toBeLessThan(compressed.length);
  });

  it("says why a compile fails", () => {
    const out = compiler.compressClip(raw, new Uint8Array(0), compressionRecord(BUILTIN_COMPRESSION, 30, -1, 0));
    expect(out).toEqual({ ok: false, error: expect.stringContaining("skeleton") });
    expect(compiler.compileSkeleton(new Uint8Array(4))).toEqual({ error: expect.stringContaining("skeleton") });
    expect(compiler.compileSkeleton(SKEL_BYTES)).toEqual({ bytes: SKEL_BYTES });
  });

  it("makes a clip the runtime plays within the reported error of the raw form", async () => {
    const heroes = ["raw", "compressed"].map((name) => {
      const node = GameObject.create(name);
      node.addComponent(Skeleton, { skeleton: "anim/small.skel" });
      return { node, anim: node.addComponent(Animator) };
    });
    await vi.waitFor(() => heroes.forEach((h) => expect(instanceForSkeleton(world, h.node)).not.toBe(0)));
    heroes[0].anim.play("anim/raw.anim");
    heroes[1].anim.play("anim/compressed.anim");
    await vi.waitFor(() => {
      engine.step(0);
      heroes.forEach((h, i) => expect(h.anim.state().name).toBe(i ? "anim/compressed.anim" : "anim/raw.anim"));
    });
    // Shell distances (D21) from the rest pose.
    const shell = new Float64Array(skeleton.bones).fill(0.03);
    for (let b = 1; b < skeleton.bones; b++) {
      const p = skeleton.parents[b];
      if (p >= 0) shell[p] = Math.max(shell[p], Math.hypot(skeleton.rest[b * 10], skeleton.rest[b * 10 + 1], skeleton.rest[b * 10 + 2]));
    }
    const apply = (m: ArrayLike<number>, o: number, x: number, y: number, z: number) => [0, 1, 2].map((r) => m[o + r * 4] * x + m[o + r * 4 + 1] * y + m[o + r * 4 + 2] * z + m[o + r * 4 + 3]);
    let worst = 0;
    let moved = 0;
    for (let frame = 0; frame < 40; frame++) {
      engine.step(dt);
      const a = skinningMatrices(world, heroes[0].node)!, c = skinningMatrices(world, heroes[1].node)!;
      for (let b = 0; b < skeleton.bones; b++) {
        for (let k = 0; k < 3; k++) {
          const e = [0, 0, 0];
          e[k] = shell[b];
          const v = apply(skeleton.bind, b * 12, e[0], e[1], e[2]); // the virtual vertex at bind time
          const pa = apply(a, b * 12, v[0], v[1], v[2]), pc = apply(c, b * 12, v[0], v[1], v[2]);
          worst = Math.max(worst, Math.hypot(pa[0] - pc[0], pa[1] - pc[1], pa[2] - pc[2]));
          moved = Math.max(moved, Math.hypot(pa[0] - v[0], pa[1] - v[1], pa[2] - v[2]));
        }
      }
    }
    expect(moved).toBeGreaterThan(0.01); // it animates
    expect(worst).toBeGreaterThan(0); // two different clips
    expect(worst).toBeLessThanOrEqual(report.maxError + 2e-5);
    for (const h of heroes) GameObject.destroy(h.node);
    engine.step(0);
  });
});
