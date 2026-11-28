// The visibility stage's World service (ADR 0459 §2–3) in a headless World: it starts with the first LODGroup, selects
// for the main camera after transforms each frame, and fills `LODGroup.currentLevel` and `visibility`, the per-slot
// results the renderer reads, and the per-view statistics.
import { afterEach, describe, expect, it } from "vitest";
import { Component } from "../../core/Component";
import { component } from "../../core/registry";
import { _startWorldService } from "../../core/worldServices";
import { Assets, Engine, GameObject, Graphics, Quaternion } from "../../index";
import type { ModelMesh } from "../../scene/models";
import { Camera, LODGroup, MeshRenderer } from "../components";
import { registerLodMemberType } from "./lodMember";
import { VISIBILITY_SERVICE_ID, visibilityService, type VisibilityService } from "./service";
import { LOD_CULLED, type LodMember, type OcclusionRole } from "./types";
import { cameraView, makeView } from "./views";
import { loadOcclusionCore } from "./occlusion/core";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

async function setup(): Promise<{ engine: Engine; camera: Camera; service: VisibilityService; group: LODGroup; renderer: MeshRenderer }> {
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  const camera = GameObject.create("eye").addComponent(Camera); // at the origin, looking along +Z
  camera.projection = "perspective";
  camera.fieldOfView = 90; // h = size / (2·d)
  const node = GameObject.create("rock");
  const group = node.addComponent(LODGroup);
  group.levels = [0.5, 0.2, 0.05];
  group.size = 1;
  const renderer = GameObject.create("lod0", { parent: node }).addComponent(MeshRenderer);
  const service = (await _startWorldService(engine.world, VISIBILITY_SERVICE_ID)) as VisibilityService;
  return { engine, camera, service, group, renderer };
}

const place = (c: Component, x: number, y: number, z: number) => c.node.transform!.position.set(x, y, z);

