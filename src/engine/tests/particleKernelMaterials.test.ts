// ADR 0126: kernel outputs drawn with material assets (a PBR copy with a placement plugin), and kernel
// emitters in the scene warm-up (ADR 0080). On Babylon's NullEngine, where the executor is JavaScript.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color as EngineColor } from "../core/math";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { BabylonParticles } from "../render/babylon/particles";
import { materialVertexCode } from "../render/particles/gpu/kernelShader";
import type { ParticleCommand, ParticleSystem } from "../render/components";
import { compileParticleGraph } from "../scene/particleCompile";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { newGraphId, systemTemplate, formatParticleGraph } from "../scene/particleGraphFormat";
import { compileParticleKernels } from "../scene/particleKernel";
import { shaderText } from "./pbrShaderSource";

/** A graph as its file's JSON object. */
const graphJSON = (graph: ParticleGraph): Record<string, unknown> => JSON.parse(formatParticleGraph(graph));

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
    embeddedEffect: graphJSON(g),
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

/** The placement plugin on a kernel draw's material (Babylon's plugin API). */
const placement = (mesh: AbstractMesh): MaterialPluginBase => (mesh.material as PBRMaterial).pluginManager!.getPlugin("MycoKernelParticles")!;
/** The textures a plugin binds for a draw, by sampler name. */
function bound(plugin: MaterialPluginBase, scene: Scene): string[] {
  const textures: string[] = [];
  const ubo = { updateFloat4: () => undefined, setTexture: (name: string) => textures.push(name) };
  plugin.bindForSubMesh(ubo as never, scene, scene.getEngine(), null as never);
  return textures;
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
    const plugin = placement(mesh);
    expect(plugin.getClassName()).toBe("MycoKernelParticlePlugin");
    const textures = bound(plugin, scene);
    expect(textures).toContain("kpidx"); // alpha blending sorts by default: the sorted pairs are bound
    expect(textures.filter((t) => /^kps\d$/.test(t))).toHaveLength(4); // the JavaScript executor's four state textures
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

  it("splices placement code into both shading languages, with a define that differs per output", async () => {
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
    // Two systems drawing with the same material asset, their outputs placing particles differently.
    const other = graph("materials/fx.material.json");
    addBlock(other, other.systems[0], "output", "attribute.size", { mode: "multiply", value: 2 });
    player.sync([fakeSystem(graph("materials/fx.material.json")), { ...fakeSystem(other), node: { name: "Gx" } } as unknown as ParticleSystem], 1 / 30, 1 / 30);
    const meshOf = (name: string) => scene.meshes.find((m) => m.name.startsWith(`particles:${name}:`))!;
    // What Babylon compiles for each draw's material (GLSL on this NullEngine): the placement code in the
    // vertex shader, after Babylon's own position update, and a define of its own per output.
    const [a, b] = await Promise.all([meshOf("Fx"), meshOf("Gx")].map((m) => shaderText(m.material!, m)));
    for (const t of [a, b]) {
      expect(t.vertex).toContain("uniform highp sampler2D kps0;");
      const place = t.vertex.indexOf("k_kpPlace(positionUpdated, normalUpdated, gl_InstanceID);");
      expect(place).toBeGreaterThan(t.vertex.indexOf("vec3 positionUpdated"));
      expect(t.vertex.indexOf("worldPos = vec4(positionUpdated, 1.0);")).toBeGreaterThan(place);
    }
    const kernelDefine = (defines: string) => /#define MYCO_KERNEL_PARTICLES (\d+)/.exec(defines)?.[1];
    expect(kernelDefine(a.defines)).toMatch(/^[1-9]/);
    expect(kernelDefine(a.defines)).not.toBe(kernelDefine(b.defines));
  });

  it("warms kernel emitters' own draws (and pipelines) besides the CPU ones", () => {
    material = null;
    const effect = graphJSON(graph("", { trail: true }));
    const parts = player.warm(effect, "warm:fx", { x: 0, y: 0, z: 0 }, camera)!;
    expect(parts.systems).toHaveLength(0); // no CPU draw for the kernel system
    expect(parts.meshes).toHaveLength(2); // the quad output and the trail
    for (const m of parts.meshes) expect(m.forcedInstanceCount).toBe(64);
    const meshes = scene.meshes.length;
    parts.dispose();
    expect(scene.meshes.length).toBe(meshes - 2);
  });

  it("warms a material-asset kernel output with its material copy", () => {
    const parts = player.warm(graphJSON(graph("materials/fx.material.json")), "warm:fx", { x: 0, y: 0, z: 0 }, camera)!;
    expect(parts.meshes).toHaveLength(1);
    expect(parts.meshes[0]!.material?.pluginManager?.getPlugin("MycoKernelParticles")).toBeTruthy();
    parts.dispose();
  });
});
