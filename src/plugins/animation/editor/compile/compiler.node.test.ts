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
import { evalCurve, type Curve } from "../../../../engine/core/curve";
import { CLIP_COMPILER_VERSION, compressionRecord } from "../../../../engine/animation/compile/keys";
import { compileRawClip } from "../../../../engine/animation/compile/rawClip";
import { BUILTIN_COMPRESSION } from "../../../../engine/animation/compile/settings";
import { readSkeletonInfo } from "../../runtime/assetInfo";
import { loadAnimationCore } from "../../runtime/core/loader";
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

describe("the compile module's curve sampling (T70c)", () => {
  // The compile step samples source curves with the module's `curve_sample`; the runtime samples with the core's `curve_sample`.
  // Both link the one evaluator, so the compiled clip holds the runtime's own numbers: bit for bit. Against the TypeScript
  // evaluator they differ by f32 rounding only (the parity bound of `native/common/curve`, 1e-6; these curves span 0..2).
  const WAVE: Curve = [[0, 0], [0.5, 1, "smooth"], [1, -0.25, "bezier", { in: [-0.2, 0.3], out: [0.3, 0.5] }], [1.5, 2, "easeIn"], [1.9, 0.5, "step"], [2, 1]];
  const RATE = 30, DURATION = 2, FRAMES = RATE * DURATION + 1;

  it("samples a curve as the runtime core does, and as evalCurve does within the f32 bound", async () => {
    const load = await loadAnimationCore();
    if (load.status !== "ready") throw new Error("no simd128 in this Node");
    const got = compiler.sampleCurve(WAVE, RATE, DURATION, FRAMES);
    expect(got).toHaveLength(FRAMES);
    expect(Array.from(got)).toEqual(Array.from(load.core.curveSamples(WAVE, RATE, DURATION, FRAMES)));
    for (let i = 0; i < FRAMES; i++) expect(Math.abs(got[i]! - evalCurve(WAVE, Math.min(i / RATE, DURATION))), `frame ${i}`).toBeLessThanOrEqual(1e-6);
  });

  it("samples an empty curve, and one the module refuses, as zeros", () => {
    expect(Array.from(compiler.sampleCurve([], RATE, DURATION, 3))).toEqual([0, 0, 0]);
    expect(Array.from(compiler.sampleCurve([[1, 1], [0, 0]], RATE, DURATION, 3))).toEqual([0, 0, 0]);
  });

  it("compiles a clip's curve track to the same raw samples as before, within the bound", () => {
    const source: AnimSource = {
      ...emptyAnimSource(), name: "Fade", rate: RATE, duration: DURATION,
      tracks: [{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [WAVE] }],
    };
    const bytes = compileRawClip(source, null, "", compiler.sampleCurve).bytes;
    const h = readAnimationHeader(bytes, "myco.anim@1");
    if (!h.ok) throw new Error(h.problem);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const track = h.header.sections.find((s) => s.kind === 3)!;
    const rawSection = h.header.sections.find((s) => s.kind === 5)!;
    const first = view.getUint32(track.offset + 20, true);
    expect(track.count).toBe(1);
    for (let i = 0; i < FRAMES; i++) {
      const v = view.getFloat32(rawSection.offset + 4 * (first + i), true);
      expect(Math.abs(v - evalCurve(WAVE, Math.min(i / RATE, DURATION))), `frame ${i}`).toBeLessThanOrEqual(1e-6);
    }
  });
});

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
