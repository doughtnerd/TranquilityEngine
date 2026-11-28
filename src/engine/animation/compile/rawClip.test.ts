// An authored clip's raw form (T19): a valid `myco.anim@1` container (checked by `readAnimationHeader`, which mirrors
// `container::parse`) whose header, tracks, samples and keys follow `anim-format`'s clip layout. The runtime core
// accepting and playing it is the Node tests' (`runtime/features/clipSources.node.test.ts`). Samples are compared at
// f32 precision (1e-6): they are the source's keys interpolated in f64 and stored as f32. Curve tracks are sampled by the
// caller's `CurveSampler` (the animation core's, T70): here the engine's evaluator stands in, so the layout is what is
// tested; the core's values are the plugin's tests' (`runtime/core/host.node.test.ts`, `editor/compile/compiler.node.test.ts`).
import { describe, expect, it } from "vitest";
import { emptyAnimSource, type AnimSource } from "../animSource";
import { readAnimationHeader, type ClipInfo } from "../binaryHeader";
import { evalCurve } from "../../core/curve";
import type { CurveSampler } from "./curveKeys";
import { compileRawClip, rootMotionAxes, usesBones, type ClipSkeleton } from "./rawClip";

const SKELETON: ClipSkeleton = {
  names: ["Root", "Hips", "Spine"],
  // t xyz, r xyzw, s xyz per bone
  rest: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0.3, 0, 0, 0, 0, 1, 1, 1, 1]),
};

const sampler: CurveSampler = (curve, rate, end, frames) => Float32Array.from({ length: frames }, (_, i) => evalCurve(curve, Math.min(i / rate, end)));

const s = Math.SQRT1_2;
function clip(): AnimSource {
  return {
    ...emptyAnimSource(),
    name: "Wave",
    rate: 10,
    duration: 1,
    loop: true,
    rotation: "nlerp",
    rootMotion: { bone: "Root", axes: ["x", "z"], bakeIntoPose: false },
    tracks: [
      { kind: "bone", bone: "Hips", translation: [[0, 0, 1, 0], [1, 0, 2, 0]], rotation: [[0, 0, 0, 0, 1], [1, 0, s, 0, s]], scale: [] },
      { kind: "bone", bone: "Ghost", translation: [[0, 1, 1, 1]], rotation: [], scale: [] },
      { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, 2]]] },
      { kind: "color", target: { nodePath: "", component: "engine.MeshRenderer", field: "material.color" }, name: "", curves: [[[0, 1]], [], [], []] },
      { kind: "vec2", target: { nodePath: "", component: "x", field: "y" }, name: "", curves: [[], []] },
      { kind: "event", target: { nodePath: "", component: "", field: "" }, keys: [{ time: 0.5, method: "footstep", args: ["L"], threshold: 0.5, always: false }] },
      { kind: "marker", keys: [{ time: 0.2, kind: "sync", name: "L" }] },
      { kind: "discrete", target: { nodePath: "Sprite", component: "engine.SpriteRenderer", field: "sprite" }, valueType: "asset", keys: [[0, "asset:a.png#0"], [0.5, "asset:a.png#1"]] },
    ],
  };
}

