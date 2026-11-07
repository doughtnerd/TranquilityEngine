// ADR 0075 stage 7: the editor's preview renderers on the Babylon backend
// (render/babylon/previews/), run headless on Babylon's NullEngine. What a thumbnail draws (its scene:
// meshes, materials, lights, camera, particle systems) is checked here. Pixels are not: NullEngine draws
// nothing, so the GPU output is checked by hand in a browser with WebGPU (see the stage 7 notes in
// docs/decisions/0075).
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { ParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../scene/Assets";
import { lookAtRotation } from "../render/babylon/previews/common";
import { ThumbnailRenderer } from "../render/babylon/previews/ThumbnailRenderer";
import { MaterialPreview } from "../render/previewRouting";

/** The scene's Babylon particle systems (CPU ones, which hold their particle list). */
const systems = (scene: Scene) => scene.particleSystems as ParticleSystem[];

const campfire = JSON.parse(readFileSync(new URL("../../../samples/playground3d/effects/campfire.particles.json", import.meta.url), "utf8"));

const project = {
  "m.material.json": { format: "myco.material@1", color: "#d9332b", roughness: 0.4, metalness: 0.2 },
  "u.material.json": { format: "myco.material@1", shader: "unlit", color: "#00ff00" },
  "g.shadergraph.json": readFileSync(new URL("../../../samples/playground3d/shaders/pulse.shadergraph.json", import.meta.url), "utf8"),
  "gm.material.json": { format: "myco.material@1", shader: "asset:g.shadergraph.json" },
  "c.particles.json": campfire,
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
};

describe("Babylon preview renderers (ADR 0075 stage 7)", () => {
  let engine: NullEngine;
  let renderer: ThumbnailRenderer;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Assets.clearSources();
    Assets.addSource({
      has: (p) => p in project,
      get: (p) => {
        const v = project[p as keyof typeof project];
        return typeof v === "string" ? JSON.parse(v) : v;
      },
    });
    engine = new NullEngine();
    renderer = ThumbnailRenderer.forEngine(engine, 64, { studio: false, readyTimeout: 20 });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    renderer.dispose();
    warn.mockRestore();
    Assets.clearSources();
  });

  describe("thumbnail scenes", () => {
    it("draws a model with its own materials, lit by a sun and ambient light, framed by a camera", async () => {
      const p = (await renderer.prepare("model", "builtin:cube", false))!;
      expect(p).not.toBeNull();
      expect(p.scene.useRightHandedSystem).toBe(true);
      expect(p.scene.meshes).toHaveLength(1);
      expect(p.scene.meshes[0].material).toBeInstanceOf(PBRMaterial);
      expect(p.scene.lights.map((l) => l.getClassName()).sort()).toEqual(["DirectionalLight", "HemisphericLight"]);
      expect(p.scene.activeCamera).toBe(p.camera);
      // The cube's centre is the target, and the camera looks at it from the front-right-above.
      expect(p.target.every((v) => Math.abs(v) < 1e-6)).toBe(true);
      expect(p.camera.position.x).toBeGreaterThan(0);
      expect(p.camera.position.y).toBeGreaterThan(0);
      expect(p.camera.position.z).toBeGreaterThan(0);
      p.dispose();
    });

    it("draws a material on a sphere, with its colour, metalness and roughness", async () => {
      const p = (await renderer.prepare("material", "m.material.json", false))!;
      expect(p.scene.meshes).toHaveLength(1);
      const m = p.scene.meshes[0].material as PBRMaterial;
      expect(m.metallic).toBeCloseTo(0.2);
      expect(m.roughness).toBeCloseTo(0.4);
      expect(m.albedoColor.r).toBeGreaterThan(m.albedoColor.g); // red, in linear light
      expect(m.sideOrientation).toBe(PBRMaterial.CounterClockWiseSideOrientation); // ADR 0075 stage 1
      p.dispose();
    });

    it("draws an unlit material unlit", async () => {
      const p = (await renderer.prepare("material", "u.material.json", false))!;
      expect((p.scene.meshes[0].material as PBRMaterial).unlit).toBe(true);
      p.dispose();
    });

    it("draws a shader graph, and a material that uses one, on a sphere; a graph that uses Time steps its clock", async () => {
      for (const [kind, path] of [["shadergraph", "g.shadergraph.json"], ["material", "gm.material.json"]] as const) {
        const p = (await renderer.prepare(kind, path, true))!;
        expect(p).not.toBeNull();
        expect(p.scene.meshes).toHaveLength(1);
        expect(p.scene.meshes[0].material?.name).toMatch(/^preview:/);
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

    it("draws a particle effect's emitters one second in, and animates only when live", async () => {
      const still = (await renderer.prepare("particles", "c.particles.json", false))!;
      expect(systems(still.scene).length).toBeGreaterThanOrEqual(3); // the campfire's three systems
      expect(systems(still.scene).reduce((n, ps) => n + ps.particles.length, 0)).toBeGreaterThan(0);
      expect(still.step).toBeUndefined();
      expect(still.matte).toBe(true); // its transparency is recovered from two draws
      still.dispose();
      const live = (await renderer.prepare("particles", "c.particles.json", true))!;
      expect(live.step).toBeTypeOf("function");
      live.step!(1 / 30);
      live.dispose();
    });

    it("simulates the same particles every time", async () => {
      const count = async () => {
        const p = (await renderer.prepare("particles", "c.particles.json", false))!;
        const n = systems(p.scene).map((ps) => ps.particles.map((q) => q.position.x.toFixed(4)).join());
        p.dispose();
        return n;
      };
      expect(await count()).toEqual(await count());
    });

    it("draws a prefab's meshes at their world transforms, with a child's offset and scale", async () => {
      const p = (await renderer.prepare("prefab", "p.prefab.json", false))!;
      expect(p.scene.meshes).toHaveLength(2);
      const cube = p.scene.meshes.find((m) => m.name.includes(":a:"))!;
      const ball = p.scene.meshes.find((m) => m.name.includes(":b:"))!;
      expect(cube.getAbsolutePosition().x).toBeCloseTo(4);
      // B sits 2 up in A's space, which A turned 90° about Y: still 2 up, and at A's position.
      expect(ball.getAbsolutePosition().x).toBeCloseTo(4);
      expect(ball.getAbsolutePosition().y).toBeCloseTo(2);
      expect((cube.material as PBRMaterial).metallic).toBeCloseTo(0.2); // its material asset
      // The camera looks at the middle of both, which is off the origin.
      expect(p.target[0]).toBeGreaterThan(3);
      p.dispose();
    });

    it("draws a scene from its main camera, with its own lights and its prefab instances (ADR 0117)", async () => {
      const p = (await renderer.prepare("scene", "s.scene.json", false))!;
      expect(p.scene.meshes).toHaveLength(2); // the instance's two meshes
      expect(p.scene.lights).toHaveLength(1); // the scene's sun replaced the defaults
      expect(p.scene.lights[0]!.intensity).toBeCloseTo(2);
      // The lowest-depth camera: orthographic, at x = 3, looking down -Z.
      expect(p.camera.mode).toBe(1);
      expect(p.camera.position.x).toBeCloseTo(3);
      expect(p.scene.clearColor.r).toBeGreaterThan(0.9);
      p.dispose();
    });

    it("gives up (and warns once) on an asset it can't draw", async () => {
      expect(await renderer.prepare("prefab", "empty.prefab.json", false)).toBeNull();
      expect(await renderer.prepare("material", "nope.material.json", false)).toBeNull();
      expect(await renderer.prepare("environment", "nope.hdr", false)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("makes a scene of its own per thumbnail and frees it on dispose", async () => {
      const a = (await renderer.prepare("model", "builtin:cube", false))!;
      const b = (await renderer.prepare("model", "builtin:sphere", false))!;
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

describe("camera aiming (ADR 0014: cameras look down -Z)", () => {
  const forward = (q: Quaternion) => new Vector3(0, 0, -1).applyRotationQuaternion(q);

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
    expect(preview.readCenter()).toBeNull(); // nothing drawn yet
    preview.onShaderError = () => undefined;
    preview.dispose(); // before the module arrives: it never builds
  });
});
