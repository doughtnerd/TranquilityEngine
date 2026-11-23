// The Ragdoll (ADR 0375; T44) in a headless Engine with 3D physics (Rapier, as T43's ball-joint tests run it) and the
// animation core: a small upright character with turned rest frames (so the joint-frame conversion is exercised),
// animated by a graph whose output is `physicsBlend(machine, physicalPose)`; its Idle state holds a pose clip that bends
// the spine, raises and twists the arm and bends the leg. Time comes from `engine.step` only. The visible pose is read
// through the render-sync contract (`skinningMatrices`), bodies through `Ragdoll.body`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, BoxCollider, Engine, GameObject, Quaternion, RigidBody, SceneManager, Skeleton, Vector3 } from "../../myco";
import type { World } from "../../engine/core/World";
import type { ComponentInit } from "../../engine/scene/GameObject";
import { Mat4 } from "../../engine/core/math";
import { emptyAnimSource } from "../../engine/animation/animSource";
import { compileRawClip } from "../../engine/animation/compile/rawClip";
import { encodeSkeleton } from "../../engine/animation/import/skeletonBinary";
import { invert34, multiply34, toMat4 } from "../animation/runtime/affine";
import { skinningMatrices } from "../animation/runtime/skeletonInstances";
import { Ragdoll, type RagdollBone } from "./runtime";

// ------------------------------------------------------------------------------------------------ the character

const turn = (axis: [number, number, number], angle: number) => Quaternion.axisAngle(axis, angle);
/** Bones: name, parent, local position, local rest rotation. The thigh's x axis points down the leg. */
const BONES: [string, number, [number, number, number], Quaternion][] = [
  ["pelvis", -1, [0, 1, 0], new Quaternion()],
  ["spine", 0, [0, 0.3, 0], turn([0, 1, 0], 0.4)],
  ["head", 1, [0, 0.3, 0], new Quaternion()],
  ["arm", 1, [0.15, 0.25, 0], Quaternion.mul(turn([0, 1, 0], 0.5), turn([0, 0, 1], 0.3))],
  ["hand", 3, [0.3, 0, 0], new Quaternion()],
  ["thigh", 0, [0.1, -0.05, 0], turn([0, 0, 1], -Math.PI / 2)],
  ["shin", 5, [0.45, 0, 0], new Quaternion()],
  ["foot", 6, [0.4, 0, 0], new Quaternion()],
];
const NAMES = BONES.map((b) => b[0]);
const bone = (b: string) => NAMES.indexOf(b);
const restRotations: Quaternion[] = [];
const restPositions: Vector3[] = [];
BONES.forEach(([, parent, t, r], i) => {
  restRotations[i] = parent < 0 ? r.clone() : Quaternion.mul(restRotations[parent]!, r);
  restPositions[i] = parent < 0 ? new Vector3(...t) : Quaternion.rotate(restRotations[parent]!, t).add(restPositions[parent]!);
});
const restModel = (b: number): Vector3 => restPositions[b]!.clone();

/** The animated local rotations (Idle's clip); other bones keep their rest rotation. */
const ANIMATED: Record<string, Quaternion> = {
  spine: Quaternion.mul(BONES[1]![3], turn([1, 0, 0], 0.3)),
  arm: Quaternion.mul(BONES[3]![3], Quaternion.mul(turn([0, 0, 1], 0.5), turn([1, 0, 0], 0.3))),
  thigh: Quaternion.mul(BONES[5]![3], turn([0, 1, 0], 0.4)),
  shin: turn([0, 1, 0], -0.6),
};
const animatedLocal = (name: string) => ANIMATED[name] ?? BONES[bone(name)]![3];

/** Bone `b`'s rest model 3×4 (row-major). */
function restMatrix(b: number): Float64Array {
  const q = restRotations[b]!, p = restPositions[b]!;
  const { x, y, z, w } = q;
  return new Float64Array([
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), p.x,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), p.y,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), p.z,
  ]);
}

