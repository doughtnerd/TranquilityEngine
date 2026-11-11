// ADR 0162 D3: the Doppler pass: the OpenAL factor, the velocity estimator, the teleport guard, the hidden-tab reset, one-shots.
import { describe, expect, it } from "vitest";
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { DEFAULT_SEND_CURVE } from "../backend";
import { DopplerPass, dopplerFactor } from "./doppler";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "./spatial";

const SETTINGS = { doppler: { maxSpeed: 150 }, speedOfSound: 343 };

describe("dopplerFactor (OpenAL, c = 343)", () => {
  const f = (level: number, vl: number, vs: number) => dopplerFactor(343, level, vl, vs).factor;
  it("a source approaching at 34.3 u/s: 343 / 308.7", () => expect(f(1, 0, 34.3)).toBeCloseTo(1.1111111, 6));
  it("a source receding at 34.3 u/s: 343 / 377.3", () => expect(f(1, 0, -34.3)).toBeCloseTo(0.9090909, 6));
  it("a listener approaching at 34.3 u/s: 377.3 / 343", () => expect(f(1, -34.3, 0)).toBeCloseTo(1.1, 6));
  it("a listener receding at 34.3 u/s: 308.7 / 343", () => expect(f(1, 34.3, 0)).toBeCloseTo(0.9, 6));
  it("both approaching: 377.3 / 308.7", () => expect(f(1, -34.3, 34.3)).toBeCloseTo(1.2222222, 6));
  it("dopplerLevel 2 doubles the velocities: 343 / 274.4", () => expect(f(2, 0, 34.3)).toBeCloseTo(1.25, 6));
  it("dopplerLevel 0 is exactly 1", () => expect(f(0, 0, 100)).toBe(1));
  it("clamps to 0.5..2 and says so", () => {
    expect(dopplerFactor(343, 1, 0, -400)).toEqual({ factor: 0.5, clamped: true });
    expect(dopplerFactor(343, 1, 0, 300)).toEqual({ factor: 2, clamped: true });
    expect(dopplerFactor(343, 5, 0, 100)).toEqual({ factor: 2, clamped: true }); // capped at c / 5, denominator 0
    expect(dopplerFactor(343, 1, 0, 34.3).clamped).toBe(false);
  });
});

function rig(capacity = 4) {
  const gen = new Int32Array(capacity).fill(1);
  const flags = new Uint8Array(capacity).fill(SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED);
  const posX = new Float32Array(capacity), posY = new Float32Array(capacity), posZ = new Float32Array(capacity);
  const level = new Float32Array(capacity).fill(1);
  const rates: Array<[number, number]> = [];
  const view = {
    capacity, slots: Uint16Array.from([0]), count: 1, gen, viewFlags: flags, world: new Int32Array(capacity).fill(1),
    posX, posY, posZ, minDist: new Float32Array(capacity), maxDist: new Float32Array(capacity), volume: new Float32Array(capacity),
    audibility0: new Float32Array(capacity), dopplerLevel: level, reverbSend: new Float32Array(capacity), sendCurve: new Uint16Array(capacity),
    curves: Object.assign(new SendCurveTable(), { list: [DEFAULT_SEND_CURVE] }),
    setOcclusion() {}, setDopplerRate: (i: number, f: number) => void rates.push([i, f]),
  } as unknown as SpatialVoiceView;
  const pass = new DopplerPass(capacity);
  const frame = new ListenerFrame();
  const world = {} as World, node = {} as GameObject;
  const step = (dt: number, src: [number, number, number], lis: [number, number, number] = [0, 0, 0]) => {
    frame.set(world, 1, node, { position: { x: lis[0], y: lis[1], z: lis[2] }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } }, dt);
    posX[0] = src[0]; posY[0] = src[1]; posZ[0] = src[2];
    pass.run(frame, view, SETTINGS);
  };
  return { pass, frame, view, rates, step, level };
}

