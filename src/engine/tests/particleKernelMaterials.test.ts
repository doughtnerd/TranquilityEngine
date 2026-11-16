// ADR 0126: kernel outputs drawn with material assets (a PBR copy with a placement plugin), and kernel
// emitters in the scene warm-up (ADR 0080). On Babylon's NullEngine, where the executor is JavaScript.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color as EngineColor } from "../core/math";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { MycoKernelParticlePlugin } from "../render/babylon/kernelMaterial";
import { BabylonParticles } from "../render/babylon/particles";
import { materialVertexCode } from "../render/particles/gpu/kernelShader";
import type { ParticleCommand, ParticleSystem } from "../render/components";
import { compileParticleGraph } from "../scene/particleCompile";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { newGraphId, particleGraphJSON, systemTemplate } from "../scene/particleGraphFormat";
import { compileParticleKernels } from "../scene/particleKernel";

function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
}

/** A kernel system whose output draws with `material`, plus a trail output when asked. */
function graph(material: string, opts: { trail?: boolean; blending?: "alpha" | "additive" } = {}): ParticleGraph {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.settings.simulation = "gpu";
  sys.settings.capacity = 64;
  addBlock(g, sys, "spawn", "spawn.rate", { rate: 60 });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 1 });
  sys.output.settings.material = material;
  sys.output.settings.blending = opts.blending ?? "alpha";
  if (opts.trail) sys.extraOutputs = [{ type: "trail", settings: { ...sys.output.settings, material: "", trailLength: 8 }, blocks: [] }];
  return g;
}

function fakeSystem(g: ParticleGraph): ParticleSystem {
  return {
    isActiveAndEnabled: true,
    effect: "",
    embeddedEffect: particleGraphJSON(g),
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
  } as unknown as ParticleSystem;
}

