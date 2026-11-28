// The visibility stage's World service (ADR 0446 §2–3) in a headless World: it starts with the first LODGroup, selects
// for the main camera after transforms each frame, and fills `LODGroup.currentLevel` and `visibility`, the per-slot
// results the renderer reads, and the per-view statistics.
import { afterEach, describe, expect, it } from "vitest";
import { Component } from "../../core/Component";
import { component } from "../../core/registry";
import { _startWorldService } from "../../core/worldServices";
import { Engine, GameObject, Quaternion } from "../../index";
import type { ModelMesh } from "../../scene/models";
import { Camera, LODGroup, MeshRenderer } from "../components";
import { registerLodMemberType } from "./lodMember";
import { VISIBILITY_SERVICE_ID, visibilityService, type VisibilityService } from "./service";
import { LOD_CULLED, type LodMember, type OcclusionRole } from "./types";
import { cameraView, makeView } from "./views";

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
