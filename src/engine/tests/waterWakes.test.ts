// ADR 0451: wakes on water. The trail recorder and the height field are plain maths, driven directly;
// the World's wakes through `updateWakes` (what the water's renderer calls each frame); the wake shader
// through its JavaScript output (ADR 0250), reading the very texels `updateWakes` packs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Quaternion, SceneManager, WaterWake } from "../../myco";
import type { World } from "../core/World";
import { WakeField, WAKE_FIELD_WAVE_SPEED } from "../render/water/wakeField";
import { WAKE_SHADER } from "../render/water/wakeShader";
import { WakePath, wakeStrength } from "../render/water/wakeTrail";
import { MAX_WAKES, TRAIL_HEADER, TRAIL_TEXELS, updateWakes, type WakeFrame } from "../render/water/wakes";

describe("wake trails (ADR 0451)", () => {
  it("wakeStrength is 0 at rest, rises above it and levels at full speed", () => {
    expect(wakeStrength(0.3, 6)).toBe(0);
    expect(wakeStrength(1, 6)).toBeGreaterThan(0);
    expect(wakeStrength(3, 6)).toBeLessThan(wakeStrength(5, 6));
    expect(wakeStrength(6, 6)).toBe(1);
    expect(wakeStrength(20, 6)).toBe(1);
  });

  it("a path lays points a spacing apart, newest first, ages them out and caps their number", () => {
    const path = new WakePath(1, 1, 5);
    for (let i = 0; i < 20; i++) path.step(i * 0.5, 0, 0.1, 1);
    expect(path.points.length).toBe(5);
    expect(path.points[0]!.x).toBeGreaterThan(path.points[1]!.x);
    for (let i = 1; i < path.points.length; i++) expect(path.points[i - 1]!.x - path.points[i]!.x).toBeGreaterThanOrEqual(1);
    path.step(100, 0, 2, 0);
    expect(path.points.length).toBe(0);
  });
});

describe("the wake height field (ADR 0451)", () => {
  /** A hull sailing +X at `speed` for `seconds`, the field centred on it each step. */
  function sail(speed: number, seconds: number): { field: WakeField; x: number } {
    const field = new WakeField(256, 96);
    let x = -20;
    for (let t = 0; t < seconds; t += 1 / 60) {
      x += speed / 60;
      field.recenter(x, 0);
      field.step(1 / 60, [{ x, z: 0, hx: 1, hz: 0, bow: 2, stern: -2, beam: 1, strength: 1, foam: 0.6 }]);
    }
    return { field, x };
  }

  it("a moving hull leaves waves and foam behind it, still water well ahead, mirrored either side of its path", () => {
    const { field, x } = sail(8, 3);
    let behind = 0, ahead = 0, asym = 0;
    for (let d = 4; d < 14; d += 0.5) {
      for (let z = 0.5; z < 6; z += 0.5) {
        behind += Math.abs(field.heightAt(x - d, z));
        ahead += Math.abs(field.heightAt(x + d + 3, z));
        asym += Math.abs(field.heightAt(x - d, z) - field.heightAt(x - d, -z));
      }
    }
    expect(behind).toBeGreaterThan(0.5);
    expect(ahead).toBeLessThan(behind * 0.05);
    expect(asym).toBeLessThan(behind * 1e-3);
    expect(field.foamAt(x - 4, 0)).toBeGreaterThan(0.2);
    expect(field.foamAt(x + 6, 0)).toBeLessThan(1e-3);
  });

  it("the wake is a V whose half-angle narrows as the hull outruns the waves (asin(c / v))", () => {
    /** How far out the waves reach at `d` metres behind the hull: the furthest |z| with a noticeable height. */
    const reach = (field: WakeField, x: number, d: number) => {
      let r = 0;
      for (let z = 0; z < 25; z += 0.25) if (Math.abs(field.heightAt(x - d, z)) > 0.004) r = z;
      return r;
    };
    const slow = sail(5, 4), fast = sail(10, 4);
    const angle = (s: { field: WakeField; x: number }) => Math.atan2(reach(s.field, s.x, 18) - reach(s.field, s.x, 8), 10);
    expect(angle(slow)).toBeGreaterThan(angle(fast));
    expect(angle(fast)).toBeGreaterThan(Math.asin(WAKE_FIELD_WAVE_SPEED / 10) * 0.5);
  });

  it("moving the field with the camera keeps the water it still covers", () => {
    const { field, x } = sail(8, 2);
    const before = field.heightAt(x - 6, 1.5);
    field.recenter(x + 20, 0);
    expect(field.heightAt(x - 6, 1.5)).toBeCloseTo(before, 6);
    field.clear();
    expect(field.heightAt(x - 6, 1.5)).toBe(0);
  });

  it("packs height, its slope and foam per cell", () => {
    const { field, x } = sail(8, 2);
    const out = new Float32Array(256 * 256 * 4);
    field.pack(out);
    const cell = field.cell;
    const i = Math.floor((x - 6 - field.originX) / cell), j = Math.floor((1.5 - field.originZ) / cell);
    const k = (j * 256 + i) * 4;
    const cx = field.originX + (i + 0.5) * cell, cz = field.originZ + (j + 0.5) * cell;
    expect(out[k]).toBeCloseTo(field.heightAt(cx, cz), 5);
    expect(out[k + 1]).toBeCloseTo((field.heightAt(cx + cell, cz) - field.heightAt(cx - cell, cz)) / (2 * cell), 4);
    expect(out[k + 3]).toBeCloseTo(Math.min(1, field.foamAt(cx, cz)), 5);
  });
});