function skeletonBytes(): Uint8Array {
  const inverseBinds = new Float32Array(BONES.length * 12);
  const inv = new Float64Array(12);
  BONES.forEach((_, i) => {
    invert34(inv, 0, restMatrix(i), 0);
    inverseBinds.set(inv, i * 12);
  });
  return encodeSkeleton({
    bones: BONES.map(([name, parent, position, r]) => ({ name, parent, rest: { position, rotation: [r.x, r.y, r.z, r.w], scale: [1, 1, 1] } })),
    inverseBinds,
    roles: BONES.map(() => null),
    profile: null,
  });
}

const key = (q: Quaternion, t: number): [number, number, number, number, number] => [t, q.x, q.y, q.z, q.w];
/** The pose clip in its raw form (`myco.anim@1`), bound to the skeleton by name. */
const poseClip = () => compileRawClip(POSE, { names: NAMES, rest: BONES.flatMap(([, , t, r]) => [...t, r.x, r.y, r.z, r.w, 1, 1, 1]) }).bytes;
const POSE = { ...emptyAnimSource(), name: "Pose", duration: 1, loop: true, tracks: Object.entries(ANIMATED).map(([b, q]) => ({ kind: "bone" as const, bone: b, translation: [], scale: [], rotation: [key(q, 0), key(q, 1)] })) };

const node = (id: string, family: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, family, kind, ...extra });
/** Idle holds the pose clip; the get-up states start from the snapshot (back) or the rest pose (front), entered by a cut. */
const GRAPH = {
  format: "myco.animgraph-source@1",
  output: "blend",
  parameters: [{ name: "ragdollBlend", type: "float", default: 0 }],
  nodes: [
    node("idle", "sources", "clipPlayer", { params: { clip: "asset:anim/pose.anim" } }),
    node("front", "sources", "referencePose"),
    node("fallback", "sources", "referencePose"),
    node("snapshot", "sources", "poseSnapshot", { params: { mode: "onEnter" } }),
    node("physical", "physics", "physicalPose", { inputs: ["fallback"] }),
    node("machine", "logic", "stateMachine", {
      machine: {
        entry: "Idle",
        states: [
          {
            name: "Idle",
            root: "idle",
            transitions: [
              { to: "GetUpFromBack", if: { request: "Back" }, how: "cut" },
              { to: "GetUpFromFront", if: { request: "Front" }, how: "cut" },
            ],
          },
          { name: "GetUpFromBack", root: "snapshot", transitions: [] },
          { name: "GetUpFromFront", root: "front", transitions: [] },
        ],
        anyState: [],
      },
    }),
    node("blend", "physics", "physicsBlend", { inputs: ["machine", "physical"], params: { weight: "ragdollBlend" } }),
  ],
};

/** Explicit bodies: a box pelvis, capsules along each segment (2 kg each), the pelvis pinned in powered mode. */
const capsule = (bone: string, axis: "x" | "y", length: number, sign = 1): RagdollBone => ({
  bone,
  shape: "capsule",
  size: { x: 0.05, y: length, z: 0.05 },
  center: axis === "x" ? { x: (sign * length) / 2, y: 0, z: 0 } : { x: 0, y: (sign * length) / 2, z: 0 },
  axis,
  mass: 2,
  swing: { y: 60, z: 60 },
  twist: { min: -30, max: 30 },
  stiffness: 400,
  damping: 40,
  maxForce: 1000,
  strength: 1,
  pin: 0,
});
const BODIES: RagdollBone[] = [
  { ...capsule("pelvis", "y", 0.2), shape: "box", size: { x: 0.3, y: 0.15, z: 0.2 }, center: { x: 0, y: 0, z: 0 }, mass: 8, pin: 1 },
  capsule("spine", "y", 0.3),
  capsule("arm", "x", 0.3),
  capsule("thigh", "x", 0.45),
  capsule("shin", "x", 0.4),
];

