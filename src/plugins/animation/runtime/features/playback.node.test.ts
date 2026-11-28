// ADR 0370, 0372 (T17): Skeletons, code-first Animators, root motion, culling, LOD and BoneAttachments in a headless
// Engine, through the public API (`myco`), the render-sync contract (`skeletonInstances.ts`, what T16 reads) and the
// host's stats. Project files load through `Assets` from `file:` URLs, as the dedicated server reads them. Time comes
// from `engine.step(dt)` only. Poses are compared with what anim-offline (f64) computed for the same playback
// (`../wasm/fixtures/expected.json`) at the fixture's tolerance: 1e-4 on matrix entries (f32 against f64 over a short
// bone chain). Positions derived from those matrices or from the clip's root curve use 1e-4 too (a few f32 operations
// per frame over 10 frames).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, BoneAttachment, Camera, CharacterController, Engine, GameBehavior, GameObject, LODGroup, Quaternion, RigidBody, RootMotion, Skeleton, Vector3 } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { Mat4 } from "../../../../engine/core/math";
import { applyTestPlugins } from "../../../testPlugins";
import { multiply34, toMat4 } from "../affine";
import { readClipInfo, readSkeletonInfo } from "../assetInfo";
import { animationCoreOf } from "../core/service";
import { animatorsOf } from "./instances";
import { cameraViews, lodStep } from "./playback/view";
import { instanceForSkeleton, skinningMatrices, skinningVersion } from "../skeletonInstances";
import type { AnimationPlayResult, AnimatorCullingMode, AnimatorRootMotion, AnimatorUpdateMode } from "../types";

interface Expected {
  bones: number;
  dt: number;
  tolerance: number;
  play: number[];
  crossfade: number[];
}

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(fixtureUrl(name)));
const expected = JSON.parse(readFileSync(fixtureUrl("expected.json"), "utf8")) as Expected;
const dt = expected.dt;
const TOL = expected.tolerance;
const skel = readSkeletonInfo(fixture("small.skel"))!;
const walkInfo = readClipInfo(fixture("walk.anim"))!;

const SKEL = "anim/small.skel";
const WALK = "anim/walk.anim";
const RUN = "anim/run.anim";
/** The run clip under another URL: an asset no other test holds. */
const RUN_COPY = "anim/run-copy.anim";

let engine: Engine;
let world: World;

const maxDiff = (m: ArrayLike<number> | null, e: readonly number[]): number => {
  if (!m) return Number.POSITIVE_INFINITY;
  let w = 0;
  for (let i = 0; i < e.length; i++) w = Math.max(w, Math.abs(m[i]! - e[i]!));
  return w;
};
const steps = (n: number, d = dt) => {
  for (let i = 0; i < n; i++) engine.step(d);
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const matrices = (node: GameObject) => skinningMatrices(world, node)?.slice() ?? null;

interface HeroOptions {
  defaultClip?: string;
  updateMode?: AnimatorUpdateMode;
  cullingMode?: AnimatorCullingMode;
  rootMotion?: AnimatorRootMotion;
  lodMetric?: "off" | "distance" | "screenSize" | "lodGroup";
  /** An `LODGroup` on the hero's node (its members: none; the group alone decides the level). */
  group?: { levels: number[]; forceLevel?: number; size?: number };
  lodEvery2?: number;
  lodEvery4?: number;
  position?: [number, number, number];
}

const made: GameObject[] = [];

/** A character: a Skeleton and an Animator on one node, ready (its core instance made). */
async function hero(options: HeroOptions = {}): Promise<{ node: GameObject; anim: Animator }> {
  const node = GameObject.create("Hero");
  made.push(node);
  if (options.position) node.transform!.position = options.position;
  node.addComponent(Skeleton, { skeleton: SKEL });
  const anim = node.addComponent(Animator, {
    defaultClip: options.defaultClip ?? "",
    updateMode: options.updateMode ?? "normal",
    cullingMode: options.cullingMode ?? "always",
    rootMotion: options.rootMotion ?? "none",
    lodMetric: options.lodMetric ?? "off",
    lodEvery2: options.lodEvery2 ?? 20,
    lodEvery4: options.lodEvery4 ?? 40,
  });
  if (options.group) node.addComponent(LODGroup, { levels: options.group.levels, forceLevel: options.group.forceLevel ?? -1, size: options.group.size ?? 2, fade: "none" });
  await vi.waitFor(() => expect(instanceForSkeleton(world, node)).not.toBe(0));
  return { node, anim };
}

/** Steps with dt 0 until every Animator shows a play on layer 0 (its clip loaded and the play sent): no time passes. */
async function settle(...anims: Animator[]): Promise<void> {
  await vi.waitFor(() => {
    engine.step(0);
    for (const a of anims) expect(a.state().name).not.toBe("");
  });
}

function destroyAll(): void {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      [SKEL]: fixtureUrl("small.skel").href,
      [WALK]: fixtureUrl("walk.anim").href,
      [RUN]: fixtureUrl("run.anim").href,
      [RUN_COPY]: `${fixtureUrl("run.anim").href}#copy`,
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
  // Load both clips once (the core keeps them; later plays find them loaded), and keep the skeleton referenced.
  const keeper = GameObject.create("Keeper");
  keeper.addComponent(Skeleton, { skeleton: SKEL });
  const { anim } = await hero();
  anim.play(WALK);
  anim.play(RUN, { layer: 1 });
  await settle(anim);
  await vi.waitFor(() => {
    engine.step(0);
    expect(anim.state(1).name).toBe(RUN);
  });
  destroyAll();
});

