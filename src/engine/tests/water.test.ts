import { Mesh, Scene, ShaderLib } from "three";
import { afterEach, describe, expect, it } from "vitest";
import { Buoyancy, Engine, GameObject, Graphics, Quaternion, RigidBody, SceneManager, Assets, Vector3, Water, WaterSurface, type WaterWave } from "../index";
import type { World } from "../core/World";
import {
  GERSTNER_BODY,
  MAX_WAVES,
  WAVE_STRIDE,
  WATER_PRESET,
  cleanWaves,
  createPackedWaves,
  deepWaterSpeed,
  gerstner,
  gerstnerBodyJS,
  gerstnerGLSL,
  packWaves,
  sampleWaves,
  type PackedWaves,
} from "../render/water/gerstner";
import { patchWaterShader } from "../render/water/waterShader";
import { WaterRenderer, waterResolution } from "../render/water/WaterRenderer";
import { sampleSurface, waterTime } from "../render/water/WaterSurface";

/** A seeded random source, so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomWaves(r: () => number, count: number): WaterWave[] {
  return Array.from({ length: count }, () => ({ direction: r() * 360 - 180, wavelength: 2 + r() * 40, steepness: (r() * 0.7) / count, speed: r() < 0.5 ? 0 : r() * 6 }));
}

/**
 * The shader's wave sum, run as JavaScript: the exact text `gerstnerGLSL()` puts in the vertex
 * shader, with only `float`/`int` → `let` and `sin`/`cos` → `Math.*`.
 */
const shaderWaves = new Function("mycoWaves", "mycoWaveCount", "px", "pz", `${gerstnerBodyJS()}\nreturn [gx, gy, gz, tx, ty, tz, bx, by, bz];`) as (w: ArrayLike<number>, n: number, px: number, pz: number) => number[];

const shaderAt = (p: PackedWaves, x: number, z: number) => shaderWaves(p.data, p.count, x, z);