// ------------------------------------------------------------------------------------------------ the World

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } };
const dt = 1 / 60;
let engine: Engine;
let world: World;
const made: GameObject[] = [];

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@5", settings: { physics: "3d" }, nodes: [] },
      "anim/dummy.skel": `data:application/octet-stream;base64,${Buffer.from(skeletonBytes()).toString("base64")}`,
      "dummy.animgraph.json": GRAPH,
      "anim/pose.anim": `data:application/octet-stream;base64,${Buffer.from(poseClip()).toString("base64")}`,
    }),
  );
  engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  world = engine.world;
  const floor = GameObject.create("Floor");
  floor.transform!.position.set(0, -0.5, 0);
  floor.addBehavior(BoxCollider).size.set(40, 1, 40);
});

afterAll(() => engine?.dispose());

const steps = (n: number) => {
  for (let i = 0; i < n; i++) engine.step(dt);
};

function destroyAll(): void {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
}

/** A character at `x` (on the z = 0 line), its Animator in fixed steps. */
async function character(name: string, x: number, init: ComponentInit<Ragdoll> = {}): Promise<{ node: GameObject; anim: Animator; ragdoll: Ragdoll }> {
  const go = GameObject.create(name);
  made.push(go);
  go.transform!.position.set(x, 0, 0);
  go.addComponent(Skeleton, { skeleton: "anim/dummy.skel" });
  const anim = go.addComponent(Animator, { graph: "dummy.animgraph.json", updateMode: "fixed" });
  const ragdoll = go.addComponent(Ragdoll, { bones: BODIES.map((b) => ({ ...b })), ...init });
  await vi.waitFor(() => {
    engine.step(dt); // a fixed-mode Animator evaluates in fixed steps only
    expect(skinningMatrices(world, go)).not.toBeNull();
  });
  return { node: go, anim, ragdoll };
}

/** Steps until the ragdoll's bodies exist and simulate (spawn, push, teleport). */
async function simulating(r: Ragdoll): Promise<void> {
  await vi.waitFor(() => {
    engine.step(dt);
    expect(r.body("pelvis")).not.toBeNull();
  });
  steps(3);
}

/** Bone `b`'s model 3×4 from the visible pose (model = skinning × bind). */
function model(go: GameObject, b: number): Float64Array {
  const m = skinningMatrices(world, go)!;
  const out = new Float64Array(12);
  multiply34(out, 0, m, b * 12, restMatrix(b), 0);
  return out;
}
function rotationOf(m: Float64Array): Quaternion {
  const m4 = new Float64Array(16);
  toMat4(m4, 0, m, 0);
  const pos = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1];
  Mat4.decompose(m4, 0, pos, 0, q, 0, s, 0);
  return new Quaternion(q[0]!, q[1]!, q[2]!, q[3]!);
}
/** The visible local rotation of bone `name`. */
function localRotation(go: GameObject, name: string): Quaternion {
  const b = bone(name);
  const parent = rotationOf(model(go, BONES[b]![1]));
  return Quaternion.mul(Quaternion.inverse(parent), rotationOf(model(go, b)));
}
const visibleHeight = (go: GameObject, name: string) => model(go, bone(name))[7]!;
/** How far bone `name`'s visible local rotation is from the animated one (radians). */
const offAnimation = (go: GameObject, name: string) => Quaternion.angle(localRotation(go, name), animatedLocal(name));
const pos = (r: Ragdoll, b: string) => r.body(b)!.transform!.worldPosition;
const rot = (r: Ragdoll, b: string) => r.body(b)!.transform!.worldRotation;

// ------------------------------------------------------------------------------------------------ tests

