// ADR 0075 stage 7, 0156: the editor's preview renderers on the Babylon backend (render/babylon/previews/),
// run headless on Babylon's NullEngine. The thumbnail renderer's own work is checked here with hand-made
// stages: loading a stage into a World of its own, framing, dressing, stepping, the hover animation, the
// Inspector's preview and losing the context. What each asset kind's stage draws is checked through the
// kinds in `src/plugins/thumbnailStages.test.ts`. Pixels are not: NullEngine draws nothing, so the GPU
// output is checked by hand in a browser with WebGPU (see the stage 7 notes in docs/decisions/0075).
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../scene/Assets";
import type { SceneFile } from "../scene/SceneLoader";
import { lookAtRotation } from "../render/babylon/previews/common";
import { ThumbnailRenderer } from "../render/babylon/previews/ThumbnailRenderer";
import type { ThumbnailStage } from "../render/previewTypes";
import { sphereNode, stageNode, stageScene } from "../render/thumbnailStages";
import { MaterialPreview } from "../render/previewRouting";

const project = {
  "g.shadergraph.json": readFileSync(new URL("../../../samples/playground3d/shaders/pulse.shadergraph.json", import.meta.url), "utf8"),
  "c.particles.json": JSON.parse(readFileSync(new URL("../../../samples/playground3d/effects/campfire.particles.json", import.meta.url), "utf8")),
  "p.prefab.json": {
    format: "myco.scene@1",
    nodes: [{ id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [4, 0, 0] } }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] }],
  },
  "empty.prefab.json": { format: "myco.scene@1", nodes: [{ id: "a", name: "A", components: [] }] },
};

/** A built-in sphere with the default material. */
const sphere: ThumbnailStage = { scene: stageScene(sphereNode()) };
/** A particle effect that animates. */
const effect: ThumbnailStage = { scene: stageScene(stageNode("Effect", { type: "engine.ParticleSystem", data: { effect: "asset:c.particles.json", seed: 1 } })), animates: true, matte: true };
/** A prefab file as its own stage. */
const prefab = (path: string): ThumbnailStage => ({ scene: Assets.json<SceneFile>(path), source: path });

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

  describe("stages (ADR 0156)", () => {
    it("draws a stage's nodes with the render features, and gives each a World and scene of its own, freed on dispose", async () => {
      const a = (await renderer.prepare(sphere, false))!;
      const b = (await renderer.prepare(prefab("p.prefab.json"), false))!;
      expect(a.scene.useRightHandedSystem).toBe(true);
      expect(a.renderer.contentMeshes()).toHaveLength(1);
      expect(a.scene).not.toBe(b.scene);
      expect(a.world).not.toBe(b.world);
      a.dispose();
      expect(a.scene.isDisposed).toBe(true);
      expect(b.scene.isDisposed).toBe(false);
      b.dispose();
    });

    it("frames from the stage's view: a padded box, a fixed fallback when nothing has bounds, and the direction", async () => {
      const front = (await renderer.prepare({ ...sphere, view: { from: "front" } }, false))!;
      expect(Math.abs(front.camera.position.x)).toBeLessThan(1e-6);
      expect(Math.abs(front.camera.position.y)).toBeLessThan(1e-6);
      const padded = (await renderer.prepare({ ...sphere, view: { from: "front", pad: 2 } }, false))!;
      expect(padded.camera.position.z).toBeGreaterThan(front.camera.position.z * 2);
      front.dispose();
      padded.dispose();
    });

    it("dresses the stage's nodes before drawing (a script Material)", async () => {
      const dress = vi.fn();
      const p = (await renderer.prepare({ ...sphere, dress }, false))!;
      expect(dress).toHaveBeenCalledTimes(1);
      expect(dress.mock.calls[0][0].children.map((c: { name: string }) => c.name)).toEqual(["Sphere"]);
      p.dispose();
    });

    it("steps only a live stage that animates", async () => {
      expect((await renderer.prepare({ ...sphere, animates: true }, false))!.step).toBeUndefined();
      expect((await renderer.prepare(sphere, true))!.step).toBeUndefined();
      const live = (await renderer.prepare({ ...sphere, animates: true }, true))!;
      live.step!(0.25);
      expect(live.world.time.time).toBeCloseTo(0.25);
      expect(live.world.time.deltaTime).toBe(0); // between frames
      live.dispose();
    });

    it("gives up (and warns) on a stage that draws nothing", async () => {
      expect(await renderer.prepare(prefab("empty.prefab.json"), false)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("hover animation and the Inspector's preview", () => {
    /** A stand-in for a 2D canvas: the renderer only reads its size and whether it's in the document. */
    const target = (w = 64, h = 64) => ({ width: w, height: h, isConnected: true, getContext: () => null }) as unknown as HTMLCanvasElement;

    it("runs an animation until it's stopped, and calls onFrame after the first frame", async () => {
      (await renderer.prepare(effect, true))!.dispose(); // the render features' modules load before the clock is faked
      vi.useFakeTimers();
      try {
        const onFrame = vi.fn();
        const stop = renderer.animate(effect, target(), onFrame);
        await vi.advanceTimersByTimeAsync(200);
        expect(onFrame).toHaveBeenCalledTimes(1);
        stop();
        stop(); // twice is harmless
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps tiles still while a preview is open, and starts animating again after it stops", async () => {
      const preview = renderer.preview(sphere, target(300, 200));
      expect(await preview.ready).toBe(true);
      const onFrame = vi.fn();
      renderer.animate(effect, target(), onFrame)(); // refused: the preview has the renderer
      expect(onFrame).not.toHaveBeenCalled();
      preview.orbit(0.5, 0.1);
      preview.zoom(0.5);
      preview.reset();
      preview.redraw();
      preview.stop();
      const stop = renderer.animate(effect, target(), onFrame);
      expect(typeof stop).toBe("function");
      stop();
    });

    it("reports a preview that can't be drawn as not ready", async () => {
      expect(await renderer.preview(prefab("empty.prefab.json"), target()).ready).toBe(false);
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
    expect(await renderer.render(sphere)).toBeNull();
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