describe("Gerstner waves: one sum for the GPU and the CPU (ADR 0072)", () => {
  it("the GLSL is the shared body with only the type words filled in", () => {
    const glsl = gerstnerGLSL();
    expect(glsl).not.toContain("$");
    expect(glsl).toContain(`uniform float mycoWaves[${MAX_WAVES * WAVE_STRIDE}];`);
    expect(glsl).toContain("uniform int mycoWaveCount;");
    expect(glsl).toContain("void mycoGerstner(float px, float pz, out vec3 disp, out vec3 tangent, out vec3 binormal)");
    // Every statement of the body appears verbatim (after the type substitution) in the GLSL and the JavaScript.
    const glslBody = GERSTNER_BODY.replace(/\$float/g, "float").replace(/\$int/g, "int");
    expect(glsl).toContain(glslBody);
    expect(gerstnerBodyJS().replace(/Math\./g, "").replace(/\blet\b/g, "T")).toBe(GERSTNER_BODY.replace(/\$float|\$int/g, "T"));
  });

  it("the CPU sampler's sum matches the shader's sum at sample points, for random wave sets and times", () => {
    const r = rng(7);
    for (let set = 0; set < 20; set++) {
      const count = 1 + Math.floor(r() * MAX_WAVES);
      const packed = packWaves(randomWaves(r, count), 0.5 + r() * 1.5, r() * 1000);
      for (let i = 0; i < 25; i++) {
        const x = (r() - 0.5) * 400, z = (r() - 0.5) * 400;
        const cpu = gerstner(packed, x, z);
        const gpu = shaderAt(packed, x, z);
        expect([cpu.dx, cpu.dy, cpu.dz, cpu.tx, cpu.ty, cpu.tz, cpu.bx, cpu.by, cpu.bz]).toEqual(gpu);
      }
    }
  });

  it("matches with the 32-bit uniforms the GPU actually gets, within float precision", () => {
    const r = rng(11);
    const packed = packWaves(WATER_PRESET.map((w) => ({ ...w })), 1, 12345.678);
    const f32 = new Float32Array(packed.data);
    for (let i = 0; i < 50; i++) {
      const x = (r() - 0.5) * 200, z = (r() - 0.5) * 200;
      const cpu = gerstner(packed, x, z);
      const gpu = shaderWaves(f32, packed.count, Math.fround(x), Math.fround(z));
      expect(Math.abs(cpu.dy - gpu[1])).toBeLessThan(1e-4);
      expect(Math.abs(cpu.dx - gpu[0])).toBeLessThan(1e-4);
    }
  });

  it("sampling inverts the sideways motion: the height at a displaced vertex's XZ is that vertex's height", () => {
    const r = rng(3);
    const packed = packWaves(WATER_PRESET.map((w) => ({ ...w })), 1.5, 42);
    for (let i = 0; i < 200; i++) {
      const px = (r() - 0.5) * 100, pz = (r() - 0.5) * 100;
      const v = shaderAt(packed, px, pz); // the drawn vertex of rest position (px, pz)
      const s = sampleWaves(packed, px + v[0], pz + v[2]);
      expect(Math.abs(s.height - v[1])).toBeLessThan(1e-6);
      // Normal = binormal × tangent, normalised.
      const n = [v[7] * v[5] - v[8] * v[4], v[8] * v[3] - v[6] * v[5], v[6] * v[4] - v[7] * v[3]];
      const len = Math.hypot(n[0], n[1], n[2]);
      expect(s.nx).toBeCloseTo(n[0] / len, 5);
      expect(s.ny).toBeCloseTo(n[1] / len, 5);
      expect(s.nz).toBeCloseTo(n[2] / len, 5);
    }
  });

  it("packs time into each wave's phase, uses the deep-water speed for speed 0, and scales amplitude", () => {
    const wave = { direction: 90, wavelength: 10, steepness: 0.5, speed: 0 };
    const p = packWaves([wave], 2, 3);
    const k = (Math.PI * 2) / 10;
    expect(p.count).toBe(1);
    expect(p.data[0]).toBeCloseTo(0, 12);
    expect(p.data[1]).toBeCloseTo(1, 12);
    expect(p.data[2]).toBeCloseTo(k, 12);
    expect(p.data[3]).toBeCloseTo((2 * 0.5) / k, 12);
    expect(p.data[4]).toBeCloseTo((k * deepWaterSpeed(10) * 3) % (Math.PI * 2), 9);
    expect(deepWaterSpeed(10)).toBeCloseTo(Math.sqrt((9.81 * 10) / (2 * Math.PI)), 12);
    // A wave moves: the crest found at t is found c·dt further along at t + dt.
    const c = deepWaterSpeed(10);
    const h0 = sampleWaves(packWaves([wave], 1, 0), 0, 2.5).height;
    const h1 = sampleWaves(packWaves([wave], 1, 1), 0, 2.5 + c).height;
    expect(h1).toBeCloseTo(h0, 6);
  });

  it("cleans scene data: at most 8 waves, steepness clamped, missing fields defaulted", () => {
    const many = Array.from({ length: 12 }, () => ({ direction: 0, wavelength: 5, steepness: 3, speed: 0 }));
    const clean = cleanWaves(many);
    expect(clean).toHaveLength(MAX_WAVES);
    expect(clean[0].steepness).toBe(1);
    expect(cleanWaves([{} as WaterWave])[0]).toEqual({ direction: 0, wavelength: 10, steepness: 0.2, speed: 0 });
    expect(packWaves(clean, 1, 0, createPackedWaves()).count).toBe(MAX_WAVES);
  });
});