describe("the visibility service", () => {
  it("starts with the first LODGroup and fills currentLevel and visibility from the main camera after transforms", async () => {
    const { engine, service, group } = await setup();
    expect(visibilityService(engine.world)).toBe(service);
    place(group, 0, 0, 2); // h = 0.25
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(1);
    expect(group.visibility).toBe("drawn");
    place(group, 0, 0, 0.5); // h = 1
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(0);
    place(group, 0, 0, 30); // h ≈ 0.017
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(-1);
    expect(group.visibility).toBe("lodCulled");
    place(group, 0, 0, -5);
    engine.step(1 / 60);
    expect(group.visibility).toBe("offScreen");
  });

  it("measures against the enabled camera with the lowest depth, and reads 0 and drawn with no camera", async () => {
    const { engine, camera, group } = await setup();
    place(group, 0, 0, -2); // behind the first camera
    const back = GameObject.create("back").addComponent(Camera);
    back.projection = "perspective";
    back.fieldOfView = 90;
    back.node.transform!.rotation = Quaternion.euler(0, Math.PI, 0); // looking along -Z
    back.depth = 1;
    engine.step(1 / 60);
    expect(group.visibility).toBe("offScreen"); // depth 0 is main
    back.depth = -1;
    engine.step(1 / 60);
    expect(group.visibility).toBe("drawn");
    expect(group.currentLevel).toBe(1);
    back.enabled = false;
    engine.step(1 / 60);
    expect(group.visibility).toBe("offScreen");
    camera.enabled = false;
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(0);
    expect(group.visibility).toBe("drawn");
  });

  it("writes each member's group level into its slot; renderers outside a group draw LOD0; casters follow castShadows", async () => {
    const { engine, service, group, renderer } = await setup();
    place(group, 0, 0, 2);
    const loose = GameObject.create("loose").addComponent(MeshRenderer);
    place(loose, 0, 0, 500);
    const quiet = GameObject.create("quiet", { parent: group.node }).addComponent(MeshRenderer);
    quiet.castShadows = false;
    engine.step(1 / 60);
    const main = service.main!;
    const [r, l, q] = [renderer, loose, quiet].map((m) => service.slotOf(m));
    expect(new Set([r, l, q]).size).toBe(3);
    expect(service.slots).toBeGreaterThanOrEqual(3);
    expect([main.levels[r], main.levels[l], main.levels[q]]).toEqual([1, 0, 1]);
    expect([main.casterLevels[r], main.casterLevels[q]]).toEqual([1, LOD_CULLED]);
    expect([main.hidden[r], main.hidden[l]]).toEqual([0, 0]);
    place(loose, 0, 0, -10);
    engine.step(1 / 60);
    expect(service.main!.hidden[l]).toBe(1);
    loose.enabled = false;
    engine.step(1 / 60);
    expect(service.slotOf(loose)).toBe(-1);
  });

  it("drops a group and its renderers whose node was destroyed (undoing a placement) without touching the dead node", async () => {
    const { engine, service, group, renderer } = await setup();
    place(group, 0, 0, 2);
    engine.step(1 / 60);
    expect(service.slotOf(renderer)).toBeGreaterThanOrEqual(0);
    GameObject.destroy(group.node); // queued: the node goes at the end of the next frame
    engine.step(1 / 60);
    // Between that teardown and the next frame the renderer still selects its views (an edit-mode redraw, a probe).
    const other = makeView({ key: "probe/0", kind: "probe", position: [0, 0, 1.75], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], projection: "perspective", fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 100, widthPx: 128, heightPx: 128, persistent: false, occlusion: false });
    expect(() => service.select(other)).not.toThrow();
    expect(() => service.update()).not.toThrow();
    engine.step(1 / 60);
    expect(service.slotOf(renderer)).toBe(-1);
  });

  it("stops at a nested LODGroup, and lets a disabled one keep its members out of the outer group", async () => {
    const { engine, service, group } = await setup();
    place(group, 0, 0, 2); // the outer group draws level 1
    const inner = GameObject.create("inner", { parent: group.node }).addComponent(LODGroup);
    inner.forceLevel = 2;
    const deep = GameObject.create("deep", { parent: inner.node }).addComponent(MeshRenderer);
    engine.step(1 / 60);
    expect(service.main!.levels[service.slotOf(deep)]).toBe(2);
    expect(inner.currentLevel).toBe(2);
    inner.enabled = false;
    engine.step(1 / 60);
    expect(service.main!.levels[service.slotOf(deep)]).toBe(0); // ungrouped: LOD0
  });

  it("follows membership changes between frames: a renderer reparented to another group, a group turned back on, a node made inactive", async () => {
    const { engine, service, group, renderer } = await setup();
    place(group, 0, 0, 2); // level 1
    const other = GameObject.create("other").addComponent(LODGroup);
    other.forceLevel = 2;
    engine.step(1 / 60);
    expect(service.main!.levels[service.slotOf(renderer)]).toBe(1);
    renderer.node.setParent(other.node);
    engine.step(1 / 60);
    expect(service.main!.levels[service.slotOf(renderer)]).toBe(2);
    other.enabled = false;
    engine.step(1 / 60);
    expect(service.main!.levels[service.slotOf(renderer)]).toBe(0); // ungrouped
    other.enabled = true;
    engine.step(1 / 60);
    expect(service.main!.levels[service.slotOf(renderer)]).toBe(2);
    other.node.setActive(false);
    engine.step(1 / 60);
    expect(service.slotOf(renderer)).toBe(-1);
  });

  it("brings bounds up to date when only a transform changes, its own or an ancestor's", async () => {
    const { engine, service, group } = await setup();
    const parent = GameObject.create("parent");
    group.node.setParent(parent);
    place(group, 0, 0, 2);
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(1);
    parent.transform!.position.set(0, 0, 28); // the group's world position moves with it: h ≈ 0.017
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(-1);
    parent.transform!.position.set(0, 0, 0);
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(1);
    void service;
  });

  it("derives automatic heights from members' measured errors (a plugin's member type), and LOD0 without levels", async () => {
    const { engine, group, renderer } = await setup();
    renderer.enabled = false;
    group.levels = [];
    const probe = GameObject.create("probe", { parent: group.node }).addComponent(LevelsProbe);
    place(group, 0, 0, 2); // h = 0.25: between 0.3 (leave 0) and 0.1 (leave 1)
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(1);
    place(group, 0, 0, 100); // h = 0.005, below 0.01
    engine.step(1 / 60);
    expect(group.visibility).toBe("lodCulled");
    probe.withLevels = false; // re-imported without levels
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(0);
    expect(group.visibility).toBe("drawn");
  });

  it("reuses the main view's result for the renderer's main view and selects other views itself", async () => {
    const { engine, camera, service, group, renderer } = await setup();
    place(group, 0, 0, 2);
    engine.step(1 / 60);
    const main = service.main!;
    const px = camera._devicePixelSize();
    expect(service.select(cameraView(camera, px.width, px.height))).toBe(main);
    const probe = makeView({ key: "probe/0", kind: "probe", position: [0, 0, 1.75], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], projection: "perspective", fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 100, widthPx: 128, heightPx: 128, persistent: false, occlusion: false });
    const other = service.select(probe); // 0.25 m away: h = 2
    expect(other).not.toBe(main);
    expect(other.levels[service.slotOf(renderer)]).toBe(0);
    expect(service.main!.levels[service.slotOf(renderer)]).toBe(1);
  });

  it("reports per-view statistics for LODGroups", async () => {
    const { engine, service, group } = await setup();
    place(group, 0, 0, 2);
    const far = GameObject.create("far").addComponent(LODGroup);
    far.levels = [0.5];
    GameObject.create("m", { parent: far.node }).addComponent(MeshRenderer);
    place(far, 0, 0, 50);
    GameObject.create("loose").addComponent(MeshRenderer); // not a group
    engine.step(1 / 60);
    expect(service.stats(service.main!.view.key)).toEqual({ groups: 2, perLevel: [0, 1], lodCulled: 1, fading: 0, occlusion: null });
    expect(service.stats("nothing")).toBeNull();
  });

  describe("crossfades (ADR 0459 §4)", () => {
    afterEach(() => {
      Graphics.quality = Graphics.defaultQuality;
    });

    it("writes each member's fade value and outgoing level on the engine's clock, casters switching at the midpoint", async () => {
      const { engine, service, group, renderer } = await setup();
      Graphics.quality = "High";
      const quiet = GameObject.create("quiet", { parent: group.node }).addComponent(MeshRenderer);
      quiet.castShadows = false;
      place(group, 0, 0, 2); // level 1
      engine.step(1 / 60);
      const r = service.slotOf(renderer), q = service.slotOf(quiet);
      expect(service.crossfades(renderer)).toBe(true);
      expect(service.main!.fade[r]).toBe(0);
      place(group, 0, 0, 0.5); // level 0: a 0.3 s fade starts
      engine.step(1 / 60);
      let main = service.main!;
      expect([main.levels[r], main.levels[q]]).toEqual([0, 0]);
      expect(main.fade[r]).toBeLessThan(0);
      expect(main.fade[q]).toBe(main.fade[r]);
      expect([service.fadeLevels(main)![r], service.fadeLevels(main)![q]]).toEqual([1, 1]);
      expect([main.casterLevels[r], main.casterLevels[q]]).toEqual([1, LOD_CULLED]);
      expect(group.currentLevel).toBe(0); // the level chosen, not the fade
      expect(service.stats(main.view.key)!.fading).toBe(1);
      engine.step(0.2); // t ≈ 0.67
      main = service.main!;
      expect(main.fade[r]).toBeCloseTo(-0.2 / 0.3, 4);
      expect(main.casterLevels[r]).toBe(0);
      engine.step(0.2); // done
      main = service.main!;
      expect(main.fade[r]).toBe(0);
      expect(service.fadeLevels(main)![r]).toBe(LOD_CULLED);
      expect(service.stats(main.view.key)!.fading).toBe(0);
    });

    it("advances a fade once a frame however often update runs in it (the animation gather's, then after propagation)", async () => {
      const { engine, service, group, renderer } = await setup();
      Graphics.quality = "High";
      place(group, 0, 0, 2);
      engine.step(1 / 60);
      place(group, 0, 0, 0.5);
      engine.step(1 / 60); // the fade starts
      const r = service.slotOf(renderer);
      const start = service.main!.fade[r];
      service.update();
      service.update();
      expect(service.main!.fade[r]).toBe(start); // the same frame: no advance
      engine.step(0.06);
      const once = service.main!.fade[r];
      service.update();
      expect(service.main!.fade[r]).toBe(once);
      expect(once - start).toBeCloseTo(-0.06 / 0.3, 4); // one frame's worth
    });

    it("snaps with fade none, on a tier without crossfade, and in views that don't persist", async () => {
      const { engine, service, group, renderer } = await setup();
      Graphics.quality = "High";
      const change = (z: number) => {
        place(group, 0, 0, z);
        engine.step(1 / 60);
        return service.main!.fade[service.slotOf(renderer)];
      };
      change(2);
      group.fade = "none";
      expect(change(0.5)).toBe(0);
      expect(service.crossfades(renderer)).toBe(false); // as of the last frame
      group.fade = "crossfade";
      Graphics.quality = "Low"; // lodCrossfade off (and lodFirstLevel 1: level 2 at z = 4)
      expect(change(4)).toBe(0);
      expect(service.crossfades(renderer)).toBe(false);
      Graphics.quality = "High";
      expect(change(0.5)).toBeLessThan(0);
      expect(service.crossfades(renderer)).toBe(true);
      const probe = (z: number) => makeView({ key: "probe/0", kind: "probe", position: [0, 0, z], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], projection: "perspective", fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 100, widthPx: 128, heightPx: 128, persistent: false, occlusion: false });
      expect(service.select(probe(0)).levels[service.slotOf(renderer)]).toBe(0);
      const later = service.select(probe(-1.5)); // a coarser level, chosen afresh: no fade
      expect(later.levels[service.slotOf(renderer)]).toBe(1);
      expect(later.fade[service.slotOf(renderer)]).toBe(0);
    });
  });
});