describe("a World's wakes and the wake shader (ADR 0451)", () => {
  let engine: Engine;
  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
  });
  afterEach(() => engine.dispose());

  const world = () => engine.world as unknown as World;

  /** A boat heading +X (its +Z turned to +X) sailing at `speed` for `seconds`, the wakes updated each frame in `mode`. */
  function sail(mode: "trail" | "field", speed: number, seconds: number, props: { fullSpeed?: number; width?: number; bow?: number; stern?: number } = {}): { frame: WakeFrame; boat: GameObject; x: number } {
    const boat = GameObject.create("boat");
    boat.transform!.rotation = Quaternion.fromEuler(0, Math.PI / 2, 0);
    boat.addComponent(WaterWake, { fullSpeed: 6, ...props });
    let x = 0, frame!: WakeFrame;
    for (let t = 0; t < seconds; t += 1 / 60) {
      x += speed / 60;
      boat.transform!.position.set(x, 0, 0);
      engine.step(1 / 60);
      frame = updateWakes(world(), mode, { x, z: 0 });
    }
    return { frame, boat, x };
  }

  /** The trail texture as the shader samples it (nearest texel). */
  const trailTexture = (frame: WakeFrame) => (uv: number[]) => {
    const i = Math.min(TRAIL_TEXELS - 1, Math.floor(uv[0]! * TRAIL_TEXELS)), j = Math.min(MAX_WAKES - 1, Math.floor(uv[1]! * MAX_WAKES));
    const o = (j * TRAIL_TEXELS + i) * 4;
    return Array.from(frame.trail.subarray(o, o + 4));
  };
  const fieldTexture = (frame: WakeFrame) => (uv: number[]) => {
    const n = frame.fieldResolution;
    const i = Math.min(n - 1, Math.floor(uv[0]! * n)), j = Math.min(n - 1, Math.floor(uv[1]! * n));
    const o = (j * n + i) * 4;
    return Array.from(frame.field!.subarray(o, o + 4));
  };
  const shader = (frame: WakeFrame, mode: number) =>
    WAKE_SHADER.js({
      uniforms: { mycoWake: [mode, frame.trailCount, 1.25, 0], mycoWakeArea: [frame.fieldOrigin[0], frame.fieldOrigin[1], frame.fieldSize, frame.fieldResolution] },
      textures: { mycoWakeTrail: trailTexture(frame), mycoWakeField: fieldTexture(frame) },
    });

  it("measures a moving node's speed and lays its stern's trail; none at rest", () => {
    const { frame, x, boat } = sail("trail", 6, 3);
    expect(frame.trailCount).toBe(1);
    const t = frame.trail;
    expect(t[0]).toBeGreaterThan(5); // points in use
    expect(t[12]).toBeGreaterThan(0.9); // bow-wave strength: at full speed
    const stern = TRAIL_HEADER * 4;
    expect(t[stern]).toBeCloseTo(x - 2, 1); // the stern now, 2 m behind the node
    expect(t[stern + 4]).toBeLessThan(t[stern]!); // then the path behind it
    GameObject.destroy(boat);
    const still = sail("trail", 0, 1);
    expect(still.frame.trailCount).toBe(0);
  });

  it("strength 0 hides the wake at once", () => {
    const { boat } = sail("trail", 6, 2);
    boat.getComponent(WaterWake)!.strength = 0;
    engine.step(1 / 60);
    expect(updateWakes(world(), "trail", null).trailCount).toBe(0);
  });

  it("the trail shader foams the path behind the stern and bends the surface in the Kelvin wedge, leaving water far off alone", () => {
    const { frame, x } = sail("trail", 6, 3);
    const wake = shader(frame, 1).fn("mycoWakeAt");
    let foam = 0;
    for (let d = 1; d < 5; d += 0.25) foam = Math.max(foam, (wake([x - 2 - d, 0]) as number[])[2]!);
    expect(foam).toBeGreaterThan(0.2);
    expect(wake([x, 40])).toEqual([0, 0, 0, 0]);
    let slope = 0;
    for (let d = 3; d < 10; d += 0.2) {
      const g = wake([x - 2 - d, d * 0.3]) as number[];
      slope = Math.max(slope, Math.hypot(g[0]!, g[1]!));
    }
    expect(slope).toBeGreaterThan(0.01);
    // Off, nothing.
    expect(shader(frame, 0).fn("mycoWakeAt")([x - 4, 0])).toEqual([0, 0, 0, 0]);
  });

  it("the field shader reads the simulated height, interpolated as the CPU field does, and its slope", () => {
    const { frame, x } = sail("field", 6, 3);
    const prog = shader(frame, 2);
    const height = prog.fn("mycoWakeHeight");
    const at = prog.fn("mycoFieldAt");
    let any = 0;
    for (let d = 3; d < 12; d += 0.7) {
      const h = height([x - d, 1.3]) as number;
      any = Math.max(any, Math.abs(h));
      // The packed slope, interpolated, against the height's own finite difference.
      const v = at([x - d, 1.3]) as number[];
      expect(v[0]).toBeCloseTo(h, 6);
    }
    expect(any).toBeGreaterThan(0.01);
    expect(height([frame.fieldOrigin[0] - 5, 0])).toBe(0);
    // In trail mode the field raises nothing.
    expect(shader(frame, 1).fn("mycoWakeHeight")([x - 5, 1])).toBe(0);
  });
});