describe("Water material (ADR 0072)", () => {
  it("patches three's physical shader: displaced vertices, analytic normal, foam and colour, fog chunks kept", () => {
    const shader = { vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
    patchWaterShader(shader);
    expect(shader.vertexShader).toContain("mycoGerstner(position.x, position.z, mycoDisp, mycoTangent, mycoBinormal);");
    expect(shader.vertexShader).toContain("transformed += mycoDisp;");
    expect(shader.vertexShader).not.toContain("#include <beginnormal_vertex>");
    expect(shader.vertexShader).toContain("#include <fog_vertex>");
    expect(shader.fragmentShader).toContain("#include <fog_fragment>");
    expect(shader.fragmentShader).toContain("mycoFoamColor");
    // The displacement comes before the vertex is projected, so shadows and fog see the moved vertex.
    expect(shader.vertexShader.indexOf("transformed += mycoDisp;")).toBeLessThan(shader.vertexShader.indexOf("#include <project_vertex>"));
  });
});

describe("WaterSurface and Water.sample (ADR 0072)", () => {
  afterEach(() => Graphics._apply("High"));

  async function setup() {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
    const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10, 0] as [number, number, number] } } });
    await SceneManager.load("s.json");
    return engine;
  }

  it("samples the drawn surface in world space through the node's transform", async () => {
    const engine = await setup();
    expect(Water.sample(0, 0)).toBeNull();
    const node = GameObject.create("sea");
    node.transform!.position.set(10, 2, -5);
    node.transform!.rotation = Quaternion.fromEuler(0, 30, 0);
    node.transform!.scale.set(2, 1.5, 2);
    const water = node.addBehavior(WaterSurface);
    water.waveScale = 1.2;
    engine.step(1 / 60);
    expect(Water.surface).toBe(water);
    const time = waterTime(engine.world as unknown as World);
    expect(time).toBeGreaterThan(0);
    const packed = water._pack(time);
    const r = rng(5);
    const m = (engine.world as unknown as World).worldMatrix(node.entity), o = node.entity * 16;
    for (let i = 0; i < 50; i++) {
      // A drawn vertex: rest position, displaced by the shader's sum, then through the model matrix.
      const px = (r() - 0.5) * 80, pz = (r() - 0.5) * 80;
      const v = shaderAt(packed, px, pz);
      const lx = px + v[0], ly = v[1], lz = pz + v[2];
      const wx = m[o] * lx + m[o + 4] * ly + m[o + 8] * lz + m[o + 12];
      const wy = m[o + 1] * lx + m[o + 5] * ly + m[o + 9] * lz + m[o + 13];
      const wz = m[o + 2] * lx + m[o + 6] * ly + m[o + 10] * lz + m[o + 14];
      const s = water.sample(wx, wz);
      expect(Math.abs(s.height - wy)).toBeLessThan(1e-4);
      expect(Water.sample(wx, wz)!.height).toBeCloseTo(s.height, 9);
      expect(s.normal.y).toBeGreaterThan(0);
      expect(Math.hypot(s.normal.x, s.normal.y, s.normal.z)).toBeCloseTo(1, 6);
    }
    // Calm water is the node's plane, facing up.
    water.waves = [];
    const flat = water.sample(3, 4);
    expect(flat.height).toBeCloseTo(2, 5);
    expect(flat.normal.y).toBeCloseTo(1, 6);
    engine.dispose();
  });

  it("uses the server tick as the clock in a networked World", () => {
    const world = { time: { time: 99, fixedAlpha: 0.5, network: { tick: 0, serverTick: 120, interpolationTick: 0, interpolationFraction: 0, rtt: 0, tickRate: 60 } } } as unknown as World;
    expect(waterTime(world)).toBeCloseTo(120.5 / 60, 12);
    const local = { time: { time: 7.25, fixedAlpha: 0.3 } } as unknown as World;
    expect(waterTime(local)).toBe(7.25);
  });

  it("the renderer draws a grid per surface from the same packed waves, halved on the low shader level", async () => {
    const engine = await setup();
    const world = engine.world as unknown as World;
    const node = GameObject.create("sea");
    const water = node.addBehavior(WaterSurface);
    water.resolution = 64;
    water.size = 50;
    engine.step(1 / 60);
    const scene = new Scene();
    const renderer = new WaterRenderer(scene);
    renderer.sync(world, [water]);
    const mesh = renderer.meshes()[0] as Mesh;
    expect(scene.children).toContain(mesh);
    expect(mesh.geometry.getAttribute("position").count).toBe(64 * 64);
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.x).toBeCloseTo(25, 6);
    expect(mesh.geometry.boundingBox!.max.y).toBeCloseTo(0, 6);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(true);
    const material = mesh.material as import("three").MeshPhysicalMaterial;
    expect(material.customProgramCacheKey()).toBe("myco-water-1");
    // The uniforms are the component's packed waves at the water clock.
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
    material.onBeforeCompile(shader as never, null as never);
    const packed = water._pack(waterTime(world));
    expect(Array.from(shader.uniforms.mycoWaves.value as Float32Array)).toEqual(Array.from(new Float32Array(packed.data)));
    expect(shader.uniforms.mycoWaveCount.value).toBe(WATER_PRESET.length);
    expect(material.transparent).toBe(false);
    water.opacity = 0.6;
    renderer.sync(world, [water]);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeCloseTo(0.6, 6);

    expect(waterResolution(128, "high")).toBe(128);
    expect(waterResolution(128, "low")).toBe(64);
    Graphics._apply("Low");
    renderer.sync(world, [water]);
    expect(mesh.geometry.getAttribute("position").count).toBe(32 * 32);

    renderer.sync(world, []);
    expect(renderer.meshes()).toHaveLength(0);
    expect(scene.children).not.toContain(mesh);
    engine.dispose();
  });
});