/** The section of `kind` in a valid file, and a DataView over the bytes. */
function section(bytes: Uint8Array, kind: number): { offset: number; count: number; view: DataView } {
  const h = readAnimationHeader(bytes, "myco.anim@1");
  if (!h.ok) throw new Error(h.problem);
  const sec = h.header.sections.find((x) => x.kind === kind)!;
  return { offset: sec.offset, count: sec.count, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

describe("raw clips (myco.anim@1 raw form)", () => {
  it("write a valid container with the clip's header facts", () => {
    const out = compileRawClip(clip(), SKELETON, "", sampler);
    const h = readAnimationHeader(out.bytes, "myco.anim@1");
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.header.name).toBe("Wave");
    expect(h.header.info).toMatchObject({ kind: "clip", duration: 1, rate: 10, frames: 11, bones: 3, loop: true, additive: false, slerp: false, raw: true, compressed: false, rootCurve: false } satisfies Partial<ClipInfo>);
    // Hips, the light, the colour; the event, marker and discrete key lists. The Ghost bone and the empty vec2 are dropped.
    expect((h.header.info as ClipInfo).tracks).toBe(6);
    expect(out.rootBone).toBe(0);
    expect(out.boneCount).toBe(3);
    expect(out.problems).toEqual(['bone track "Ghost": the skeleton has no such bone; dropped.']);
  });

  it("sample bone tracks at the clip's rate: keys interpolated, missing channels at rest", () => {
    const out = compileRawClip(clip(), SKELETON, "", sampler);
    const tracks = section(out.bytes, 3);
    const raw = section(out.bytes, 5);
    const at = (track: number) => tracks.view.getUint32(tracks.offset + track * 32 + 20, true);
    expect(tracks.view.getUint8(tracks.offset)).toBe(0); // kind bone
    expect(tracks.view.getUint32(tracks.offset + 4, true)).toBe(1); // Hips
    const f = (frame: number, k: number) => raw.view.getFloat32(raw.offset + 4 * (at(0) + frame * 10 + k), true);
    expect(f(5, 1)).toBeCloseTo(1.5, 6); // translation y halfway
    expect(Math.hypot(f(5, 3), f(5, 4), f(5, 5), f(5, 6))).toBeCloseTo(1, 6);
    expect(f(10, 4)).toBeCloseTo(s, 6);
    expect([f(3, 7), f(3, 8), f(3, 9)]).toEqual([1, 1, 1]); // scale: rest
    // The light's curve, and the colour's empty components: 0, alpha 1.
    const light = (frame: number) => raw.view.getFloat32(raw.offset + 4 * (at(1) + frame), true);
    expect(light(5)).toBeCloseTo(1, 6);
    const color = (frame: number, c: number) => raw.view.getFloat32(raw.offset + 4 * (at(2) + frame * 4 + c), true);
    expect([color(4, 0), color(4, 1), color(4, 2), color(4, 3)]).toEqual([1, 0, 0, 1]);
  });

  it("drop curve tracks, with a problem, when no sampler is given", () => {
    const out = compileRawClip(clip(), SKELETON);
    const h = readAnimationHeader(out.bytes, "myco.anim@1");
    expect(h.ok && (h.header.info as ClipInfo).tracks).toBe(4); // Hips and the three keyed lists
    expect(out.problems).toContain("float track Lamp intensity: no curve sampler was given; dropped.");
    expect(out.problems).toContain("color track (node) material.color: no curve sampler was given; dropped.");
  });

  it("write keyed tracks as key lists with their strings", () => {
    const out = compileRawClip(clip(), SKELETON, "", sampler);
    const keys = section(out.bytes, 4);
    expect(keys.count).toBe(4);
    const time = (k: number) => keys.view.getFloat32(keys.offset + k * 32, true);
    expect([time(0), time(1), time(2), time(3)].map((t) => Math.round(t * 10) / 10)).toEqual([0.5, 0.2, 0, 0.5]);
    expect(keys.view.getFloat32(keys.offset + 16, true)).toBe(0.5); // the event's threshold
  });

  it("drop bone tracks without a skeleton, and bind nothing then", () => {
    const out = compileRawClip(clip(), null, "", sampler);
    const h = readAnimationHeader(out.bytes, "myco.anim@1");
    expect(h.ok && (h.header.info as ClipInfo).bones).toBe(0);
    expect(out.rootBone).toBe(-1);
    expect(out.problems).toContain("2 bone tracks dropped: there's no skeleton to bind them to.");
  });

  it("are deterministic, and say what the compile needs", () => {
    expect(compileRawClip(clip(), SKELETON, "", sampler).bytes).toEqual(compileRawClip(clip(), SKELETON, "", sampler).bytes);
    expect(usesBones(clip())).toBe(true);
    expect(usesBones({ ...clip(), tracks: [] })).toBe(false);
    expect(rootMotionAxes({ bone: "Root", axes: ["x", "z", "yaw"], bakeIntoPose: false })).toBe(13);
    expect(rootMotionAxes({ bone: "Root", axes: ["x"], bakeIntoPose: true })).toBe(0);
    expect(rootMotionAxes(null)).toBe(0);
  });
});