describe("DopplerPass", () => {
  it("a steady approach settles on the OpenAL factor", () => {
    const { pass, step } = rig();
    for (let k = 0; k < 120; k++) step(1 / 60, [100 - 34.3 * (k / 60), 0, 0]); // toward the listener at the origin
    expect(pass.velX[0]).toBeCloseTo(-34.3, 1);
    expect(pass.factor[0]!).toBeCloseTo(343 / (343 - 34.3), 3);
  });

  it("one-pole 60 ms: after one time constant the velocity is 63% of the step", () => {
    const { pass, step } = rig();
    step(0.06, [0, 0, 0]);
    step(0.06, [6, 0, 0]); // raw 100 u/s, under maxSpeed
    expect(pass.velX[0]).toBeCloseTo(100 * (1 - Math.exp(-1)), 3);
  });

  it("listener motion shifts a dopplerLevel > 0 source; a still pair stays at 1; dopplerLevel 0 never shifts", () => {
    const still = rig();
    for (let k = 0; k < 60; k++) still.step(1 / 60, [-100, 0, 0]);
    expect(still.pass.factor[0]).toBe(1);
    expect(still.rates).toEqual([]);
    const away = rig(); // the listener moves +x, away from a source at -100
    for (let k = 0; k < 120; k++) away.step(1 / 60, [-100, 0, 0], [(k / 60) * 34.3, 0, 0]);
    expect(away.pass.factor[0]!).toBeCloseTo(0.9, 3);
    const off = rig();
    off.level[0] = 0;
    for (let k = 0; k < 120; k++) off.step(1 / 60, [-100, 0, 0], [(k / 60) * 34.3, 0, 0]);
    expect(off.pass.factor[0]).toBe(1);
    expect(off.rates).toEqual([]);
  });

  it("a step faster than maxSpeed is a teleport: velocity 0 for 3 frames, counted", () => {
    const { pass, step } = rig();
    step(1 / 60, [0, 0, 0]);
    step(1 / 60, [0, 0, 0]);
    step(1 / 60, [50, 0, 0]); // 3000 u/s
    expect(pass.counters.dopplerTeleports).toBe(1);
    expect(pass.velX[0]).toBe(0);
    step(1 / 60, [50.1, 0, 0]);
    step(1 / 60, [50.2, 0, 0]);
    step(1 / 60, [50.3, 0, 0]);
    expect(pass.velX[0]).toBe(0); // held 3 frames
    step(1 / 60, [50.4, 0, 0]);
    expect(pass.velX[0]).not.toBe(0);
  });

  it("dt above 0.25 s resets every velocity and sets frame.cut; the step after is not a teleport", () => {
    const { pass, frame, step } = rig();
    for (let k = 0; k < 30; k++) step(1 / 60, [k * 0.5, 0, 0]);
    expect(Math.abs(pass.velX[0]!)).toBeGreaterThan(10);
    step(5, [500, 0, 0]);
    expect(pass.velX[0]).toBe(0);
    expect(pass.counters.dopplerGuardTrips).toBe(1);
    expect(pass.counters.dopplerTeleports).toBe(0);
    expect(frame.cut).toBe(true);
    step(1 / 60, [500.1, 0, 0]);
    expect(frame.cut).toBe(false);
    expect(pass.counters.dopplerTeleports).toBe(0);
  });

  it("a listener teleport sets frame.cut and holds its velocity at 0", () => {
    const { frame, step } = rig();
    step(1 / 60, [0, 0, 0], [0, 0, 0]);
    step(1 / 60, [0, 0, 0], [0, 0, 0]);
    step(1 / 60, [0, 0, 0], [500, 0, 0]);
    expect(frame.cut).toBe(true);
    expect([frame.velX, frame.velY, frame.velZ]).toEqual([0, 0, 0]);
  });

  it("the listener's override replaces its estimate; null estimates again", () => {
    const { frame, step } = rig();
    frame.setOverride({ x: 1, y: 2, z: 3 });
    step(1 / 60, [0, 0, 0], [0, 0, 0]);
    expect([frame.velX, frame.velY, frame.velZ]).toEqual([1, 2, 3]);
    frame.setOverride(null);
    step(1 / 60, [0, 0, 0], [0, 0, 0]);
    expect(frame.velX).not.toBe(1);
  });

  it("a voice's setVelocity bypasses the estimate", () => {
    const { pass, step } = rig();
    pass.setVelocity(0, { x: -34.3, y: 0, z: 0 });
    step(1 / 60, [100, 0, 0]);
    step(1 / 60, [100, 0, 0]);
    expect(pass.velX[0]).toBeCloseTo(-34.3, 5);
    expect(pass.factor[0]!).toBeCloseTo(343 / (343 - 34.3), 5);
  });

  it("Time.scale 0 (dt 0) keeps the velocity and reads no step", () => {
    const { pass, step } = rig();
    for (let k = 0; k < 60; k++) step(1 / 60, [k * 0.5, 0, 0]);
    const v = pass.velX[0];
    step(0, [1000, 0, 0]);
    expect(pass.velX[0]).toBe(v);
  });

  it("a new voice in the slot starts without history", () => {
    const { pass, view, step } = rig();
    for (let k = 0; k < 30; k++) step(1 / 60, [k * 0.5, 0, 0]);
    (view.gen as Int32Array)[0] = 2;
    step(1 / 60, [900, 0, 0]);
    expect(pass.velX[0]).toBe(0);
    expect(pass.counters.dopplerTeleports).toBe(0);
  });
});
