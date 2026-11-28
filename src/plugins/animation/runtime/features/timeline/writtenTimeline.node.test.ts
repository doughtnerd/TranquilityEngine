// A timeline written as a raw clip the way a TimelineDirector loads it (`timeline.ts`): the engine's one raw clip
// writer (`compileRawClip`, ADR 0451) given a timeline, no skeleton, and the animation core's curve evaluator.
// - T70c (ADR 0370, D142): curve tracks are sampled through the core's evaluator (`AnimationCore.curveSamples`) instead
//   of the engine's TypeScript `evalCurve`. The samples are held to what `evalCurve` gives, at the f32 parity bound of the
//   shared curve crate (1e-6, `native/common/curve/tests/parity.rs`), over the writer's frame rule `min(i / rate,
//   duration)`; the curves here stay within 0..2, so the bound is also 1e-6 of scale.
// - ADR 0451: a duration that isn't a whole number of frames still gets a last frame at the end (the timeline writer
//   used to round the frame count down, so a timeline's last key was never sampled), and keys out of time order are
//   written sorted (the timeline writer used to write them as authored).
import { beforeAll, describe, expect, it } from "vitest";
import { readAnimationHeader } from "../../../../../engine/animation/binaryHeader";
import { compileRawClip } from "../../../../../engine/animation/compile/rawClip";
import type { CurveSampler } from "../../../../../engine/animation/compile/curveKeys";
import { emptyTimeline, type Timeline } from "../../../../../engine/animation/timeline";
import type { Track } from "../../../../../engine/animation/tracks";
import { evalCurve, type Curve } from "../../../../../engine/core/curve";
import type { AnimationCore } from "../../core/AnimationCore";
import { loadAnimationCore } from "../../core/loader";

const RATE = 30, DURATION = 2;
const FRAMES = DURATION * RATE + 1;
const WAVE: Curve = [[0, 0], [0.5, 1, "smooth"], [1, -0.25, "bezier", { in: [-0.2, 0.3], out: [0.3, 0.5] }], [1.5, 2, "easeIn"], [1.9, 0.5, "step"], [2, 1]];
const RAMP: Curve = [[0, 1], [2, 0, "easeOut"]];
const NONE = 0xffffffff;

let core: AnimationCore;
let sampler: CurveSampler;
beforeAll(async () => {
  const load = await loadAnimationCore();
  if (load.status !== "ready") throw new Error("no simd128 in this Node");
  core = load.core;
  sampler = (curve, rate, end, frames) => core.curveSamples(curve, rate, end, frames);
});

const timeline = (fields: Partial<Timeline>): Timeline => ({ ...emptyTimeline(), ...fields });
const curves = timeline({
  name: "Curves",
  rate: RATE,
  duration: DURATION,
  tracks: [
    { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [WAVE] },
    { kind: "vec2", target: { nodePath: "", component: "x", field: "y" }, name: "", curves: [RAMP, []] },
    { kind: "color", target: { nodePath: "", component: "engine.MeshRenderer", field: "material.color" }, name: "", curves: [[], RAMP, [], []] },
  ],
});

interface Written {
  readonly frames: number;
  /** Per track: its samples (frames × width floats; empty for a keyed track) and its keys' times and first word. */
  readonly tracks: readonly { readonly samples: number[]; readonly keys: readonly { time: number; word: number }[] }[];
}

/** The written file's frame count, and each track's samples and keys. */
function read(bytes: Uint8Array): Written {
  const h = readAnimationHeader(bytes, "myco.anim@1");
  if (!h.ok) throw new Error(h.problem);
  if (h.header.info?.kind !== "clip") throw new Error("not a clip");
  const frames = h.header.info.frames;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sec = (kind: number) => h.header.sections.find((s) => s.kind === kind);
  const tracksAt = sec(3)!, raw = sec(5), keys = sec(4);
  return {
    frames,
    tracks: Array.from({ length: tracksAt.count }, (_, t) => {
      const at = tracksAt.offset + t * 32;
      const width = view.getUint8(at + 3);
      const rawOffset = view.getUint32(at + 20, true), first = view.getUint32(at + 24, true), count = view.getUint32(at + 28, true);
      return {
        samples: rawOffset === NONE ? [] : Array.from({ length: frames * width }, (_, i) => view.getFloat32(raw!.offset + 4 * (rawOffset + i), true)),
        keys: Array.from({ length: count }, (_, k) => ({ time: view.getFloat32(keys!.offset + (first + k) * 32, true), word: view.getUint32(keys!.offset + (first + k) * 32 + 8, true) })),
      };
    }),
  };
}