describe("Buoyancy (ADR 0072)", () => {
  async function setup() {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
    const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10, 0] as [number, number, number] } } });
    await SceneManager.load("s.json");
    return engine;
  }
  const steps = (engine: Engine, n: number) => {
    for (let i = 0; i < n; i++) engine.step(1 / 60);
  };

  it("runs after scripts and before the 3D physics push", async () => {
    const engine = await setup();
    const order = engine.world.scheduler.order("fixedUpdate");
    expect(order.indexOf("engine.Buoyancy")).toBeGreaterThan(order.indexOf("engine.FixedUpdateScripts"));
    expect(order.indexOf("engine.Buoyancy")).toBeLessThan(order.indexOf("engine.Physics3DPush"));
    engine.dispose();
  });

  it("physics mode floats a dropped body at the depth its strength sets, damped by drag", async () => {
    const engine = await setup();
    const sea = GameObject.create("sea");
    sea.addBehavior(WaterSurface).waves = []; // calm, at y = 0
    const box = GameObject.create("box");
    box.transform!.position.y = 3;
    const body = box.addBehavior(RigidBody);
    body.mass = 2;
    const b = box.addBehavior(Buoyancy);
    b.size.set(2, 4);
    b.strength = 2; // floats with its points 0.5 deep
    b.drag = 2;
    b.angularDrag = 2;
    expect(b.samplePoints()).toHaveLength(4);
    steps(engine, 20);
    expect(b.submerged).toBe(0); // still falling
    steps(engine, 600);
    expect(b.submerged).toBe(1);
    expect(box.transform!.worldPosition.y).toBeCloseTo(-0.5, 1);
    expect(Math.abs(body.velocity.y)).toBeLessThan(0.05);
    engine.dispose();
  });

  it("physics mode tilts a body on a slope of the waves", async () => {
    const engine = await setup();
    const sea = GameObject.create("sea");
    const water = sea.addBehavior(WaterSurface);
    water.waves = [{ direction: 0, wavelength: 40, steepness: 0.3, speed: 1e-6 }]; // nearly frozen
    const box = GameObject.create("box");
    // Where the surface rises toward +X (phase 0: height = a·sin(kx), rising at x = 0).
    const body = box.addBehavior(RigidBody);
    body.useGravity = true;
    const b = box.addBehavior(Buoyancy);
    b.points = [new Vector3(-2, 0, 0), new Vector3(2, 0, 0)];
    b.drag = 3;
    b.angularDrag = 3;
    steps(engine, 240);
    // Higher water at +X pushes that end up: a turn about +Z (counter-clockwise seen from +Z).
    const up = box.transform!.worldRotation.toEuler();
    expect(up.z).toBeGreaterThan(1);
    engine.dispose();
  });

  it("kinematic mode puts the node on the waves and fits its pitch and roll to them", async () => {
    const engine = await setup();
    const sea = GameObject.create("sea");
    sea.transform!.position.y = 1;
    const water = sea.addBehavior(WaterSurface);
    water.waves = [{ direction: 0, wavelength: 40, steepness: 0.3, speed: 1e-6 }];
    const ship = GameObject.create("ship");
    ship.transform!.position.set(0, 5, 0);
    ship.transform!.rotation = Quaternion.fromEuler(0, 90, 0); // heading turned; tilt must still follow the world slope
    const b = ship.addBehavior(Buoyancy);
    b.mode = "kinematic";
    b.follow = 0; // snap
    b.size.set(2, 2);
    steps(engine, 1);
    const p = ship.transform!.worldPosition;
    // Mean water height at the four corners around the node.
    const time = waterTime(engine.world as unknown as World);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => sampleSurface(water, p.x + x, p.z + z, time).height);
    const mean = corners.reduce((a, c) => a + c, 0) / 4;
    expect(p.y).toBeCloseTo(mean, 4);
    expect(b.submerged).toBe(1);
    // The ship's up axis leans the way the surface normal does (toward -X where the water rises toward +X).
    const n = water.sample(p.x, p.z).normal;
    const q = ship.transform!.worldRotation;
    const upX = 2 * (q.x * q.y - q.w * q.z);
    expect(Math.sign(upX)).toBe(Math.sign(n.x));
    expect(Math.abs(upX - n.x)).toBeLessThan(0.05);
    // Heading kept: the local X axis still points along world -Z (yaw 90°).
    const fwdZ = 2 * (q.x * q.z - q.w * q.y);
    expect(fwdZ).toBeLessThan(-0.9);
    engine.dispose();
  });
});