afterAll(() => engine?.dispose());

describe("Skeleton and Animator", () => {
  it("plays a clip: the skinning matrices match anim-offline, and the version bumps", async () => {
    const { node, anim } = await hero();
    expect(skinningMatrices(world, node)).toBeNull(); // nothing evaluated yet
    const promise = anim.play(WALK);
    expect(anim.onFinished).toBe(promise);
    await settle(anim);
    const v = skinningVersion(world, node);
    steps(10);
    expect(skinningVersion(world, node)).toBeGreaterThan(v);
    expect(maxDiff(matrices(node), expected.play)).toBeLessThan(TOL);
    expect(anim.state()).toMatchObject({ name: WALK, weight: 1, transitioningTo: null });
    expect(anim.state().time).toBeCloseTo(10 * dt, 5);
    expect(anim.state().normalizedTime).toBeCloseTo((10 * dt) / walkInfo.duration, 5);
    expect(anim.state(2).name).toBe(""); // nothing on that layer
    destroyAll();
  });

  it("binds to a Skeleton below its node (Unity's Animator over its hierarchy)", async () => {
    const root = GameObject.create("Rig");
    made.push(root);
    const anim = root.addComponent(Animator);
    const body = GameObject.create("Body", { parent: root });
    body.addComponent(Skeleton, { skeleton: SKEL });
    await vi.waitFor(() => expect(instanceForSkeleton(world, body)).not.toBe(0));
    anim.play(WALK);
    await settle(anim);
    steps(10);
    expect(maxDiff(matrices(body), expected.play)).toBeLessThan(TOL);
    destroyAll();
  });

  it("plays defaultClip on start", async () => {
    const { node, anim } = await hero({ defaultClip: WALK });
    await settle(anim);
    steps(10);
    expect(maxDiff(matrices(node), expected.play)).toBeLessThan(TOL);
    expect(anim.state().name).toBe(WALK);
    destroyAll();
  });

  it("crossfades: matches anim-offline, and the replaced play resolves interrupted", async () => {
    const { node, anim } = await hero();
    const walk = anim.play(WALK);
    await settle(anim);
    steps(10);
    const run = anim.crossfade(RUN, 0.5);
    await tick(); // the clip is loaded: its entry resolves in microtasks
    steps(6);
    expect(maxDiff(matrices(node), expected.crossfade)).toBeLessThan(TOL);
    expect(await walk).toEqual({ reason: "interrupted" });
    expect(anim.state()).toMatchObject({ name: RUN });
    expect(anim.state().weight).toBeCloseTo((6 * dt) / 0.5, 5);
    expect(anim.onFinished).toBe(run);
    destroyAll();
  });

  it("stops: the play resolves stopped and the layer shows nothing", async () => {
    const { anim } = await hero();
    const walk = anim.play(WALK);
    await settle(anim);
    steps(3);
    anim.stop({ fade: 0.2 });
    steps(1);
    expect(await walk).toEqual({ reason: "stopped" });
    expect(anim.state().name).toBe("");
    destroyAll();
  });

  it("finishes a play that doesn't loop", async () => {
    const { anim } = await hero();
    const once = anim.play(WALK, { loop: false, speed: 4 }); // 2 s at 4×: 0.5 s
    await settle(anim);
    let result: AnimationPlayResult | null = null;
    void once.then((r) => (result = r));
    steps(14);
    await tick();
    expect(result).toBeNull();
    steps(2);
    await tick();
    expect(result).toEqual({ reason: "finished" });
    expect(anim.state().normalizedTime).toBe(1);
    destroyAll();
  });

  it("weighs layers: a layer at weight 0 leaves the pose alone, at 1 it shows", async () => {
    const { node, anim } = await hero();
    anim.play(WALK);
    anim.play(RUN, { layer: 1 });
    anim.layerWeight(1, 0);
    await settle(anim);
    steps(10);
    expect(maxDiff(matrices(node), expected.play)).toBeLessThan(TOL);
    anim.layerWeight(1, 1);
    steps(1);
    expect(maxDiff(matrices(node), expected.play)).toBeGreaterThan(0.01);
    destroyAll();
  });

  it("runs unscaled Animators on unscaled time while timeScale is 0", async () => {
    const { node, anim } = await hero({ updateMode: "unscaled" });
    const { node: still, anim: scaled } = await hero();
    anim.play(WALK);
    scaled.play(WALK);
    await settle(anim, scaled);
    const atStart = matrices(still);
    world.time.timeScale = 0;
    try {
      steps(10);
    } finally {
      world.time.timeScale = 1;
    }
    expect(maxDiff(matrices(node), expected.play)).toBeLessThan(TOL);
    expect(maxDiff(matrices(still), [...atStart!])).toBe(0);
    destroyAll();
  });

  it("runs fixed-mode Animators in the fixed step", async () => {
    const fixed = world.time.fixedDeltaTime;
    world.time.fixedDeltaTime = dt;
    try {
      const { node, anim } = await hero({ updateMode: "fixed" });
      anim.play(WALK);
      await tick();
      steps(10); // one fixed step per frame
      expect(world.time.fixedStepCount).toBeGreaterThan(0);
      expect(maxDiff(matrices(node), expected.play)).toBeLessThan(TOL);
      expect(anim.state().time).toBeCloseTo(10 * dt, 5);
    } finally {
      world.time.fixedDeltaTime = fixed;
    }
    destroyAll();
  });

  it("releases its clips and ends its plays stopped when destroyed", async () => {
    const { node, anim } = await hero();
    const play = anim.play(RUN_COPY);
    await settle(anim);
    const core = animationCoreOf(world)!.core;
    const before = core.stats();
    GameObject.destroy(node);
    engine.step(0);
    expect(await play).toEqual({ reason: "stopped" });
    const after = core.stats();
    expect(after.idleAssets - before.idleAssets).toBe(1); // the copy; the skeleton is still held by "Keeper"
    expect(after.instances).toBe(before.instances - 1);
    expect(instanceForSkeleton(world, node)).toBe(0);
    expect(await anim.play(WALK)).toEqual({ reason: "stopped" }); // a destroyed Animator plays nothing
    destroyAll();
  });
});

