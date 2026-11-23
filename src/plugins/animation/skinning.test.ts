// Skinned meshes on the ECS (ADR 0370 "Rendering"; T16): the SkinnedMeshRenderer sync (`features/skinning/sync.ts`) over
// a recording skinned-draw backend, fed matrices by a fake matrix source (T17's skeleton instances in the product): draws
// made when the model loads, one palette upload per skeleton and version, dispatches only when something changed, morph
// weights, visibility, bounds, placement, release and lost devices; and the feature's lazy registration. The feature on
// Babylon (NullEngine) is tested beside the Babylon backend (`engine/tests/babylonSkinning.test.ts`: Babylon stays there).
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Skeleton, SkinnedMeshRenderer, Vector3 } from "../../myco";
import type { World } from "../../engine/core/World";
import type { ModelMesh } from "../../engine/scene/models";
import { _registeredRenderFeatures } from "../../engine/render/renderFeatures";
import type { SkinnedMeshSource } from "../../engine/render/skinning/skinData";
import type { SkinPalette } from "../../engine/render/skinning/skinRuns";
import type { SkinnedDraw, SkinnedDraws } from "../../engine/render/skinning/skinnedDraws";
import type { Box6 } from "../../engine/render/skinning/skinBounds";
import { SkinningSync, type SkinningMatrixSource } from "./runtime/features/skinning/sync";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

async function world(): Promise<World> {
  const engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "s.scene.json": { format: "myco.scene@1", nodes: [] } }) });
  engines.push(engine);
  await SceneManager.load("s.scene.json");
  return engine.world as unknown as World;
}

/** A model mesh with two vertices on joints 0 and 2 (so its palette needs three joints) and one morph target. */
function source(name: string): SkinnedMeshSource {
  const positions = new Float32Array([1, 0, 0, 0, 1, 0]);
  const model = { name, materials: [], surfaces: [], data: { positions, normals: null, uvs: null, indices: new Uint32Array([0, 1, 0]), groups: [] } } as unknown as ModelMesh;
  return { model, geometry: { positions, normals: null, tangents: null, skin: { influences: 4, joints: [0, 0, 0, 0, 2, 0, 0, 0], weights: [1, 0, 0, 0, 1, 0, 0, 0] }, morphTargets: [{ name: "m", positions: new Float32Array([0, 1, 0, 0, 0, 0]), normals: null }] } };
}

interface FakeDraw extends SkinnedDraw<string> {
  log: string[];
  palette: SkinPalette | null;
  bounds: Box6 | null;
  placed: number[] | null;
  enabled: boolean;
  weights: number[];
  disposed: boolean;
  lostNow: boolean;
}

function recordingDraws() {
  const uploads: { label: string; joints: number; data: Float32Array }[] = [];
  const draws: FakeDraw[] = [];
  const palettes: { label: string; disposed: boolean }[] = [];
  let ends = 0;
  const backend: SkinnedDraws<string> = {
    executor: "js",
    palette(label) {
      const rec = { label, disposed: false };
      palettes.push(rec);
      return { upload: (data) => uploads.push({ label, joints: data.length / 12, data }), dispose: () => (rec.disposed = true) };
    },
    create(src, name) {
      const d: FakeDraw = {
        mesh: name,
        source: src,
        log: [],
        palette: null,
        bounds: null,
        placed: null,
        enabled: true,
        weights: [],
        disposed: false,
        lostNow: false,
        get lost() {
          return this.lostNow;
        },
        setPalette(p) {
          this.palette = p;
        },
        setMorphWeights(w) {
          this.weights = Array.from(w);
        },
        dispatch() {
          this.log.push("dispatch");
        },
        setWorldMatrix(m, o) {
          this.placed = Array.from(m).slice(o, o + 16);
        },
        setBounds(b) {
          this.bounds = b;
        },
        setEnabled(on) {
          this.enabled = on;
        },
        setShadows() {},
        setMaterials() {},
        dispose() {
          this.disposed = true;
        },
      };
      draws.push(d);
      return d;
    },
    endDispatches: () => void ends++,
    dispose() {},
  };
  return { backend, uploads, draws, palettes, ends: () => ends };
}