describe("Ragdoll modes (ADR 0375)", () => {
  it("ragdoll mode falls under gravity: the pelvis drops, the bodies stay joined within their limits, the pose follows", async () => {
    const { node: go, ragdoll } = await character("Limp", 0, { mode: "ragdoll" });
    await simulating(ragdoll);
    const start = pos(ragdoll, "pelvis").y;
    expect(start).toBeGreaterThan(0.9);
    steps(150);
    const pelvis = pos(ragdoll, "pelvis");
    expect(pelvis.y).toBeLessThan(0.5);
    // Joined: each child body's origin stays where its rest offset puts it in its parent body's frame (the joint anchor).
    for (const [child, parent] of [["spine", "pelvis"], ["arm", "spine"], ["thigh", "pelvis"], ["shin", "thigh"]] as const) {
      const offset = Quaternion.rotate(Quaternion.inverse(restRotations[bone(parent)]!), Vector3.sub(restModel(bone(child)), restModel(bone(parent))));
      const anchor = Quaternion.rotate(rot(ragdoll, parent), offset).add(pos(ragdoll, parent));
      expect(Vector3.sub(anchor, pos(ragdoll, child)).length, `${child} to ${parent}`).toBeLessThan(0.03);
      // Within the limits: a 60° cone and ±30° of twist (Rapier limits each axis on its own: the box's corner, plus slack).
      const relative = Quaternion.mul(Quaternion.inverse(rot(ragdoll, parent)), rot(ragdoll, child));
      const rest = Quaternion.mul(Quaternion.inverse(restRotations[bone(parent)]!), restRotations[bone(child)]!);
      expect((Quaternion.angle(relative, rest) * 180) / Math.PI, `${child} turn`).toBeLessThan(100);
    }
    // The visible pose is the simulated one (blend 1): the pelvis bone where its body is, in the node's frame.
    expect(Math.abs(visibleHeight(go, "pelvis") - pelvis.y)).toBeLessThan(0.02);
    destroyAll();
  });

  it("powered mode holds the animated pose against gravity; a limp arm drops", async () => {
    const powered = await character("Powered", 3, { mode: "powered" });
    const limp = await character("LimpArm", 6, { mode: "ragdoll", bones: BODIES.map((b) => ({ ...b, pin: b.bone === "pelvis" ? 1 : 0 })) });
    await simulating(powered.ragdoll);
    await simulating(limp.ragdoll);
    steps(120);
    // Pinned pelvis: where the animation has it.
    expect(Vector3.sub(pos(powered.ragdoll, "pelvis"), new Vector3(3, 1, 0)).length).toBeLessThan(0.02);
    // Every driven joint near its animated rotation. Measured: spine 0.010, arm 0.004, thigh 0.009, shin 0.000 rad.
    // Tolerance 0.03 rad: gravity's sag against stiffness 400 plus Rapier's residual, which is exact for a turn about one
    // axis (the shin) and grows with combined angles (the spine, arm and thigh turn about two; D89).
    for (const b of ["spine", "arm", "thigh", "shin"]) expect(offAnimation(powered.node, b), b).toBeLessThan(0.03);
    // Without muscles the same arm hangs.
    expect(offAnimation(limp.node, "arm")).toBeGreaterThan(0.5);
    destroyAll();
  });

  it("blend 0.5 shows the pose halfway between the animation and the simulation", async () => {
    const half = await character("Half", 9, { mode: "ragdoll", blend: 0.5 });
    const full = await character("Full", 12, { mode: "ragdoll", blend: 1 });
    await simulating(half.ragdoll);
    await simulating(full.ragdoll);
    steps(150);
    // The root's local transform is its model one: physicsBlend lerps it (animated height 1).
    const physical = pos(half.ragdoll, "pelvis").y;
    expect(physical).toBeLessThan(0.5);
    expect(visibleHeight(half.node, "pelvis")).toBeCloseTo((1 + physical) / 2, 1);
    expect(Math.abs(visibleHeight(full.node, "pelvis") - pos(full.ragdoll, "pelvis").y)).toBeLessThan(0.02);
    destroyAll();
  });

  it("switches modes: off makes no bodies, ragdoll and powered share them, off again removes them and shows the animation", async () => {
    const { node: go, ragdoll } = await character("Switch", 15, { mode: "off" });
    steps(10);
    expect(ragdoll.body("pelvis")).toBeNull();
    expect(visibleHeight(go, "pelvis")).toBeCloseTo(1, 4);
    ragdoll.mode = "ragdoll";
    await simulating(ragdoll);
    const body = ragdoll.body("pelvis")!;
    steps(60);
    expect(pos(ragdoll, "pelvis").y).toBeLessThan(0.9);
    ragdoll.mode = "powered";
    steps(90);
    expect(ragdoll.body("pelvis")).toBe(body); // the same bodies, now driven and pinned
    expect(Vector3.sub(pos(ragdoll, "pelvis"), new Vector3(15, 1, 0)).length).toBeLessThan(0.05);
    ragdoll.autoGetUp = false;
    ragdoll.mode = "off";
    steps(2);
    expect(ragdoll.body("pelvis")).toBeNull();
    expect(body.isValid).toBe(false);
    expect(visibleHeight(go, "pelvis")).toBeCloseTo(1, 4);
    destroyAll();
  });

  it("a teleport of the character resets the bodies to its animated pose", async () => {
    const { node: go, ragdoll } = await character("Jumper", 18, { mode: "ragdoll" });
    await simulating(ragdoll);
    steps(60);
    go.transform!.position.set(30, 5, 0);
    steps(1);
    expect(Vector3.sub(pos(ragdoll, "pelvis"), new Vector3(30, 6, 0)).length).toBeLessThan(0.1);
    destroyAll();
  });

  it("an empty bone list uses the skeleton's default ragdoll (every bone, shapes from the rest pose)", async () => {
    const { ragdoll } = await character("Default", 21, { mode: "ragdoll", bones: [] });
    await simulating(ragdoll);
    for (const n of NAMES) expect(ragdoll.body(n), n).not.toBeNull();
    expect(ragdoll.body("arm")!.getBehavior(RigidBody)!.mass).toBeGreaterThan(0.1);
    steps(150);
    expect(pos(ragdoll, "pelvis").y).toBeLessThan(0.6);
    destroyAll();
  });
});

