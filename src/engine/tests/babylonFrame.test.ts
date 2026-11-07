// ADR 0075 stage 3: the finish pass and each camera's pass layout on the Babylon backend, without a GPU.
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { describe, expect, it } from "vitest";
import { cameraPasses, setCasters } from "../render/babylon/frameGraph";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { matrixChanged } from "../render/babylon/BabylonRenderer";
import { FINISH_SHADER, FINISH_UNIFORMS } from "../render/babylon/finishShader";
import type { PostEffects } from "../render/postEffects";

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

  it("keeps its uniform list read-only (Babylon appends the vertex stage's 'scale' to the list it's given)", () => {
    expect(Object.isFrozen(FINISH_UNIFORMS)).toBe(true);
    expect(FINISH_UNIFORMS).not.toContain("scale");
  });
});

describe("a camera's passes (ADR 0075 stage 3)", () => {
  const effects = (overrides: Partial<PostEffects>): PostEffects => ({
    toneMapping: "agx",
    exposure: 1,
    antialias: "off",
    bloom: null,
    ambientOcclusion: null,
    colorGrading: null,
    vignette: null,
    depthOfField: null,
    chromaticAberration: null,
    ...overrides,
  });

  it("are clear, render and finish without effects", () => {
    expect(cameraPasses(null)).toEqual(["clear", "render", "finish"]);
    // Grading, the vignette and tone mapping happen in the finish pass.
    expect(cameraPasses(effects({ colorGrading: { brightness: 0.1, contrast: 0, saturation: 0, hue: 0 }, vignette: { darkness: 0.5, offset: 0.5 } }))).toEqual(["clear", "render", "finish"]);
  });

  it("add each effect, with a geometry pass for ambient occlusion and depth of field", () => {
    const all = effects({
      bloom: { intensity: 1, threshold: 0.9, radius: 0.85 },
      ambientOcclusion: { intensity: 2, radius: 1, quality: "medium" },
      depthOfField: { focusDistance: 10, focusRange: 5, bokehScale: 2 },
      chromaticAberration: { amount: 0.002 },
    });
    expect(cameraPasses(all)).toEqual(["clear", "geometry", "render", "ao", "dof", "bloom", "ca", "finish"]);
    expect(cameraPasses(effects({ depthOfField: { focusDistance: 10, focusRange: 5, bokehScale: 2 } }))).toEqual(["clear", "geometry", "render", "dof", "finish"]);
  });

  it("add a depth pass before the render pass when something asks for the scene depth (ADR 0109)", () => {
    expect(cameraPasses(null, true)).toEqual(["clear", "geometry", "render", "finish"]);
    // Shared with ambient occlusion: one geometry pass.
    expect(cameraPasses(effects({ ambientOcclusion: { intensity: 2, radius: 1, quality: "medium" } }), true)).toEqual(["clear", "geometry", "render", "ao", "finish"]);
  });

  it("end with FXAA on tiers with FXAA or SMAA, not MSAA", () => {
    expect(cameraPasses(effects({ antialias: "smaa" }))).toEqual(["clear", "render", "finish", "fxaa"]);
    expect(cameraPasses(effects({ antialias: "fxaa" }))).toEqual(["clear", "render", "finish", "fxaa"]);
    expect(cameraPasses(effects({ antialias: "msaa" }))).toEqual(["clear", "render", "finish"]);
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
      effects: { toneMapping: "agx", exposure: 1, antialias: "off", bloom: null, ambientOcclusion: { intensity: 1, radius: 1, quality: "high" }, colorGrading: null, vignette: null, depthOfField: null, chromaticAberration: null } as PostEffects,
      toneMapping: "agx" as const,
      exposure: 1,
    };
    try {
      frame.render([view], [], [], 1); // builds the tasks; the GPU build itself fails on NullEngine, and is logged
      const views = (frame as unknown as { views: { geometry: { depthTexture?: number; _frameGraph: { tasks: { name: string }[] } } | null }[] }).views;
      const geometry = views[0].geometry!;
      expect(geometry.depthTexture).toBeDefined();
      const names = geometry._frameGraph.tasks.map((t) => t.name);
      expect(names).toContain("geometryClear0");
      expect(names.indexOf("geometryClear0")).toBeLessThan(names.indexOf("geometry0"));
    } finally {
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
    expect(setCasters(list, [a, b])).toBe(true);
    expect(setCasters(list, [a, b])).toBe(false);
    expect(calls).toEqual(["splice"]);
    expect(setCasters(list, [a, c])).toBe(true);
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