describe("cameraView", () => {
  it("takes the camera's frame, projection and key, and occlusion for perspective canvas cameras only", async () => {
    const { camera } = await setup();
    place(camera, 1, 2, 3);
    const v = cameraView(camera, 800, 600);
    expect(v.position).toEqual([1, 2, 3]);
    expect(v.kind).toBe("camera");
    expect(v.key).toBe(`${camera.node.id}/camera`);
    expect(v.fovY).toBeCloseTo(Math.PI / 2);
    expect(v.heightPx).toBe(600);
    expect(v.occlusion).toBe(true);
    camera.occlusionCulling = false;
    expect(cameraView(camera, 800, 600).occlusion).toBe(false);
    camera.occlusionCulling = true;
    camera.projection = "orthographic";
    camera.orthographicSize = 7;
    const o = cameraView(camera, 800, 600);
    expect([o.projection, o.orthoHalfHeight, o.occlusion]).toEqual(["orthographic", 7, false]);
    camera.projection = "perspective";
    camera.targetTexture = "asset:rt.rendertexture.json";
    expect([cameraView(camera, 64, 64).kind, cameraView(camera, 64, 64).occlusion]).toEqual(["texture", false]);
  });

  it("previews a level in scene views only, and reports the scene view's screen height", async () => {
    const { engine, service, group, renderer } = await setup();
    place(group, 0, 0, 2); // h = 0.25: level 1
    engine.step(1 / 60);
    const frame = { position: [0, 0, 0] as [number, number, number], right: [1, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], forward: [0, 0, 1] as [number, number, number], projection: "perspective" as const, fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 100, widthPx: 100, heightPx: 100, occlusion: false };
    const scene = makeView({ ...frame, key: "orbit/sceneView", kind: "sceneView", persistent: true });
    const game = makeView({ ...frame, key: "cam/camera", kind: "camera", persistent: true });
    const slot = service.slotOf(renderer);
    expect(service.sceneViewHeight(group)).toBeNull();
    service.setLodPreview(group, 2);
    expect(service.select(scene).levels[slot]).toBe(2);
    expect(service.select(game).levels[slot]).toBe(1);
    engine.step(1 / 60);
    expect(group.currentLevel).toBe(1); // the simulation's view is untouched
    expect(service.sceneViewHeight(group)).toBeCloseTo(0.25, 5);
    service.setLodPreview(group, -1);
    expect(service.select(scene).levels[slot]).toBe(LOD_CULLED);
    service.setLodPreview(null);
    expect(service.select(scene).levels[slot]).toBe(1);
  });
});

