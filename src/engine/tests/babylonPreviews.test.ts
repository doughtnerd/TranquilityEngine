// ADR 0075 stage 7: the editor's preview renderers on the Babylon backend
// (render/babylon/previews/), run headless on Babylon's NullEngine. What a thumbnail draws (its scene:
// meshes, materials, lights, camera, particle systems) is checked here. Pixels are not: NullEngine draws
// nothing, so the GPU output is checked by hand in a browser with WebGPU (see the stage 7 notes in
// docs/decisions/0075).
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../scene/Assets";
import { lookAtRotation } from "../render/babylon/lookAt";
import { ThumbnailRenderer } from "../render/babylon/previews/ThumbnailRenderer";
import { ThumbnailScenes } from "../render/babylon/previews/thumbnailScenes";
import { MaterialPreview } from "../render/previewRouting";

/**
 * `ThumbnailRenderer.create` makes its engine with the engine factory (`createEngine`, ADR 0244: WebGPU, else
 * WebGL2): here it gets a NullEngine, kept so a test can take its context away.
 */
const previewEngines = vi.hoisted(() => [] as NullEngine[]);
vi.mock("../render/babylon/createEngine", async () => {
  const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
  return { createEngine: async () => previewEngines[previewEngines.push(new NullEngine()) - 1] };
});

/** The scene's Babylon particle systems (CPU ones, which hold their particle list). */
/** The meshes drawing a particle thumbnail's effect (one per kernel output, ADR 0251). */
const particleDraws = (scene: Scene) => scene.meshes.filter((m) => m.name.startsWith("particles:thumbnail:"));

const campfire = JSON.parse(readFileSync(new URL("../../../samples/playground3d/effects/campfire.particles.json", import.meta.url), "utf8"));

const project = {
  "m.material.json": { format: "myco.material@1", color: "#d9332b", roughness: 0.4, metalness: 0.2 },
  "u.material.json": { format: "myco.material@1", shader: "unlit", color: "#00ff00" },
  "g.shadergraph.json": readFileSync(new URL("../../../samples/playground3d/shaders/pulse.shadergraph.json", import.meta.url), "utf8"),
  "gm.material.json": { format: "myco.material@1", shader: "asset:g.shadergraph.json" },
  "c.particles.json": campfire,
  // The campfire with its first emitter drawing a material asset.
  "cm.particles.json": { ...campfire, systems: campfire.systems.map((s: { output: { settings: object } }, i: number) => (i === 0 ? { ...s, output: { ...s.output, settings: { ...s.output.settings, material: "asset:m.material.json" } } } : s)) },
  "p.prefab.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [4, 0, 0], rotation: [0, 90, 0] } }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube", material: "asset:m.material.json" } }] },
      { id: "b", name: "B", parent: "a", components: [{ type: "engine.Transform", data: { position: [0, 2, 0], scale: [0.5, 0.5, 0.5] } }, { type: "engine.MeshRenderer", data: { mesh: "builtin:sphere" } }] },
    ],
  },
  "s.scene.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "cam", components: [{ type: "engine.Transform", data: { position: [0, 2, 10] } }, { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 40, depth: 1 } }] },
      { id: "main", components: [{ type: "engine.Transform", data: { position: [3, 0, 0] } }, { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 4, backgroundColor: "#ff0000", depth: 0 } }] },
      { id: "sun", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "directional", intensity: 2 } }] },
      { id: "inst", prefab: "p.prefab.json" },
    ],
  },
  "empty.prefab.json": { format: "myco.scene@1", nodes: [{ id: "a", name: "A", components: [] }] },
  // An .obj's material library, served as a URL like every file that isn't JSON or text (ADR 0254).
  "lib.mtl": `data:model/mtl;base64,${Buffer.from("newmtl Wood\nKd 0.72 0.50 0.28\nNs 20\n\nnewmtl Paint\nKd 0.1 0.2 0.9\n").toString("base64")}`,
};