/** The root curve at frame `f` (x, y, z, yaw). */
const curve = (f: number) => Array.from(walkInfo.rootCurve!.subarray(f * 4, f * 4 + 4));

/** Where 10 frames of walk move a node that starts at the origin facing +Z: the curve's movement in its frame 0. */
function walkedTen(): { position: Vector3; yaw: number } {
  const [x0, y0, z0, yaw0] = curve(0);
  const [x1, y1, z1, yaw1] = curve(10);
  const [dx, dy, dz] = [x1! - x0!, y1! - y0!, z1! - z0!];
  const s = Math.sin(yaw0!), c = Math.cos(yaw0!);
  return { position: new Vector3(c * dx - s * dz, dy, s * dx + c * dz), yaw: yaw1! - yaw0! };
}

const yawOf = (q: Quaternion) => 2 * Math.atan2(q.y, q.w);

describe("root motion", () => {
  it("moves the node by the clip's root curve in transform mode", async () => {
    const { node, anim } = await hero({ rootMotion: "transform" });
    anim.play(WALK);
    await settle(anim);
    steps(10);
    const want = walkedTen();
    expect(Vector3.distance(node.transform!.worldPosition, want.position)).toBeLessThan(TOL);
    expect(Math.abs(yawOf(node.transform!.worldRotation) - want.yaw)).toBeLessThan(TOL);
    expect(want.position.length).toBeGreaterThan(0.05);
    destroyAll();
  });

  it("fills the RootMotion buffer in mode none, and leaves the node where it is", async () => {
    const { node, anim } = await hero({ rootMotion: "none" });
    const records: { x: number; z: number }[] = [];
    node.addBehavior(
      class extends GameBehavior {
        lateUpdate(): void {
          for (const r of RootMotion.read()) if (r.node === this.node) records.push({ x: r.delta.position.x, z: r.delta.position.z });
        }
      },
    );
    anim.play(WALK);
    await settle(anim);
    records.length = 0;
    steps(10);
    expect(records).toHaveLength(10);
    // Composed in successive frames, they make the curve's movement (the heading turns only a little in 10 frames,
    // so the plain sum is checked against the composed total within its yaw's effect).
    const sum = records.reduce((a, r) => ({ x: a.x + r.x, z: a.z + r.z }), { x: 0, z: 0 });
    const want = walkedTen();
    expect(Math.hypot(sum.x - want.position.x, sum.z - want.position.z)).toBeLessThan(Math.abs(want.yaw) * want.position.length + TOL);
    expect(node.transform!.worldPosition.length).toBe(0);
    destroyAll();
  });

  it("moves a CharacterController in characterController mode (physics on, fixed steps)", async () => {
    const fixed = world.time.fixedDeltaTime;
    world.time.fixedDeltaTime = dt;
    try {
      const node = GameObject.create("Walker");
      made.push(node);
      node.addComponent(CharacterController);
      node.addComponent(Skeleton, { skeleton: SKEL });
      const anim = node.addComponent(Animator, { updateMode: "fixed", rootMotion: "characterController" });
      await vi.waitFor(() => expect(instanceForSkeleton(world, node)).not.toBe(0));
      anim.play(WALK);
      await tick();
      steps(10);
      const want = walkedTen();
      // The controller moves the node unobstructed here (no colliders); 1e-3 allows its contact offset.
      expect(Vector3.distance(node.transform!.worldPosition, want.position)).toBeLessThan(1e-3);
    } finally {
      world.time.fixedDeltaTime = fixed;
    }
    destroyAll();
  });
});