/** A member type a plugin would register: one mesh with three generated levels, or none. */
@component("test.LevelsProbe")
class LevelsProbe extends Component implements LodMember {
  withLevels = true;
  readonly occlusion: OcclusionRole = "auto";
  readonly castShadows = true;
  lodMeshes(): readonly ModelMesh[] | null {
    return this.withLevels ? WITH_LEVELS : WITHOUT;
  }
}
const err = (h: number) => 1 / (1080 * h);
const data = { positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), normals: null, uvs: null, indices: new Uint32Array(0), groups: [] };
const WITHOUT = [{ name: "rock", materials: [], surfaces: [], data } as ModelMesh];
const WITH_LEVELS = [
  { ...WITHOUT[0], lods: { levels: [0, err(0.3), err(0.1)].map((error) => ({ mesh: WITHOUT[0], error, triangles: 1 })), occluder: null, bounds: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], pixelError: 1 } } as ModelMesh,
];
registerLodMemberType(LevelsProbe);

describe("occlusion in the visibility service (ADR 0460)", () => {
  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality;
  });
  /** A wall of built-in cube (12 triangles: it occludes with itself) at z, 20 wide and high. */
  const wall = (z: number) => {
    const w = GameObject.create("wall").addComponent(MeshRenderer);
    w.node.transform!.scale.set(20, 20, 0.5);
    place(w, 0, 0, z);
    return w;
  };
  /** Step until the occlusion core has loaded (it loads lazily, the first time a view asks), then once more. */
  const stepLoaded = async (engine: Engine) => {
    engine.step(1 / 60);
    await loadOcclusionCore(256, 128);
    await Promise.resolve();
    engine.step(1 / 60);
  };

  it("hides a group behind an opaque wall in the main camera, says why, and keeps its shadow caster", async () => {
    Graphics.quality = "High"; // a 256×128 buffer
    const { engine, service, group, renderer } = await setup();
    place(group, 0, 0, 8); // level 2, behind the wall
    wall(4);
    await stepLoaded(engine);
    expect(group.visibility).toBe("occluded");
    expect(service.main!.hidden[service.slotOf(renderer)]).not.toBe(0);
    const stats = service.stats(service.main!.view.key)!.occlusion!;
    expect(stats.occluders).toBeGreaterThanOrEqual(1); // the wall, and the group's own cube (wide enough on screen)
    expect(stats.culled).toBe(1);
    // Casters are never occlusion-culled: an object hidden from the camera can still cast a visible shadow.
    expect(service.main!.casterLevels[service.slotOf(renderer)]).not.toBe(LOD_CULLED);
  });

  it("draws what each role, the camera and the tier say it may not hide", async () => {
    Graphics.quality = "High";
    const { engine, camera, group, renderer } = await setup();
    place(group, 0, 0, 5); // near enough to stay drawn on the Low tier (its LOD bias)
    const w = wall(3);
    await stepLoaded(engine);
    expect(group.visibility).toBe("occluded");
    w.occlusion = "occludee"; // hides nothing
    engine.step(1 / 60);
    expect(group.visibility).toBe("drawn");
    w.occlusion = "occluder";
    engine.step(1 / 60);
    expect(group.visibility).toBe("occluded");
    renderer.occlusion = "none"; // never hidden
    engine.step(1 / 60);
    expect(group.visibility).toBe("drawn");
    renderer.occlusion = "occludee";
    engine.step(1 / 60);
    expect(group.visibility).toBe("occluded");
    camera.occlusionCulling = false;
    engine.step(1 / 60);
    expect(group.visibility).toBe("drawn");
    camera.occlusionCulling = true;
    Graphics.quality = "Low"; // no buffer
    engine.step(1 / 60);
    expect(group.visibility).toBe("drawn");
  });

  it("doesn't occlude with a see-through material, or with an auto occluder too narrow on screen", async () => {
    Graphics.quality = "High";
    const { engine, group } = await setup();
    place(group, 0, 0, 8);
    Assets.addSource(Assets.fromObject({ "glass.material.json": { format: "myco.material@1", color: "#ffffff80" } }));
    const w = wall(4);
    w.material = "glass.material.json";
    await stepLoaded(engine);
    expect(group.visibility).toBe("drawn");
    w.material = "";
    w.node.transform!.scale.set(20, 20, 0.001); // 0.001 deep: under 2 buffer pixels at any distance
    engine.step(1 / 60);
    expect(group.visibility).toBe("drawn");
    w.occlusion = "occluder"; // an explicit occluder skips the width test
    engine.step(1 / 60);
    expect(group.visibility).toBe("occluded");
  });

  it("backs off where it culls little: after 60 frames under 10 % it pauses for 60, then retries", async () => {
    Graphics.quality = "High";
    const { engine, service, group } = await setup();
    place(group, 0, 0, 8);
    wall(-4); // behind the camera: occludes nothing
    await stepLoaded(engine);
    const key = service.main!.view.key;
    let ran = 1; // the frame after loading ran
    for (let i = 0; i < 58; i++) {
      engine.step(1 / 60);
      if (service.stats(key)!.occlusion) ran++;
    }
    expect(ran).toBe(59);
    engine.step(1 / 60); // the 60th low frame: runs, then pauses
    expect(service.stats(key)!.occlusion).not.toBeNull();
    for (let i = 0; i < 60; i++) {
      engine.step(1 / 60);
      expect(service.stats(key)!.occlusion).toBeNull();
    }
    engine.step(1 / 60);
    expect(service.stats(key)!.occlusion).not.toBeNull(); // the retry
    engine.step(1 / 60);
    expect(service.stats(key)!.occlusion).toBeNull(); // still low: paused again
  });
});
