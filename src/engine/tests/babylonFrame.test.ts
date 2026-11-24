// ADR 0075 stage 3: the finish pass, and the frame graph each camera's pass plan builds (ADR 0274) on the Babylon backend, without a GPU.
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { describe, expect, it, vi } from "vitest";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph.js";
import type { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { matrixChanged, refillIfChanged } from "../render/changeDetection";
import { FINISH_SAMPLERS, FINISH_SHADER, FINISH_UNIFORMS } from "../render/babylon/finishShader";
import { AO_SETTINGS, type PostEffects } from "../render/postEffects";

describe("the finish pass (ADR 0075)", () => {
  it("is registered in WGSL and GLSL, each declaring every uniform", () => {
    const wgsl = ShaderStore.ShadersStoreWGSL[`${FINISH_SHADER}PixelShader`];
    const glsl = ShaderStore.ShadersStore[`${FINISH_SHADER}PixelShader`];
    expect(wgsl).toBeTruthy();
    expect(glsl).toBeTruthy();
    for (const u of FINISH_UNIFORMS) {
      expect(wgsl).toContain(`uniform ${u}: vec4f;`);
      expect(glsl).toContain(`uniform vec4 ${u};`);
    }
  });

  it("declares the colour lookup table's sampler in both languages (ADR 0111)", () => {
    const wgsl = ShaderStore.ShadersStoreWGSL[`${FINISH_SHADER}PixelShader`];
    const glsl = ShaderStore.ShadersStore[`${FINISH_SHADER}PixelShader`];
    for (const s of FINISH_SAMPLERS) {
      expect(wgsl).toContain(`var ${s}: texture_2d<f32>;`);
      expect(glsl).toContain(`uniform sampler2D ${s};`);
    }
  });

  it("runs ambient occlusion at half resolution on low and medium, full on high and ultra (ADR 0111)", () => {
    expect([AO_SETTINGS.low.ratio, AO_SETTINGS.medium.ratio, AO_SETTINGS.high.ratio, AO_SETTINGS.ultra.ratio]).toEqual([0.5, 0.5, 1, 1]);
    expect(AO_SETTINGS.ultra.samples).toBeGreaterThan(AO_SETTINGS.high.samples); // ultra used to fall back to 16
  });

  it("keeps its uniform list read-only (Babylon appends the vertex stage's 'scale' to the list it's given)", () => {
    expect(Object.isFrozen(FINISH_UNIFORMS)).toBe(true);
    expect(FINISH_UNIFORMS).not.toContain("scale");
  });
});

describe("the geometry pass's depth (ADR 0075)", () => {
  // Without a depth buffer Babylon's geometry pass draws with no depth test, so ambient occlusion read
  // meshes behind nearer ones and drew their edges through them (seen on the Playground's crates).
  it("gets its own cleared depth buffer when a camera has ambient occlusion or depth of field", async () => {
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    const { Scene } = await import("@babylonjs/core/scene.js");
    const { TargetCamera } = await import("@babylonjs/core/Cameras/targetCamera.js");
    const { Color4 } = await import("@babylonjs/core/Maths/math.color.js");
    const { Vector3 } = await import("@babylonjs/core/Maths/math.vector.js");
    const { BabylonFrame } = await import("../render/babylon/frameGraph");
    const engine = new NullEngine();
    (engine as unknown as { buildTextureLayout(): number[] }).buildTextureLayout = () => []; // used by the object renderer's constructor; NullEngine lacks it
    const scene = new Scene(engine);
    const camera = new TargetCamera("c", Vector3.Zero(), scene);
    const frame = new BabylonFrame(scene);
    const view = {
      camera,
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      clear: new Color4(0, 0, 0, 1),
      effects: { toneMapping: "agx", exposure: 1, antialias: "off", bloom: null, ambientOcclusion: { intensity: 1, radius: 1, quality: "high" }, colorGrading: null, lut: null, vignette: null, depthOfField: null, chromaticAberration: null } as PostEffects,
      toneMapping: "agx" as const,
      exposure: 1,
    };
    // The tasks, in the order the frame adds them to its graph (which runs them in that order).
    const added = vi.spyOn(FrameGraph.prototype, "addTask");
    try {
      frame.render([view], [], [], 1); // builds the tasks; the GPU build itself fails on NullEngine, and is logged
      const tasks = added.mock.calls.map(([task]) => task);
      const geometry = tasks.find((t) => t.name === "geometry0") as FrameGraphGeometryRendererTask;
      expect(geometry.depthTexture).toBeDefined();
      const names = tasks.map((t) => t.name);
      expect(names).toContain("geometryClear0");
      expect(names.indexOf("geometryClear0")).toBeLessThan(names.indexOf("geometry0"));
    } finally {
      added.mockRestore();
      frame.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});

describe("a frame graph build that outlives its frame", () => {
  it("is freed, not installed, when it finishes after the frame was disposed", async () => {
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    const { Scene } = await import("@babylonjs/core/scene.js");
    const { TargetCamera } = await import("@babylonjs/core/Cameras/targetCamera.js");
    const { Color4 } = await import("@babylonjs/core/Maths/math.color.js");
    const { Vector3 } = await import("@babylonjs/core/Maths/math.vector.js");
    const { BabylonFrame } = await import("../render/babylon/frameGraph");
    const engine = new NullEngine();
    (engine as unknown as { buildTextureLayout(): number[] }).buildTextureLayout = () => [];
    const scene = new Scene(engine);
    const camera = new TargetCamera("c", Vector3.Zero(), scene);
    const frame = new BabylonFrame(scene);
    let finish!: () => void;
    const build = vi.spyOn(FrameGraph.prototype, "buildAsync").mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const disposed = vi.spyOn(FrameGraph.prototype, "dispose");
    try {
      frame.render([{ camera, viewport: { x: 0, y: 0, width: 1, height: 1 }, clear: new Color4(0, 0, 0, 1), effects: null, toneMapping: "none", exposure: 1 }], [], [], 1);
      expect(build).toHaveBeenCalledTimes(1);
      frame.dispose(); // the renderer went while the graph was building
      disposed.mockClear();
      finish();
      await new Promise((r) => setTimeout(r, 0));
      expect(scene.frameGraph).toBeNull();
      expect(frame.ready).toBe(false);
      expect(disposed).toHaveBeenCalledTimes(1);
    } finally {
      build.mockRestore();
      disposed.mockRestore();
      scene.dispose();
      engine.dispose();
    }
  });
});

describe("rebuilding the frame graph (ADR 0274)", () => {
  // A rebuilding frame shows the clear colour, so a change the finish pass's uniforms carry must not rebuild.
  it("rebuilds when a camera's pass plan changes, not when only finish-pass values do", async () => {
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    const { Scene } = await import("@babylonjs/core/scene.js");
    const { TargetCamera } = await import("@babylonjs/core/Cameras/targetCamera.js");
    const { Color4 } = await import("@babylonjs/core/Maths/math.color.js");
    const { Vector3 } = await import("@babylonjs/core/Maths/math.vector.js");
    const { BabylonFrame } = await import("../render/babylon/frameGraph");
    const engine = new NullEngine();
    (engine as unknown as { buildTextureLayout(): number[] }).buildTextureLayout = () => [];
    const scene = new Scene(engine);
    const camera = new TargetCamera("c", Vector3.Zero(), scene);
    const frame = new BabylonFrame(scene);
    const fx = (over: Partial<PostEffects>): PostEffects => ({ toneMapping: "agx", exposure: 1, antialias: "off", bloom: null, ambientOcclusion: null, colorGrading: null, lut: null, vignette: null, depthOfField: null, chromaticAberration: null, ...over });
    const view = (effects: PostEffects | null) => ({ camera, viewport: { x: 0, y: 0, width: 1, height: 1 }, clear: new Color4(0, 0, 0, 1), effects, toneMapping: effects?.toneMapping ?? ("none" as const), exposure: 1 });
    const added = vi.spyOn(FrameGraph.prototype, "addTask");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {}); // the GPU build itself fails on NullEngine
    // Each call draws a frame, then lets the (failing) build settle so the next one may rebuild.
    const builds = async (effects: PostEffects | null): Promise<boolean> => {
      added.mockClear();
      frame.render([view(effects)], [], [], 1);
      await vi.waitFor(() => expect(frame.ready || logged.mock.calls.length > 0 || added.mock.calls.length === 0).toBe(true));
      await new Promise((r) => setTimeout(r, 0));
      return added.mock.calls.length > 0;
    };
    try {
      expect(await builds(fx({ bloom: { intensity: 1, threshold: 0.9, radius: 0.85 } }))).toBe(true);
      const bloom = { intensity: 2, threshold: 0.5, radius: 0.3 };
      expect(await builds(fx({ bloom }))).toBe(false);
      expect(await builds(fx({ bloom, vignette: { darkness: 0.6, offset: 0.4 } }))).toBe(false);
      expect(await builds(fx({ bloom, toneMapping: "aces", exposure: 2 }))).toBe(false);
      expect(await builds(fx({ bloom, colorGrading: { brightness: 0.1, contrast: 0, saturation: 0, hue: 0 }, lut: { path: "a.cube", intensity: 1 } }))).toBe(false);
      expect(await builds(fx({ bloom, antialias: "smaa" }))).toBe(true);
      expect(await builds(fx({ bloom, antialias: "fxaa" }))).toBe(false); // SMAA and FXAA are the same pass
      expect(await builds(fx({ antialias: "fxaa" }))).toBe(true); // bloom off
    } finally {
      added.mockRestore();
      logged.mockRestore();
      frame.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});

describe("per-frame work the Babylon backend skips when nothing changed (ADR 0075 notes)", () => {
  it("refills the shadow casters' list only when its meshes change, in one splice", () => {
    const [a, b, c] = [{ id: "a" }, { id: "b" }, { id: "c" }] as unknown as Mesh[];
    const list: Mesh[] = [];
    const calls: string[] = [];
    // Babylon watches a render list's push and splice: count what reaches it.
    for (const name of ["push", "splice"] as const) {
      const f = list[name].bind(list) as (...args: unknown[]) => unknown;
      (list as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        calls.push(name);
        return f(...args);
      };
    }
    expect(refillIfChanged(list, [a, b])).toBe(true);
    expect(refillIfChanged(list, [a, b])).toBe(false);
    expect(calls).toEqual(["splice"]);
    expect(refillIfChanged(list, [a, c])).toBe(true);
    expect([...list]).toEqual([a, c]);
    expect(calls).toEqual(["splice", "splice"]); // never emptied then pushed: an emptied list dirties every mesh
  });

  it("re-freezes a mesh only when its node's world matrix changed", () => {
    const entry = { matrix: null as Float32Array | null };
    const world = new Float32Array(32);
    world.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1], 16);
    expect(matrixChanged(entry, world, 16)).toBe(true); // the first sync freezes it
    expect(Array.from(entry.matrix!)).toEqual(Array.from(world.subarray(16)));
    expect(matrixChanged(entry, world, 16)).toBe(false);
    world[16 + 13] = 6.5;
    expect(matrixChanged(entry, world, 16)).toBe(true);
    expect(entry.matrix![13]).toBe(6.5);
    expect(matrixChanged(entry, world, 16)).toBe(false);
  });
});