describe("root motion into a RigidBody (physics on)", () => {
  it("moves a kinematic body's node, and gives a dynamic body the motion as velocity", async () => {
    const fixed = world.time.fixedDeltaTime;
    world.time.fixedDeltaTime = dt;
    try {
      const make = (name: string, bodyType: "kinematic" | "dynamic") => {
        const node = GameObject.create(name);
        made.push(node);
        node.addComponent(RigidBody, { bodyType, useGravity: false });
        node.addComponent(Skeleton, { skeleton: SKEL });
        return { node, anim: node.addComponent(Animator, { updateMode: "fixed", rootMotion: "rigidBody" }) };
      };
      const kinematic = make("Kinematic", "kinematic");
      const dynamic = make("Dynamic", "dynamic");
      await vi.waitFor(() => expect(instanceForSkeleton(world, kinematic.node) && instanceForSkeleton(world, dynamic.node)).not.toBe(0));
      kinematic.anim.play(WALK);
      dynamic.anim.play(WALK);
      await tick();
      steps(10);
      expect(Vector3.distance(kinematic.node.transform!.worldPosition, walkedTen().position)).toBeLessThan(1e-3);
      // The dynamic body's planar speed is the last step's root movement over the step (the turn doesn't change it).
      const [x9, , z9] = curve(9), [x10, , z10] = curve(10);
      const v = dynamic.node.getComponent(RigidBody)!.velocity;
      expect(Math.abs(Math.hypot(v.x, v.z) - Math.hypot(x10! - x9!, z10! - z9!) / dt)).toBeLessThan(1e-3);
    } finally {
      world.time.fixedDeltaTime = fixed;
    }
    destroyAll();
  });
});