describe("Ragdoll get-up (ADR 0375)", () => {
  /** Lays every body down about the x axis through the feet (angle −90°: on the back; +90°: on the front). */
  function lay(r: Ragdoll, x: number, angle: number): void {
    const turn = Quaternion.axisAngle([1, 0, 0], angle);
    const pivot = new Vector3(x, 0.15, 0);
    for (const n of NAMES) {
      const b = r.body(n);
      if (!b) continue;
      const t = b.transform!;
      const p = Quaternion.rotate(turn, Vector3.sub(t.worldPosition, pivot)).add(pivot);
      const q = Quaternion.mul(turn, t.worldRotation);
      t.worldPosition = p;
      t.worldRotation = q;
      b.getBehavior(RigidBody)!.velocity = { x: 0, y: 0, z: 0 };
    }
  }

  it.each([
    ["on its back", -Math.PI / 2, "GetUpFromBack"],
    ["on its front", Math.PI / 2, "GetUpFromFront"],
  ])("lying %s, getUp() enters %s and turns the ragdoll off", async (_name, angle, state) => {
    const { node: go, anim, ragdoll } = await character(`Lying${angle}`, 24, { mode: "ragdoll" });
    await simulating(ragdoll);
    lay(ragdoll, 24, angle);
    steps(30);
    const lying = rot(ragdoll, "pelvis");
    const done = ragdoll.getUp();
    steps(3);
    await expect(done).resolves.toEqual({ reason: "arrived" });
    expect(anim.state().name).toBe(state);
    expect(ragdoll.mode).toBe("off");
    expect(ragdoll.body("pelvis")).toBeNull();
    if (state === "GetUpFromBack") {
      // The state's root is the pose snapshot: the pelvis shows the lying rotation it was captured in.
      expect(Quaternion.angle(rotationOf(model(go, bone("pelvis"))), lying)).toBeLessThan(0.05);
    }
    destroyAll();
  });

  it("goes off with autoGetUp: ragdoll → off gets up by itself; getUp() without bodies is unreachable", async () => {
    const { anim, ragdoll } = await character("Auto", 27, { mode: "ragdoll" });
    await expect(ragdoll.getUp()).resolves.toEqual({ reason: "unreachable" }); // not simulating yet
    await simulating(ragdoll);
    lay(ragdoll, 27, -Math.PI / 2);
    steps(30);
    ragdoll.mode = "off";
    steps(3);
    expect(anim.state().name).toBe("GetUpFromBack");
    destroyAll();
  });
});

