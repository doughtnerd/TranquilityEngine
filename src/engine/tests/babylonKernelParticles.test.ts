// ADR 0094: kernel particle systems in the World player (render/babylon/particles.ts), on Babylon's
// NullEngine, where the only executor is JavaScript. The GPU executors are compared with it in a
// browser (`npm run bench:particles`).
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color as EngineColor } from "../core/math";
import { BabylonParticles } from "../render/babylon/particles";
import { kernelExecutors } from "../render/babylon/gpuParticles";
import type { ParticleCommand, ParticleSystem } from "../render/components";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { newGraphId, systemTemplate, formatParticleGraph } from "../scene/particleGraphFormat";

/** A graph as its file's JSON object. */
const graphJSON = (graph: ParticleGraph): Record<string, unknown> => JSON.parse(formatParticleGraph(graph));

function fakeSystem(graph: ParticleGraph, over: Partial<ParticleSystem> = {}) {
  return {
    isActiveAndEnabled: true,
    effect: "",
    embeddedEffect: graphJSON(graph),
    overrides: {},
    playOnAwake: true,
    timeScale: 1,
    tint: EngineColor.white,
    emissionScale: 1,
    destroyOnFinish: false,
    seed: 3,
    _commands: [] as ParticleCommand[],
    _state: { playing: false, paused: false, time: 0, count: 0, alive: false },
    node: { name: "Fx" },
    ...over,
  } as unknown as ParticleSystem;
}

function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
  return b;
}

function graph(simulation?: "auto" | "cpu" | "gpu", outputs = 1): ParticleGraph {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  if (simulation) sys.settings.simulation = simulation;
  sys.settings.capacity = 100;
  addBlock(g, sys, "spawn", "spawn.rate", { rate: 60 });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 1 });
  for (let i = 1; i < outputs; i++) sys.extraOutputs = [...(sys.extraOutputs ?? []), { type: "quad", settings: { ...sys.output.settings }, blocks: [] }];
  return g;
}

describe("kernel particle systems in the World player (ADR 0094)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let players: BabylonParticles[];

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    const camera = new TargetCamera("camera", new Vector3(0, 0, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    players = [];
  });

  afterEach(() => {
    for (const p of players) p.dispose();
    scene.dispose();
    engine.dispose();
  });

  function make() {
    const p = new BabylonParticles({
      scene,
      particlePreview: () => null,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      texture: () => Promise.reject(new Error("no textures")),
      tierScale: () => 1,
    });
    players.push(p);
    return p;
  }
  /** The meshes drawing `node`'s effect (each kernel output draws one). */
  const meshesOf = (node: string) => scene.meshes.filter((m) => m.name.startsWith(`particles:${node}:`)) as Mesh[];
  const frames = (p: BabylonParticles, c: ParticleSystem, n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) p.sync([c], dt, dt);
  };

  it("has only the JavaScript executor on a NullEngine", () => {
    expect(kernelExecutors(engine)).toEqual(["js"]);
  });

  it("keeps plain systems on the CPU and runs gpu systems on a kernel with one draw per output", () => {
    const p = make();
    const cpu = fakeSystem(graph());
    const gpu = fakeSystem(graph("gpu", 2), { node: { name: "Gpu" } } as Partial<ParticleSystem>);
    p.sync([cpu, gpu], 1 / 60, 1 / 60);
    // The CPU system draws through a Babylon particle system, the kernel one with a mesh per output.
    expect(scene.particleSystems.map((s) => s.name)).toEqual([expect.stringMatching(/^particles:Fx:/)]);
    expect(meshesOf("Fx")).toHaveLength(0);
    const meshes = meshesOf("Gpu");
    expect(meshes).toHaveLength(2);
    expect(meshes[0].forcedInstanceCount).toBe(100);
    expect(meshes[0].material).toBeInstanceOf(ShaderMaterial);
    expect(meshes[0].alwaysSelectAsActiveMesh).toBe(true);
    expect(p.state()).toMatchObject({ systems: 2, emitters: 2, batches: 3 });
    // The variant report finds the system a kernel output's mesh draws for.
    expect(p.ownerOf(meshes[1])).toBe(gpu);
    expect(p.ownerOf(scene.particleSystems[0])).toBe(cpu);
  });

  it("spawns, counts (estimated) and finishes kernel systems through the component's state", () => {
    const p = make();
    const g = graph("gpu");
    g.systems[0].spawn.settings.looping = false;
    g.systems[0].spawn.settings.duration = 0.5;
    const c = fakeSystem(g);
    frames(p, c, 20);
    expect(c._state.count).toBeGreaterThan(15);
    expect(c._state.playing).toBe(true);
    frames(p, c, 20);
    expect(c._state.playing).toBe(false); // the cycle ended
    expect(c._state.alive).toBe(true); // particles still live
    frames(p, c, 120);
    expect(c._state.alive).toBe(false);
    expect(c._state.count).toBe(0);
  });

  it("stops and clears kernel systems by command", () => {
    const p = make();
    const c = fakeSystem(graph("gpu"));
    frames(p, c, 10);
    expect(c._state.count).toBeGreaterThan(0);
    c._commands.push({ op: "stop", clear: true });
    frames(p, c, 1);
    expect(c._state.playing).toBe(false);
    expect(c._state.count).toBe(0);
    expect(c._state.alive).toBe(false); // not emitting, nothing left
  });

  it("doesn't report CPU-only problems for systems a kernel runs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = make();
    p.sync([fakeSystem(graph("gpu", 2))], 1 / 60, 1 / 60);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /outputs/.test(m))).toEqual([]);
    p.sync([fakeSystem(graph("cpu", 2))], 1 / 60, 1 / 60);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /outputs/.test(m))).toHaveLength(1);
    warn.mockRestore();
  });

  it("soft outputs read a scene depth: the depth renderer on scenes no frame graph draws (ADR 0096)", () => {
    const p = make();
    const g = graph("gpu");
    g.systems[0].output.settings.softness = 0.5;
    const c = fakeSystem(g);
    frames(p, c, 2);
    const d = meshesOf("Fx")[0];
    expect(d.material!.getActiveTextures().length).toBeGreaterThan(0);
    const renderers = (scene as unknown as { _depthRenderer?: Record<string, unknown> })._depthRenderer ?? {};
    expect(Object.keys(renderers).length).toBe(1);
    p.dispose();
    expect(Object.keys((scene as unknown as { _depthRenderer?: Record<string, unknown> })._depthRenderer ?? {}).length).toBe(0);
  });

  it("disposes kernel draws with the system", () => {
    const p = make();
    const c = fakeSystem(graph("gpu"));
    frames(p, c, 2);
    const [mesh] = meshesOf("Fx");
    p.release(c);
    expect(mesh.isDisposed()).toBe(true);
  });
});