describe("culling and LOD", () => {
  function camera(at: [number, number, number], yaw = 0): GameObject {
    const node = GameObject.create("Camera");
    made.push(node);
    node.transform!.position = at;
    node.transform!.rotation = Quaternion.rotateY(yaw);
    node.addComponent(Camera, { projection: "perspective", fieldOfView: 60 });
    return node;
  }

  it("freezes the pose of a whenVisible Animator no camera sees, and catches up when seen", async () => {
    const cam = camera([0, 1, -10]); // facing +Z: sees the origin
    const { node, anim } = await hero({ cullingMode: "whenVisible" });
    const { node: other, anim: always } = await hero({ cullingMode: "always" });
    anim.play(WALK);
    always.play(WALK);
    await settle(anim, always);
    steps(4);
    const seen = matrices(node);
    const version = skinningVersion(world, node);
    cam.transform!.rotation = Quaternion.rotateY(Math.PI); // looking away
    steps(5);
    expect(maxDiff(matrices(node), [...seen!])).toBe(0);
    expect(skinningVersion(world, node)).toBe(version);
    expect(maxDiff(matrices(other), expected.play)).toBeGreaterThan(0); // "always" kept animating (frame 9)
    cam.transform!.rotation = Quaternion.identity;
    steps(1);
    expect(maxDiff(matrices(node), expected.play)).toBeLessThan(TOL); // the playhead kept going
    expect(maxDiff(matrices(other), expected.play)).toBeLessThan(TOL);
    destroyAll();
  });

  /** Two heroes, one at full rate and one with `lod`: the LOD one shows the last evaluated pose every other frame. */
  async function everySecondFrame(lod: HeroOptions): Promise<void> {
    const { node: a, anim: full } = await hero();
    const { node: b, anim: slow } = await hero(lod);
    full.play(WALK);
    slow.play(WALK);
    await settle(full, slow);
    let previous = matrices(a)!;
    let behind = 0;
    for (let f = 0; f < 10; f++) {
      steps(1);
      const now = matrices(a)!;
      const shown = matrices(b)!;
      expect(maxDiff(now, [...previous])).toBeGreaterThan(0); // the full-rate one moves every frame
      expect(maxDiff(shown, [...now])).toBeGreaterThan(0); // the LOD one never shows the current pose
      if (maxDiff(shown, [...previous]) < 1e-6) behind++;
      previous = now;
    }
    expect(behind).toBe(5); // every other frame it shows the last evaluated pose; between, a lerp
  }

  it("updates the pose every 2nd frame past lodEvery2 metres, interpolated, one frame behind", async () => {
    camera([0, 1, -30]); // 30 m: past lodEvery2 (20), before lodEvery4 (40)
    await everySecondFrame({ lodMetric: "distance" });
    destroyAll();
  });

  it("updates the pose every 2nd frame below lodEvery2 of the screen's height", async () => {
    camera([0, 1, -30]); // the rig covers a few percent of the view's height
    await everySecondFrame({ lodMetric: "screenSize", lodEvery2: 0.5, lodEvery4: 0.001 });
    destroyAll();
  });

  describe('lodMetric "lodGroup" (ADR 0459 §6)', () => {
    /** The poses `hero(lod)` shows for 12 frames, each next to the poses of a reference hero at the same frame. */
    async function sameAsReference(group: HeroOptions["group"], reference: HeroOptions): Promise<void> {
      const { node: a, anim: grouped } = await hero({ lodMetric: "lodGroup", group });
      const { node: b, anim: ref } = await hero(reference);
      grouped.play(WALK);
      ref.play(WALK);
      await settle(grouped, ref);
      for (let f = 0; f < 12; f++) {
        steps(1);
        expect(maxDiff(matrices(a), [...matrices(b)!])).toBeLessThan(1e-6);
      }
    }
    const LEVELS = [0.5, 0.1, 0.02];

    it("level 0 updates every frame", async () => {
      camera([0, 1, -3]);
      await sameAsReference({ levels: LEVELS, forceLevel: 0 }, { lodMetric: "off" });
      destroyAll();
    });

    it("level 1 updates every 2nd frame, interpolated, as distance LOD's step 2 does", async () => {
      camera([0, 1, -30]);
      await sameAsReference({ levels: LEVELS, forceLevel: 1 }, { lodMetric: "distance" }); // 30 m: past lodEvery2 (20), before lodEvery4 (40)
      destroyAll();
    });

    it("level 2 and below update every 4th frame, as distance LOD's step 4 does", async () => {
      camera([0, 1, -30]);
      await sameAsReference({ levels: LEVELS, forceLevel: 2 }, { lodMetric: "distance", lodEvery2: 1, lodEvery4: 2 });
      destroyAll();
    });

    it("counts a group culled by LOD as not visible for cullingMode, and sees it again when it draws", async () => {
      const cam = camera([0, 1, -40]); // far past the last height: the group is culled
      const { node, anim } = await hero({ lodMetric: "lodGroup", cullingMode: "rootMotionOnly", group: { levels: [0.5, 0.1] } });
      const group = node.getComponent(LODGroup)!;
      anim.play(WALK);
      await settle(anim);
      steps(3);
      expect(group.currentLevel).toBe(-1);
      expect(matrices(node)).toBeNull(); // culled from the start: no pose evaluated
      cam.transform!.position = [0, 1, -3];
      steps(2);
      expect(group.currentLevel).toBe(0);
      expect(matrices(node)).not.toBeNull();
      destroyAll();
    });

    it("an Animator under no group, or a World without one, updates every frame", async () => {
      camera([0, 1, -30]);
      await sameAsReference(undefined, { lodMetric: "off" });
      destroyAll();
    });

    it("reads the level the group has in the same frame, with no frame of lag", async () => {
      camera([0, 1, -3]);
      const { node, anim } = await hero({ lodMetric: "lodGroup", group: { levels: LEVELS, forceLevel: 0 } });
      anim.play(WALK);
      await settle(anim);
      steps(2);
      const rt = [...animatorsOf(world)].find((r) => r.animator === anim)!;
      const group = node.getComponent(LODGroup)!;
      expect(lodStep(cameraViews(world), rt)).toBe(1);
      // Changed after the stage's own run for this frame (after propagation): the gather still sees it.
      group.forceLevel = 1;
      expect(lodStep(cameraViews(world), rt)).toBe(2);
      group.forceLevel = 2;
      expect(lodStep(cameraViews(world), rt)).toBe(4);
      destroyAll();
    });
  });

  it("keeps root motion but freezes the pose of a rootMotionOnly Animator no camera sees", async () => {
    camera([0, 1, -10], Math.PI); // looking away
    const { node, anim } = await hero({ cullingMode: "rootMotionOnly", rootMotion: "transform" });
    anim.play(WALK);
    await settle(anim);
    expect(matrices(node)).toBeNull(); // unseen from the start: no pose evaluated
    steps(10);
    expect(matrices(node)).toBeNull();
    expect(Vector3.distance(node.transform!.worldPosition, walkedTen().position)).toBeLessThan(TOL);
    destroyAll();
  });
});