describe("a timeline written raw", () => {
  it("holds the core's curve samples, equal to the TypeScript evaluator's within the f32 bound", () => {
    const out = compileRawClip(curves, null, "", sampler);
    expect(out.problems).toEqual([]);
    const written = read(out.bytes);
    expect(written.frames).toBe(FRAMES);
    const [float, vec2, color] = written.tracks.map((t) => t.samples);
    const at = (i: number) => Math.min(i / RATE, DURATION);
    expect(float).toHaveLength(FRAMES);
    for (let i = 0; i < FRAMES; i++) {
      expect(Math.abs(float![i]! - evalCurve(WAVE, at(i))), `float frame ${i}`).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(vec2![i * 2]! - evalCurve(RAMP, at(i))), `vec2.x frame ${i}`).toBeLessThanOrEqual(1e-6);
      expect(vec2![i * 2 + 1], "an empty component").toBe(0);
      expect([color![i * 4]!, color![i * 4 + 2]!, color![i * 4 + 3]!], "empty components").toEqual([0, 0, 1]);
      expect(Math.abs(color![i * 4 + 1]! - evalCurve(RAMP, at(i)))).toBeLessThanOrEqual(1e-6);
    }
  });

  it("leaves curve tracks out, with a problem each, when no sampler is given", () => {
    const out = compileRawClip(curves, null);
    expect(out.problems).toHaveLength(3);
    expect(read(out.bytes).tracks).toEqual([]);
  });

  it("samples the timeline's end when its duration isn't a whole number of frames", () => {
    // 1.01 s at 30 Hz: frames at 0, 1/30 … 30/30 and a last one at 1.01, where the light reaches 1.
    const out = compileRawClip(timeline({ rate: 30, duration: 1.01, tracks: [{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, 0], [1.01, 1]]] }] }), null, "", sampler);
    const written = read(out.bytes);
    expect(written.frames).toBe(32);
    const [light] = written.tracks.map((t) => t.samples);
    expect(light![30]).toBe(0);
    expect(light![31]).toBeCloseTo(1, 6);
  });

  it("writes keys out of time order sorted, subclip references with them, and samples quaternion keys in time order", () => {
    const s = Math.SQRT1_2;
    const tracks: Track[] = [
      { kind: "activation", target: { nodePath: "Trail", component: "", field: "" }, keys: [{ time: 0.6, end: 0.8 }, { time: 0.2, end: 0.4 }] },
      {
        kind: "subclip", target: { nodePath: "", component: "", field: "" },
        keys: [
          { time: 1, end: 2, clip: "asset:b.timeline.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0 },
          { time: 0, end: 1, clip: "asset:a.timeline.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0 },
        ],
      },
      { kind: "quat", target: { nodePath: "Arm", component: "engine.Transform", field: "rotation" }, interp: "nlerp", keys: [[1, 0, 0, s, s], [0, 0, 0, 0, 1]] },
    ];
    const out = compileRawClip(timeline({ rate: 2, duration: 1, tracks }), null, "", sampler);
    const [activation, subclip, quat] = read(out.bytes).tracks;
    expect(activation!.keys.map((k) => k.time)).toEqual([Math.fround(0.2), Math.fround(0.6)]);
    expect(subclip!.keys.map((k) => k.time)).toEqual([0, 1]);
    const refs = out.subclips.get(1)!;
    expect(refs.map((r) => r.ref)).toEqual(["asset:a.timeline.json", "asset:b.timeline.json"]);
    expect(refs.map((r) => r.stringId)).toEqual(subclip!.keys.map((k) => k.word));
    // Frames at 0, 0.5 and 1: identity, halfway (a 45° turn about z), the last key.
    const half = Math.sin(Math.PI / 8), halfW = Math.cos(Math.PI / 8);
    const expected = [0, 0, 0, 1, 0, 0, half, halfW, 0, 0, s, s];
    quat!.samples.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i]!, 6));
  });
});