describe("Babylon preview renderers (ADR 0075 stage 7)", () => {
  let engine: NullEngine;
  let renderer: ThumbnailRenderer;
  /** What each thumbnail draws (the renderer draws and captures these), on an engine of their own. */
  let scenes: ThumbnailScenes;
  let scenesEngine: NullEngine;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource({
      has: (p) => p in project,
      get: (p) => {
        const v = project[p as keyof typeof project];
        return typeof v === "string" && p.endsWith(".json") ? JSON.parse(v) : v;
      },
    });
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0 }) }); // the renderer's offscreen canvas
    renderer = await ThumbnailRenderer.create(64, { studio: false, readyTimeout: 20 });
    vi.unstubAllGlobals();
    engine = previewEngines.at(-1)!;
    scenesEngine = new NullEngine();
    scenes = new ThumbnailScenes(scenesEngine, 64, { studio: false, readyTimeout: 20 });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    scenes.dispose();
    scenesEngine.dispose();
    renderer.dispose();
    warn.mockRestore();
    Assets.clearSources();
  });

  describe("thumbnail scenes", () => {
    it("draws a model with its own materials, lit by a sun and ambient light, framed by a camera", async () => {
      const p = (await scenes.prepare("model", "builtin:cube", false))!;
      expect(p).not.toBeNull();
      expect(p.scene.useRightHandedSystem).toBe(false); // Babylon's default left-handed mode (ADR 0164)
      expect(p.scene.meshes).toHaveLength(1);
      expect(p.scene.meshes[0].material).toBeInstanceOf(PBRMaterial);
      expect(p.scene.lights.map((l) => l.getClassName()).sort()).toEqual(["DirectionalLight", "HemisphericLight"]);
      expect(p.scene.activeCamera).toBe(p.camera);
      // The cube's centre is the target, and the camera looks at it from in front (+Z, where a model
      // faces), above and to its right: models are mirrored in x on import (ADR 0164).
      expect(p.target.every((v) => Math.abs(v) < 1e-6)).toBe(true);
      expect(p.camera.position.x).toBeLessThan(0);
      expect(p.camera.position.y).toBeGreaterThan(0);
      expect(p.camera.position.z).toBeGreaterThan(0);
      p.dispose();
    });

    it("draws a material library (.mtl) as a sphere per material, each in its own colour", async () => {
      const p = (await scenes.prepare("model", "lib.mtl", false))!;
      expect(p).not.toBeNull();
      expect(p.scene.meshes).toHaveLength(2);
      const colours = p.scene.meshes.map((m) => (m.material as PBRMaterial).albedoColor);
      // Wood is warm, Paint is blue (in either order: the meshes are named after the materials).
      const byName = new Map(p.scene.meshes.map((m, i) => [m.name, colours[i]]));
      const wood = [...byName].find(([n]) => n.includes("Wood"))![1];
      const paint = [...byName].find(([n]) => n.includes("Paint"))![1];
      expect(wood.r).toBeGreaterThan(wood.b);
      expect(paint.b).toBeGreaterThan(paint.r);
      p.dispose();
    });

    it("draws a material on a sphere, with its colour, metalness and roughness", async () => {
      const p = (await scenes.prepare("material", "m.material.json", false))!;
      expect(p.scene.meshes).toHaveLength(1);
      const m = p.scene.meshes[0].material as PBRMaterial;
      expect(m.metallic).toBeCloseTo(0.2);
      expect(m.roughness).toBeCloseTo(0.4);
      expect(m.albedoColor.r).toBeGreaterThan(m.albedoColor.g); // red, in linear light
      expect(m.sideOrientation).toBeNull(); // the scene's default front face (ADR 0164)
      p.dispose();
    });

    it("draws an unlit material unlit", async () => {
      const p = (await scenes.prepare("material", "u.material.json", false))!;
      expect((p.scene.meshes[0].material as PBRMaterial).unlit).toBe(true);
      p.dispose();
    });

    it("draws a shader graph, and a material that uses one, on a sphere; a graph that uses Time steps its clock", async () => {
      for (const [kind, path] of [["shadergraph", "g.shadergraph.json"], ["material", "gm.material.json"]] as const) {
        const p = (await scenes.prepare(kind, path, true))!;
        expect(p).not.toBeNull();
        expect(p.scene.meshes).toHaveLength(1);
        expect(p.scene.meshes[0].material?.name).toMatch(/^graph:g\.shadergraph\.json$/); // built by the preview scene's material library (ADR 0127)
        expect(p.step).toBeTypeOf("function");
        p.step!(0.1);
        p.dispose();
      }
      expect(renderer.canAnimate("shadergraph", "g.shadergraph.json")).toBe(true);
      expect(renderer.canAnimate("material", "gm.material.json")).toBe(true);
      expect(renderer.canAnimate("material", "m.material.json")).toBe(false);
      expect(renderer.canAnimate("model", "builtin:cube")).toBe(false);
      expect(renderer.canAnimate("particles", "c.particles.json")).toBe(true);
    });

    it("draws a particle effect's systems one second in, framed on the particles alive, and animates only when live", async () => {
      const still = (await scenes.prepare("particles", "c.particles.json", false))!;
      expect(particleDraws(still.scene)).toHaveLength(3); // the campfire's three systems
      expect(still.scene.particleSystems).toHaveLength(0);
      // Framed on the particles (the flames low, the smoke high), not the default box around the origin.
      expect(still.target).not.toEqual([0, 1, 0]);
      expect(still.step).toBeUndefined();
      expect(still.matte).toBe(true); // its transparency is recovered from two draws
      still.dispose();
      const live = (await scenes.prepare("particles", "c.particles.json", true))!;
      expect(live.step).toBeTypeOf("function");
      live.step!(1 / 30);
      live.dispose();
    });

    it("draws a system that has a material asset with a copy of that material", async () => {
      const plain = (await scenes.prepare("particles", "c.particles.json", false))!;
      const withMaterial = (await scenes.prepare("particles", "cm.particles.json", false))!;
      const placed = (scene: Scene) => particleDraws(scene).filter((m) => m.material instanceof PBRMaterial && m.material.pluginManager?.getPlugin("MycoKernelParticles"));
      expect(placed(withMaterial.scene)).toHaveLength(1);
      expect((placed(withMaterial.scene)[0].material as PBRMaterial).metallic).toBeCloseTo(0.2); // the asset's
      expect(placed(plain.scene)).toHaveLength(0);
      plain.dispose();
      withMaterial.dispose();
    });

    it("simulates the same particles every time (the same framing)", async () => {
      const framing = async () => {
        const p = (await scenes.prepare("particles", "c.particles.json", false))!;
        const at = [...p.target, ...p.camera.position.asArray()].map((v) => v.toFixed(5));
        p.dispose();
        return at;
      };
      expect(await framing()).toEqual(await framing());
    });

    it("draws a prefab's meshes at their world transforms, with a child's offset and scale (through the Meshes feature, ADR 0153)", async () => {
      const p = (await scenes.prepare("prefab", "p.prefab.json", false))!;
      const drawn = p.scene.meshes.filter((m) => m.name.startsWith("mesh:") && m.isEnabled());
      expect(drawn).toHaveLength(2);
      const cube = drawn.find((m) => m.name.startsWith("mesh:A"))!;
      const ball = drawn.find((m) => m.name.startsWith("mesh:B"))!;
      expect(cube.getAbsolutePosition().x).toBeCloseTo(4);
      // B sits 2 up in A's space, which A turned 90° about Y: still 2 up, and at A's position.
      expect(ball.getAbsolutePosition().x).toBeCloseTo(4);
      expect(ball.getAbsolutePosition().y).toBeCloseTo(2);
      expect((cube.material as PBRMaterial).metallic).toBeCloseTo(0.2); // its material asset
      // The camera looks at the middle of both, which is off the origin.
      expect(p.target[0]).toBeGreaterThan(3);
      p.dispose();
    });

    it("draws a scene from its main camera, with its own lights and its prefab instances (ADR 0117, 0153)", async () => {
      const p = (await scenes.prepare("scene", "s.scene.json", false))!;
      expect(p.scene.meshes.filter((m) => m.name.startsWith("mesh:") && m.isEnabled())).toHaveLength(2); // the instance's two meshes
      const lit = p.scene.lights.filter((l) => l.isEnabled() && l.intensity > 0);
      expect(lit).toHaveLength(1); // the scene's sun replaced the default lights
      expect(lit[0]!.intensity).toBeCloseTo(2);
      // The lowest-depth camera: orthographic, at x = 3, looking along +Z.
      expect(p.camera.mode).toBe(1);
      expect(p.camera.position.x).toBeCloseTo(3);
      expect(p.scene.clearColor.r).toBeGreaterThan(0.9);
      p.dispose();
    });

    it("gives up (and warns once) on an asset it can't draw", async () => {
      expect(await scenes.prepare("prefab", "empty.prefab.json", false)).toBeNull();
      expect(await scenes.prepare("material", "nope.material.json", false)).toBeNull();
      expect(await scenes.prepare("environment", "nope.hdr", false)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("makes a scene of its own per thumbnail and frees it on dispose", async () => {
      const a = (await scenes.prepare("model", "builtin:cube", false))!;
      const b = (await scenes.prepare("model", "builtin:sphere", false))!;
      expect(a.scene).not.toBe(b.scene);
      a.dispose();
      expect(a.scene.isDisposed).toBe(true);
      expect(b.scene.isDisposed).toBe(false);
      b.dispose();
    });
  });

  describe("hover animation and the Inspector's preview", () => {
    /** A stand-in for a 2D canvas: the renderer only reads its size and whether it's in the document. */
    const target = (w = 64, h = 64) => ({ width: w, height: h, isConnected: true, getContext: () => null }) as unknown as HTMLCanvasElement;

    it("runs an animation until it's stopped, and calls onFrame after the first frame", async () => {
      vi.useFakeTimers();
      try {
        const onFrame = vi.fn();
        const stop = renderer.animate("particles", "c.particles.json", target(), onFrame);
        await vi.advanceTimersByTimeAsync(200);
        expect(onFrame).toHaveBeenCalledTimes(1);
        stop();
        stop(); // twice is harmless
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps tiles still while a preview is open, and starts animating again after it stops", async () => {
      const preview = renderer.preview("model", "builtin:cube", target(300, 200));
      expect(await preview.ready).toBe(true);
      const onFrame = vi.fn();
      renderer.animate("particles", "c.particles.json", target(), onFrame)(); // refused: the preview has the renderer
      expect(onFrame).not.toHaveBeenCalled();
      preview.orbit(0.5, 0.1);
      preview.zoom(0.5);
      preview.reset();
      preview.redraw();
      preview.stop();
      const stop = renderer.animate("particles", "c.particles.json", target(), onFrame);
      expect(typeof stop).toBe("function");
      stop();
    });

    it("posed preview (T18b): steps a World of the plugin's nodes every frame until it stops, and draws what the World holds", async () => {
      vi.useFakeTimers();
      try {
        const worlds = new Set<unknown>();
        const frame = vi.fn((world: unknown) => void worlds.add(world));
        const scene = { format: "myco.scene@5", nodes: [{ id: "a", name: "Cube", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] }] };
        const preview = renderer.previewPosed({ key: "cube", scene, frame }, target(300, 200));
        await vi.advanceTimersByTimeAsync(100);
        expect(await preview.ready).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        expect(frame.mock.calls.length).toBeGreaterThan(2); // asked before each frame's step
        expect(worlds.size).toBe(1); // one World, the preview's
        preview.orbit(0.5, 0.1);
        preview.stop();
        const calls = frame.mock.calls.length;
        await vi.advanceTimersByTimeAsync(300);
        expect(frame.mock.calls.length).toBe(calls); // stopped: nothing steps any more
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps an open preview drawing while another opens and after it closes (the Inspector's and the Sky panel's)", async () => {
      vi.useFakeTimers();
      try {
        const scene = { format: "myco.scene@5", nodes: [{ id: "a", name: "Cube", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] }] };
        const inspectorFrame = vi.fn();
        const panelFrame = vi.fn();
        const inspector = renderer.previewPosed({ key: "inspector", scene, frame: inspectorFrame }, target(300, 200));
        await vi.advanceTimersByTimeAsync(100);
        expect(await inspector.ready).toBe(true);
        const panel = renderer.previewPosed({ key: "panel", scene, frame: panelFrame }, target(400, 300));
        await vi.advanceTimersByTimeAsync(100);
        expect(await panel.ready).toBe(true);
        // Both draw at once.
        let before = [inspectorFrame.mock.calls.length, panelFrame.mock.calls.length];
        await vi.advanceTimersByTimeAsync(300);
        expect(inspectorFrame.mock.calls.length).toBeGreaterThan(before[0]);
        expect(panelFrame.mock.calls.length).toBeGreaterThan(before[1]);
        // The panel closes: the Inspector's goes on, and tiles stay still while it's open.
        panel.stop();
        before = [inspectorFrame.mock.calls.length, panelFrame.mock.calls.length];
        await vi.advanceTimersByTimeAsync(300);
        expect(inspectorFrame.mock.calls.length).toBeGreaterThan(before[0]);
        expect(panelFrame.mock.calls.length).toBe(before[1]);
        const onFrame = vi.fn();
        renderer.animate("particles", "c.particles.json", target(), onFrame);
        await vi.advanceTimersByTimeAsync(200);
        expect(onFrame).not.toHaveBeenCalled();
        inspector.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a posed preview with nothing to draw as not ready", async () => {
      const scene = { format: "myco.scene@5", nodes: [{ id: "a", name: "A", components: [] }] };
      expect(await renderer.previewPosed({ key: "empty", scene }, target()).ready).toBe(false);
    });

    it("reports a preview that can't be drawn as not ready", async () => {
      expect(await renderer.preview("prefab", "empty.prefab.json", target()).ready).toBe(false);
    });
  });

  it("forgets nothing to clear, and refuses work once the context is lost", async () => {
    const lost = vi.fn();
    renderer.onContextLost(lost);
    renderer.clearCaches();
    engine.onContextLostObservable.notifyObservers(engine);
    expect(renderer.lost).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    renderer.onContextLost(later); // already lost: runs at once
    expect(later).toHaveBeenCalledTimes(1);
    expect(await renderer.render("model", "builtin:cube")).toBeNull();
  });
});

describe("camera aiming (ADR 0164: cameras look along +Z)", () => {
  const forward = (q: Quaternion) => new Vector3(0, 0, 1).applyRotationQuaternion(q);

  it("turns a camera at `eye` to face `target`, +Y up", () => {
    const cases: [number[], number[]][] = [
      [[0, 0, 5], [0, 0, 0]],
      [[5, 0, 0], [0, 0, 0]],
      [[0, 4, 0.001], [0, 0, 0]],
      [[1, 2, 3], [-2, 0.5, 1]],
    ];
    for (const [eye, target] of cases) {
      const want = new Vector3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]).normalize();
      const got = forward(lookAtRotation(eye, target));
      expect(got.x).toBeCloseTo(want.x, 4);
      expect(got.y).toBeCloseTo(want.y, 4);
      expect(got.z).toBeCloseTo(want.z, 4);
    }
  });

  it("keeps the camera upright", () => {
    const up = new Vector3(0, 1, 0).applyRotationQuaternion(lookAtRotation([3, 1, 4], [0, 0, 0]));
    expect(up.y).toBeGreaterThan(0);
    const right = new Vector3(1, 0, 0).applyRotationQuaternion(lookAtRotation([3, 1, 4], [0, 0, 0]));
    expect(right.y).toBeCloseTo(0, 5); // no roll
    // Left-handed: a camera in front of the origin at -Z, looking along +Z, has +X on its right.
    const r = new Vector3(1, 0, 0).applyRotationQuaternion(lookAtRotation([0, 0, -5], [0, 0, 0]));
    expect(r.x).toBeCloseTo(1, 5);
  });

  it("copes with looking straight down", () => {
    const f = forward(lookAtRotation([0, 5, 0], [0, 0, 0]));
    expect(f.y).toBeCloseTo(-1, 4);
  });
});

describe("the shader graph preview while Babylon loads (routing)", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?renderer=babylon" });
    const el = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, remove() {}, appendChild() {}, isConnected: false });
    vi.stubGlobal("document", { createElement: el });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the graph compiled to WGSL at once, before the preview exists", async () => {
    const { parseShaderGraph } = await import("../scene/shaderGraph");
    const graph = parseShaderGraph(JSON.parse(project["g.shadergraph.json"]), "g").graph;
    const preview = new MaterialPreview({ appendChild() {} } as unknown as HTMLElement);
    const compiled = preview.setGraph(graph);
    expect(compiled.fragment.body).toMatch(/^var mOut_baseColor: vec3f/m); // WGSL
    preview.onShaderError = () => undefined;
    preview.dispose(); // before the module arrives: it never builds
  });
});
