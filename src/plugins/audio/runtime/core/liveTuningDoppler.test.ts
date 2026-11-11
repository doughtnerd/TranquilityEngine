// ADR 0162 E7 (#158): live tuning of the Doppler inputs: a source's `dopplerLevel` (read from the view every frame), the
// listener's velocity override (`ListenerFrame.setOverride`, which `AudioListener.setVelocity` feeds each frame), and the
// settings `audio.doppler.maxSpeed` and `audio.speedOfSound` (read from the settings object every frame, so the next
// `Engine.create` reconfigure reaches a running World at once).
import { describe, expect, it } from "vitest";
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { DEFAULT_SEND_CURVE } from "../backend";
import { DopplerPass } from "./doppler";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "./spatial";

function rig() {
  const n = 4;
  const posX = new Float32Array(n);
  const level = new Float32Array(n).fill(1);
  const rates: number[] = [];
  const view = {
    capacity: n, slots: Uint16Array.from([0]), count: 1, gen: new Int32Array(n).fill(1),
    viewFlags: new Uint8Array(n).fill(SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED), world: new Int32Array(n).fill(1),
    posX, posY: new Float32Array(n), posZ: new Float32Array(n), minDist: new Float32Array(n), maxDist: new Float32Array(n), volume: new Float32Array(n),
    audibility0: new Float32Array(n), dopplerLevel: level, reverbSend: new Float32Array(n), sendCurve: new Uint16Array(n),
    curves: Object.assign(new SendCurveTable(), { list: [DEFAULT_SEND_CURVE] }),
    setOcclusion() {}, setDopplerRate: (_i: number, f: number) => void rates.push(f),
  } as unknown as SpatialVoiceView;
  const pass = new DopplerPass(n);
  const frame = new ListenerFrame();
  const settings = { doppler: { maxSpeed: 150 }, speedOfSound: 343 };
  const world = {} as World, node = {} as GameObject;
  /** One frame with the source at `x` (a source at -100 moving +x approaches a listener at the origin). */
  const step = (x: number) => {
    frame.set(world, 1, node, { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
    posX[0] = x;
    pass.run(frame, view, settings);
  };
  /** The source approaching at `speed` for `frames` frames; returns the factor reached. */
  let x = -100;
  const approach = (speed: number, frames = 120) => {
    for (let k = 0; k < frames; k++) step((x += speed / 60));
    return pass.factor[0]!;
  };
  return { pass, frame, settings, level, rates, step, approach };
}

describe("Doppler live inputs", () => {
  it("a source's dopplerLevel: changing it changes the factor on the next frames", () => {
    const r = rig();
    expect(r.approach(34.3)).toBeCloseTo(343 / (343 - 34.3), 3);
    r.level[0] = 2;
    expect(r.approach(34.3, 1)).toBeCloseTo(343 / (343 - 68.6), 3);
    r.level[0] = 0;
    expect(r.approach(34.3, 1)).toBe(1);
  });

  it("the listener's velocity override replaces the estimate from the next frame, and null returns to it", () => {
    const r = rig();
    for (let k = 0; k < 10; k++) r.step(-100); // a still pair
    expect(r.pass.factor[0]).toBe(1);
    r.frame.setOverride({ x: 34.3, y: 0, z: 0 });
    r.step(-100);
    // The source sits at -100: the listener moving +x goes away from it.
    expect(r.pass.factor[0]!).toBeCloseTo(0.9, 3);
    r.frame.setOverride({ x: 0, y: 0, z: 0 }); // zero across a camera cut
    r.step(-100);
    expect(r.pass.factor[0]).toBe(1);
    r.frame.setOverride(null);
    r.step(-100);
    expect(r.pass.factor[0]).toBe(1);
  });

  it("speedOfSound: read each frame", () => {
    const r = rig();
    expect(r.approach(34.3, 60)).toBeCloseTo(343 / (343 - 34.3), 3);
    r.settings.speedOfSound = 686;
    expect(r.approach(34.3, 60)).toBeCloseTo(686 / (686 - 34.3), 3);
  });

  it("maxSpeed: a lower limit makes the same motion a teleport from the next frame", () => {
    const r = rig();
    r.approach(100, 30); // 100 u/s is under the limit of 150
    expect(r.pass.counters.dopplerTeleports).toBe(0);
    r.settings.doppler = { maxSpeed: 50 };
    r.approach(100, 1);
    expect(r.pass.counters.dopplerTeleports).toBe(1);
  });
});