describe("kernel outputs with material assets, and kernel warm-up (ADR 0126)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let player: BabylonParticles;
  let material: Material | null;
  let copies: number;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    camera = new TargetCamera("camera", new Vector3(0, 0, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    material = new PBRMaterial("fx", scene);
    copies = 0;
    player = new BabylonParticles({
      scene,
      particlePreview: () => null,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      texture: () => Promise.reject(new Error("no textures")),
      tierScale: () => 1,
      kernelExecutors: ["js"],
      material: () => material,
      materialCopy: (_path, name) => {
        copies++;
        const m = (material as PBRMaterial).clone(name);
        return { material: m, dispose: () => m.dispose() };
      },
    });
  });
  afterEach(() => {
    player.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("compiles material outputs as supported, but reports them on trails", () => {
    const g = graph("materials/fx.material.json", { trail: true });
    g.systems[0].extraOutputs![0].settings.material = "materials/fx.material.json";
    const kp = compileParticleKernels(g, compileParticleGraph(g));
    expect(kp.systems[0].unsupported).toEqual(["material asset on a trail output"]);
  });

  it("draws a kernel output with an unshared copy of a PBR material carrying the placement plugin", () => {
    const c = fakeSystem(graph("materials/fx.material.json"));
    for (let i = 0; i < 5; i++) player.sync([c], 1 / 30, 1 / 30);
    const drawn = scene.meshes.filter((m) => m.name.startsWith("particles:Fx:"));
    expect(drawn).toHaveLength(1);
    const mesh = drawn[0] as Mesh;
    expect(copies).toBe(1);
    const ext = mesh.material as PBRMaterial;
    expect(ext).toBeInstanceOf(PBRMaterial);
    expect(ext).not.toBe(material);
    const plugin = ext.pluginManager?.getPlugin("MycoKernelParticles") as MycoKernelParticlePlugin;
    expect(plugin).toBeInstanceOf(MycoKernelParticlePlugin);
    expect(plugin.current?.pairs).toBeTruthy(); // alpha blending sorts by default: the sorted pairs are bound
    expect(plugin.current?.state).toHaveLength(4); // the JavaScript executor's four state textures
    expect(mesh.forcedInstanceCount).toBe(64);
    expect(mesh.getVerticesData("color")).toBeTruthy(); // white vertex colours carry the particle's
    player.dispose();
    expect(scene.materials.includes(ext)).toBe(false);
    expect(scene.materials.includes(material!)).toBe(true);
  });

  it("falls back to the texture draw for materials that aren't PBR, and says so", () => {
    material = new StandardMaterial("plain", scene);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = fakeSystem(graph("materials/plain.material.json"));
    player.sync([c], 1 / 30, 1 / 30);
    const mesh = scene.meshes.find((m) => m.name.startsWith("particles:Fx:"))!;
    expect(mesh.material).toBeInstanceOf(ShaderMaterial); // the kernel's own shader draw, with the texture
    expect(warn.mock.calls.some(([m]) => /isn't a PBR material/.test(String(m)))).toBe(true);
    warn.mockRestore();
  });

  it("splices placement code into both shading languages, with a define that differs per output", () => {
    const g = graph("m");
    const k = compileParticleKernels(g, compileParticleGraph(g)).systems[0];
    const wgsl = materialVertexCode(k, 0, "wgsl", { sorted: true, interleaved: true });
    expect(wgsl.definitions).toContain("kpst");
    expect(wgsl.definitions).toContain("kpidx");
    expect(wgsl.update).toContain("vertexInputs.instanceIndex");
    expect(wgsl.worldPos).toContain("worldPos = vec4f(positionUpdated, 1.0)");
    const glsl = materialVertexCode(k, 0, "glsl", { sorted: false, interleaved: false });
    expect(glsl.definitions).toContain("uniform highp sampler2D kps0;");
    expect(glsl.definitions).not.toMatch(/\bku\[/); // uniforms come from the kpu texture
    const a = new MycoKernelParticlePlugin(new PBRMaterial("a", scene), k, 0, { sorted: false, interleaved: false });
    const other = graph("m");
    addBlock(other, other.systems[0], "output", "attribute.size", { mode: "multiply", value: 2 });
    const k2 = compileParticleKernels(other, compileParticleGraph(other)).systems[0];
    const b = new MycoKernelParticlePlugin(new PBRMaterial("b", scene), k2, 0, { sorted: false, interleaved: false });
    const da = { MYCO_KERNEL_PARTICLES: 0 };
    const db = { MYCO_KERNEL_PARTICLES: 0 };
    a.prepareDefines(da as never);
    b.prepareDefines(db as never);
    expect(da.MYCO_KERNEL_PARTICLES).not.toBe(0);
    expect(da.MYCO_KERNEL_PARTICLES).not.toBe(db.MYCO_KERNEL_PARTICLES);
    expect(a.getCustomCode("vertex", ShaderLanguage.GLSL)?.CUSTOM_VERTEX_UPDATE_WORLDPOS).toBeTruthy();
  });

  it("warms kernel emitters' own draws (and pipelines) besides the CPU ones", () => {
    material = null;
    const effect = particleGraphJSON(graph("", { trail: true }));
    const parts = player.warm(effect, "warm:fx", { x: 0, y: 0, z: 0 }, camera)!;
    expect(parts.systems).toHaveLength(0); // no CPU draw for the kernel system
    expect(parts.meshes).toHaveLength(2); // the quad output and the trail
    for (const m of parts.meshes) expect(m.forcedInstanceCount).toBe(64);
    const meshes = scene.meshes.length;
    parts.dispose();
    expect(scene.meshes.length).toBe(meshes - 2);
  });

  it("warms a material-asset kernel output with its material copy", () => {
    const parts = player.warm(particleGraphJSON(graph("materials/fx.material.json")), "warm:fx", { x: 0, y: 0, z: 0 }, camera)!;
    expect(parts.meshes).toHaveLength(1);
    expect(parts.meshes[0]!.material?.pluginManager?.getPlugin("MycoKernelParticles")).toBeTruthy();
    parts.dispose();
  });
});