describe("BoneAttachment", () => {
  /** The world matrix (column-major) of bone `b` of `node`'s skeleton for expected.play's pose, times `offset`. */
  function boneWorld(node: GameObject, b: number, offset: { p: Vector3; q: Quaternion }): Float64Array {
    const model = new Float64Array(12);
    multiply34(model, 0, expected.play, b * 12, skel.bind, b * 12);
    const bone = new Float64Array(16), skelWorld = new Float64Array(16), off = new Float64Array(16), t = new Float64Array(16), out = new Float64Array(16);
    toMat4(bone, 0, model, 0);
    Mat4.copy(skelWorld, 0, node.transform!.localToWorld.value, 0);
    Mat4.compose(off, 0, [offset.p.x, offset.p.y, offset.p.z], 0, [offset.q.x, offset.q.y, offset.q.z, offset.q.w], 0, [1, 1, 1], 0);
    Mat4.multiplyAffine(t, 0, skelWorld, 0, bone, 0);
    Mat4.multiplyAffine(out, 0, t, 0, off, 0);
    return out;
  }

  const sameRotation = (a: Quaternion, b: Quaternion) => 1 - Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);

  it("follows a bone after propagation, in each follow mode", async () => {
    const { node, anim } = await hero({ position: [1, 2, 3] });
    node.transform!.rotation = Quaternion.rotateY(Math.PI / 2);
    const b = skel.bones - 1;
    const boneName = skel.names[b]!;
    const offset = { p: new Vector3(0, 0.1, 0.05), q: Quaternion.rotateX(0.3) };
    const own = { p: new Vector3(7, 8, 9), q: Quaternion.rotateZ(0.5) };
    const attach = (follow: "both" | "position" | "rotation", explicit: boolean) => {
      const n = GameObject.create(`Prop-${follow}`, { parent: explicit ? null : node });
      if (explicit) made.push(n);
      n.transform!.worldPosition = own.p;
      n.transform!.worldRotation = own.q;
      n.addComponent(BoneAttachment, { skeleton: explicit ? node : null, bone: boneName, offsetPosition: offset.p, offsetRotation: offset.q, follow });
      return n;
    };
    const both = attach("both", false);
    const position = attach("position", true); // names its skeleton node instead of sitting under it
    const rotation = attach("rotation", false);
    const child = GameObject.create("Tip", { parent: both });
    child.transform!.position = [0, 0, 1];
    anim.play(WALK);
    await settle(anim);
    steps(10);
    const want = boneWorld(node, b, offset);
    const wantPos = new Vector3(want[12]!, want[13]!, want[14]!);
    const wantRot = node.transform!.localToWorld.rotation; // replaced below by the bone's
    const p = new Float64Array(3), q = new Float64Array(4), s = new Float64Array(3);
    Mat4.decompose(want, 0, p as unknown as number[], 0, q as unknown as number[], 0, s as unknown as number[], 0);
    wantRot.set(q[0]!, q[1]!, q[2]!, q[3]!);

    expect(Vector3.distance(both.transform!.worldPosition, wantPos)).toBeLessThan(TOL);
    expect(sameRotation(both.transform!.worldRotation, wantRot)).toBeLessThan(TOL);
    // Its children were propagated after it moved: the tip is 1 along the attachment's +Z.
    const tip = Vector3.add(wantPos, Quaternion.rotate(wantRot, [0, 0, 1]));
    expect(Vector3.distance(child.transform!.localToWorld.position, tip)).toBeLessThan(TOL);

    expect(Vector3.distance(position.transform!.worldPosition, wantPos)).toBeLessThan(TOL);
    expect(sameRotation(position.transform!.worldRotation, own.q)).toBeLessThan(TOL);

    expect(Vector3.distance(rotation.transform!.worldPosition, own.p)).toBeLessThan(TOL);
    expect(sameRotation(rotation.transform!.worldRotation, wantRot)).toBeLessThan(TOL);
    destroyAll();
  });

  it("follows the rest pose of a skeleton no Animator animates", async () => {
    const rig = GameObject.create("Statue");
    made.push(rig);
    rig.addComponent(Skeleton, { skeleton: SKEL });
    const b = 1;
    const prop = GameObject.create("Prop", { parent: rig });
    prop.addComponent(BoneAttachment, { bone: skel.names[b]! });
    await vi.waitFor(() => {
      engine.step(0);
      expect(prop.transform!.worldPosition.length).toBeGreaterThan(0);
    });
    const at = new Vector3(skel.restModel[b * 12 + 3]!, skel.restModel[b * 12 + 7]!, skel.restModel[b * 12 + 11]!);
    expect(Vector3.distance(prop.transform!.worldPosition, at)).toBeLessThan(1e-6);
    destroyAll();
  });
});

describe("without the physics plugin", () => {
  it("characterController mode only fills the RootMotion buffer, with one warning", async () => {
    engine.dispose();
    applyTestPlugins(["myco.physics"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      engine = await Engine.create({ headless: true });
      world = engine.world;
      const { node, anim } = await hero({ rootMotion: "characterController" });
      let records = 0;
      node.addBehavior(
        class extends GameBehavior {
          lateUpdate(): void {
            records += RootMotion.read().filter((r) => r.node === this.node).length;
          }
        },
      );
      anim.play(WALK);
      await settle(anim);
      records = 0;
      steps(5);
      expect(records).toBe(5);
      expect(node.transform!.worldPosition.length).toBe(0);
      expect(warn.mock.calls.filter(([m]) => String(m).includes("characterController"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      applyTestPlugins();
    }
  });
});
