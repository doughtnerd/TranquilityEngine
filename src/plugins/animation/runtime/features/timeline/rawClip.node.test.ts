// T70c (ADR 0370, D142): the timeline's raw clip writer samples curve tracks through the animation core's evaluator
// (`AnimationCore.curveSamples`) instead of the engine's TypeScript `evalCurve`. The samples are held to what `evalCurve`
// gave before, at the f32 parity bound of the shared curve crate (1e-6, `native/common/curve/tests/parity.rs`), over the
// writer's frame rule `min(i / rate, duration)`; the curves here stay within 0..2, so the bound is also 1e-6 of scale.
import { beforeAll, describe, expect, it } from "vitest";
import { readAnimationHeader } from "../../../../../engine/animation/binaryHeader";
import type { Track } from "../../../../../engine/animation/tracks";
import { evalCurve, type Curve } from "../../../../../engine/core/curve";
import type { AnimationCore } from "../../core/AnimationCore";
import { loadAnimationCore } from "../../core/loader";
import { writeRawClip } from "./rawClip";

const RATE = 30, DURATION = 2;
const FRAMES = Math.round(DURATION * RATE) + 1;
const WAVE: Curve = [[0, 0], [0.5, 1, "smooth"], [1, -0.25, "bezier", { in: [-0.2, 0.3], out: [0.3, 0.5] }], [1.5, 2, "easeIn"], [1.9, 0.5, "step"], [2, 1]];
const RAMP: Curve = [[0, 1], [2, 0, "easeOut"]];

let core: AnimationCore;
beforeAll(async () => {
  const load = await loadAnimationCore();
  if (load.status !== "ready") throw new Error("no simd128 in this Node");
  core = load.core;
});

const tracks: Track[] = [
  { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [WAVE] },
  { kind: "vec2", target: { nodePath: "", component: "x", field: "y" }, name: "", curves: [RAMP, []] },
  { kind: "color", target: { nodePath: "", component: "engine.MeshRenderer", field: "material.color" }, name: "", curves: [[], RAMP, [], []] },
];
const source = { name: "Curves", rate: RATE, duration: DURATION, loop: false, tracks };

/** Each curve track's samples (frames × width floats), from the written file. */
function written(bytes: Uint8Array): number[][] {
  const h = readAnimationHeader(bytes, "myco.anim@1");
  if (!h.ok) throw new Error(h.problem);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracksAt = h.header.sections.find((s) => s.kind === 3)!;
  const raw = h.header.sections.find((s) => s.kind === 5)!;
  return Array.from({ length: tracksAt.count }, (_, t) => {
    const at = tracksAt.offset + t * 32;
    const width = view.getUint8(at + 3);
    const first = view.getUint32(at + 20, true);
    return Array.from({ length: FRAMES * width }, (_, i) => view.getFloat32(raw.offset + 4 * (first + i), true));
  });
}

describe("writeRawClip's curve tracks", () => {
  it("hold the core's samples, equal to the TypeScript evaluator's within the f32 bound", () => {
    const out = writeRawClip(source, (curve, rate, end, frames) => core.curveSamples(curve, rate, end, frames));
    expect(out.dropped).toEqual([]);
    const [float, vec2, color] = written(out.bytes);
    const at = (i: number) => Math.min(i / RATE, DURATION);
    expect(float).toHaveLength(FRAMES);
    for (let i = 0; i < FRAMES; i++) {
      expect(Math.abs(float![i]! - evalCurve(WAVE, at(i))), `float frame ${i}`).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(vec2![i * 2]! - evalCurve(RAMP, at(i))), `vec2.x frame ${i}`).toBeLessThanOrEqual(1e-6);
      expect(vec2![i * 2 + 1], "an empty component").toBe(0);
      expect([color![i * 4]!, color![i * 4 + 2]!, color![i * 4 + 3]!], "empty components").toEqual([0, 0, 0]);
      expect(Math.abs(color![i * 4 + 1]! - evalCurve(RAMP, at(i)))).toBeLessThanOrEqual(1e-6);
    }
  });

  it("are left out, reported as dropped, when no sampler is given", () => {
    const out = writeRawClip(source);
    expect(out.dropped).toEqual(["curve", "curve", "curve"]);
    expect(written(out.bytes)).toEqual([]);
  });
});