/** Skeleton matrices by node, with a version the test bumps. */
function fakeMatrices() {
  const poses = new Map<GameObject, { m: Float32Array | null; v: number }>();
  const source: SkinningMatrixSource = { matrices: (_w, s) => poses.get(s)?.m ?? null, version: (_w, s) => poses.get(s)?.v ?? 0 };
  const pose = (s: GameObject, m: Float32Array | null) => poses.set(s, { m, v: (poses.get(s)?.v ?? 0) + 1 });
  return { source, pose };
}

/** A palette of three joints: joint 2 moved by `dx` on x. */
const palette3 = (dx: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, dx, 0, 1, 0, 0, 0, 0, 1, 0]);

const dispatches = (d: FakeDraw) => d.log.filter((l) => l === "dispatch").length;

describe("SkinnedMeshRenderer sync (ADR 0370)", () => {
  it("uploads one palette per skeleton and version, and dispatches only when something changed", async () => {
    const w = await world();
    const rig = GameObject.create("Rig");
    rig.addComponent(Skeleton);
    rig.transform!.position = new Vector3(0, 0, 5);
    const body = GameObject.create("Body", { parent: rig }).addComponent(SkinnedMeshRenderer);
    body.mesh = "asset:hero.glb#Body";
    const hat = GameObject.create("Hat").addComponent(SkinnedMeshRenderer);
    hat.mesh = "asset:hero.glb#Hat";
    hat.skeleton = rig; // named, not an ancestor
    const meshes = new Map([[body.mesh, [source("Body")]], [hat.mesh, [source("Hat")]]]);
    const rec = recordingDraws();
    const m = fakeMatrices();
    const sync = new SkinningSync(rec.backend, m.source, (r) => meshes.get(r.mesh) ?? null);
    m.pose(rig, palette3(4));

    sync.sync(w);
    expect(rec.draws.map((d) => d.mesh)).toEqual(["Body:Body", "Hat:Hat"]);
    expect(rec.uploads).toHaveLength(1); // one skeleton: one upload for both meshes
    expect(rec.uploads[0].label).toBe("skeleton Rig");
    expect(rec.draws[0].palette).toBe(rec.draws[1].palette);
    expect(rec.draws.map(dispatches)).toEqual([1, 1]);
    expect(rec.ends()).toBe(1);
    expect(rec.draws[0].placed?.slice(12, 15)).toEqual([0, 0, 5]); // placed by the skeleton node
    expect(rec.draws[0].bounds).toEqual([0, 0, 0, 5, 1, 0]); // the rest box through joints 0 and 2
    expect(sync.loaded()).toBe(true);

    sync.sync(w); // nothing changed
    expect(rec.uploads).toHaveLength(1);
    expect(rec.draws.map(dispatches)).toEqual([1, 1]);
    expect(rec.ends()).toBe(1);

    m.pose(rig, palette3(6)); // a new pose
    sync.sync(w);
    expect(rec.uploads).toHaveLength(2);
    expect(rec.draws.map(dispatches)).toEqual([2, 2]);
    expect(rec.draws[1].bounds).toEqual([0, 0, 0, 7, 1, 0]);

    hat.morphWeights = [0.5]; // only the hat's morph weights
    sync.sync(w);
    expect(rec.uploads).toHaveLength(2);
    expect(rec.draws.map(dispatches)).toEqual([2, 3]);
    expect(rec.draws[1].weights).toEqual([0.5]);
    expect(rec.draws[1].bounds).toEqual([0, -0.5, 0, 7, 1.5, 0]); // grown by the morph target's reach

    hat.enabled = false; // hidden: no dispatch while hidden, even for a new pose
    m.pose(rig, palette3(7));
    sync.sync(w);
    expect(rec.draws[1].enabled).toBe(false);
    expect(rec.draws.map(dispatches)).toEqual([3, 3]);
    hat.enabled = true;
    sync.sync(w);
    expect(rec.draws.map(dispatches)).toEqual([3, 4]); // catches up with the palette it missed

    sync.release(body);
    expect(rec.draws[0].disposed).toBe(true);
    expect(rec.palettes[0].disposed).toBe(false); // the hat still uses it
    sync.release(hat);
    expect(rec.palettes[0].disposed).toBe(true);
  });

  it("waits for the model, and draws the bind pose without a skeleton or a pose", async () => {
    const w = await world();
    const r = GameObject.create("Prop").addComponent(SkinnedMeshRenderer);
    r.mesh = "asset:prop.glb";
    r.node.transform!.position = new Vector3(2, 0, 0);
    let loaded: SkinnedMeshSource[] | null = null;
    const rec = recordingDraws();
    const sync = new SkinningSync(rec.backend, fakeMatrices().source, () => loaded);
    sync.sync(w);
    expect(rec.draws).toHaveLength(0);
    expect(sync.loaded()).toBe(false);
    loaded = [source("Prop")];
    sync.sync(w);
    expect(rec.draws).toHaveLength(1);
    expect(rec.uploads.map((u) => [u.label, u.joints])).toEqual([["bind pose", 3]]); // identities for the joints it names
    expect(Array.from(rec.uploads[0].data.subarray(24))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(rec.draws[0].placed?.slice(12, 15)).toEqual([2, 0, 0]); // its own node
    sync.sync(w);
    expect(dispatches(rec.draws[0])).toBe(1);

    // A Skeleton without a pose yet: identities too; then its first pose replaces them.
    const rig = r.node.addComponent(Skeleton).node;
    const m = fakeMatrices();
    const sync2 = new SkinningSync(rec.backend, m.source, () => loaded);
    sync2.sync(w);
    expect(rec.uploads.at(-1)?.label).toBe("skeleton Prop");
    expect(rec.uploads.at(-1)?.joints).toBe(3);
    m.pose(rig, palette3(1));
    sync2.sync(w);
    expect(rec.uploads.at(-1)?.data).toEqual(palette3(1));
  });

  it("takes fixed bounds around the renderer's node, in the skeleton's space", async () => {
    const w = await world();
    const rig = GameObject.create("Rig");
    rig.addComponent(Skeleton);
    rig.transform!.position = new Vector3(10, 0, 0);
    const node = GameObject.create("Body", { parent: rig });
    node.transform!.position = new Vector3(1, 0, 0); // local to the rig
    const r = node.addComponent(SkinnedMeshRenderer);
    r.mesh = "asset:hero.glb";
    r.boundsMode = "fixed";
    r.boundsCenter = new Vector3(0, 1, 0);
    r.boundsSize = new Vector3(2, 2, 2);
    const rec = recordingDraws();
    const sync = new SkinningSync(rec.backend, fakeMatrices().source, () => [source("B")]);
    sync.sync(w);
    expect(rec.draws[0].bounds?.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 0, -1, 2, 2, 1]);
  });

  it("remakes draws whose device was lost, and draws a changed mesh anew", async () => {
    const w = await world();
    const r = GameObject.create("A").addComponent(SkinnedMeshRenderer);
    r.mesh = "asset:a.glb";
    const rec = recordingDraws();
    const models = new Map([["asset:a.glb", [source("A")]], ["asset:b.glb", [source("B1"), source("B2")]]]);
    const sync = new SkinningSync(rec.backend, fakeMatrices().source, (x) => models.get(x.mesh) ?? null);
    sync.sync(w);
    rec.draws[0].lostNow = true;
    sync.sync(w);
    expect(rec.draws[0].disposed).toBe(true);
    expect(rec.draws).toHaveLength(2);
    expect(dispatches(rec.draws[1])).toBe(1);
    r.mesh = "asset:b.glb";
    sync.sync(w);
    expect(rec.draws[1].disposed).toBe(true);
    expect(rec.draws.slice(2).map((d) => d.mesh)).toEqual(["A:B1", "A:B2"]);
    expect([...sync.renderers()].map((e) => [e.renderer, e.meshes, e.visible])).toEqual([[r, ["A:B1", "A:B2"], true]]);
    sync.dispose();
    expect(rec.draws.every((d) => d.disposed)).toBe(true);
  });
});

describe("the skinning render feature", () => {
  it("is registered lazily for SkinnedMeshRenderer, after the meshes", async () => {
    const reg = _registeredRenderFeatures().find((f) => f.spec.name === "skinning")!;
    expect(reg.spec).toMatchObject({ phase: "content", lazy: true, after: ["meshes"] });
    expect(reg.spec.types).toEqual([SkinnedMeshRenderer]);
    expect(typeof (await reg.load())).toBe("function");
  });
});
