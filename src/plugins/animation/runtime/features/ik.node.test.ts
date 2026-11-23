// ADR 0370, 0372 (T40t): the rig stack on the ECS in a headless Engine, through the public API (`myco`), the render-sync
// contract (`skeletonInstances.ts`) and physics colliders. Graph sources are compiled at run time by T30's compiler on
// the rig test skeleton (`../wasm/fixtures/rig.skel`: identity inverse binds, so skinning matrices are model-space bone
// transforms; left leg = bones 6, 7, 8, right leg 9, 10, 11, pelvis 1), and the warp test plays T31's straight walk
// (`graph_walk.anim`: 1 s, 1.4 m along +Z) on `small.skel`. Time comes from `engine.step(dt)` only.
//
// Tolerances: a two-bone IK solve is analytic, so a reachable target is met to f32 rounding of a few transforms: 1e-4
// m. The weight-0 and no-physics cases compare two instances fed the same inputs in one core (deterministic): 1e-6.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, BoxCollider, Camera, Engine, GameObject, Quaternion, Skeleton, Vector3 } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { applyTestPlugins } from "../../../testPlugins";
import { skinningMatrices } from "../skeletonInstances";

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const dt = 1 / 30;
const SAME = 1e-6;
const SOLVED = 1e-4;
const LEFT_FOOT = 8, RIGHT_FOOT = 11;

const rest = { id: "rest", family: "sources", kind: "referencePose" };
const twoBone = (extra: Record<string, unknown> = {}) => ({
  id: "ik",
  family: "rig",
  kind: "twoBoneIk",
  inputs: ["rest"],
  params: { root: "bone6", mid: "bone7", tip: "bone8", target: "LeftFoot", tipMode: "maintain", ...extra },
});
const IK = { format: "myco.animgraph-source@1", output: "ik", nodes: [rest, twoBone()] };
const IK_HALF = { format: "myco.animgraph-source@1", output: "ik", nodes: [rest, twoBone({ weight: 0.5 })] };
const IK_LOD = { format: "myco.animgraph-source@1", output: "ik", nodes: [rest, twoBone({ lodSkip: 1 })] };
const REST = { format: "myco.animgraph-source@1", output: "rest", nodes: [rest] };
const GROUNDER = {
  format: "myco.animgraph-source@1",
  output: "g",
  nodes: [rest, { id: "g", family: "rig", kind: "grounder", inputs: ["rest"], params: { pelvis: "bone1", legs: ["bone6", "bone7", "bone8", "bone9", "bone10", "bone11"], footHalfLife: 0, pelvisHalfLife: 0 } }],
};
const WARP = {
  format: "myco.animgraph-source@1",
  output: "w",
  nodes: [
    { id: "walk", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/graph_walk.anim" } },
    { id: "w", family: "rig", kind: "motionWarp", inputs: ["walk"], params: { window: "times", startTime: 0.1, endTime: 0.6 } },
  ],
};

let engine: Engine;
let world: World;
const made: GameObject[] = [];

const steps = (n: number) => {
  for (let i = 0; i < n; i++) engine.step(dt);
};

function character(name: string, graph: string, o: { skeleton?: string; position?: [number, number, number]; rotation?: Quaternion; animator?: Record<string, unknown> } = {}): { node: GameObject; anim: Animator } {
  const node = GameObject.create(name);
  made.push(node);
  if (o.position) node.transform!.position = o.position;
  if (o.rotation) node.transform!.rotation = o.rotation;
  node.addComponent(Skeleton, { skeleton: o.skeleton ?? "anim/rig.skel" });
  const anim = node.addComponent(Animator, { graph, ...o.animator });
  return { node, anim };
}

function target(name: string, at: [number, number, number]): GameObject {
  const node = GameObject.create(name);
  made.push(node);
  node.transform!.position = at;
  return node;
}

async function ready(...nodes: GameObject[]): Promise<void> {
  await vi.waitFor(() => {
    engine.step(0);
    for (const n of nodes) expect(skinningMatrices(world, n)).not.toBeNull();
  });
}

const pose = (node: GameObject): Float32Array => skinningMatrices(world, node)!.slice();
/** Bone `b`'s model-space position (identity inverse binds). */
const at = (m: Float32Array, b: number): Vector3 => new Vector3(m[b * 12 + 3]!, m[b * 12 + 7]!, m[b * 12 + 11]!);
/** A model-space point of `node` (no scale) in world space. */
const toWorld = (node: GameObject, p: Vector3): Vector3 => Vector3.add(node.transform!.worldPosition, Quaternion.rotate(node.transform!.worldRotation, p));
const diff = (a: Float32Array, b: Float32Array) => a.reduce((w, x, i) => Math.max(w, Math.abs(x - b[i]!)), 0);

function destroyAll(): void {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "anim/rig.skel": fixtureUrl("rig.skel").href,
      "anim/small.skel": fixtureUrl("small.skel").href,
      "anim/graph_walk.anim": fixtureUrl("graph_walk.anim").href,
      "ik.animgraph.json": IK,
      "ikHalf.animgraph.json": IK_HALF,
      "ikLod.animgraph.json": IK_LOD,
      "rest.animgraph.json": REST,
      "grounder.animgraph.json": GROUNDER,
      "warp.animgraph.json": WARP,
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

describe("Animator.ik", () => {
  it("a target node moves the foot onto it, in world space, on a moved and turned character", async () => {
    const turn = Quaternion.rotateY(Math.PI / 2);
    const { node, anim } = character("Hero", "ik.animgraph.json", { position: [1, 0, 2], rotation: turn });
    // The foot's rest position is (0.1, 0.1, 0) in model space; aim it forward and up, within reach of the hip.
    const goal = target("Goal", toWorld(node, new Vector3(0.1, 0.4, 0.15)).toArray());
    anim.ik("LeftFoot").target(goal, { weight: 1 });
    await ready(node);
    steps(2);
    expect(Vector3.distance(toWorld(node, at(pose(node), LEFT_FOOT)), goal.transform!.worldPosition)).toBeLessThan(SOLVED);
    // The node is followed every frame.
    goal.transform!.position = toWorld(node, new Vector3(0.15, 0.3, 0.1));
    steps(1);
    expect(Vector3.distance(toWorld(node, at(pose(node), LEFT_FOOT)), goal.transform!.worldPosition)).toBeLessThan(SOLVED);
    destroyAll();
  });

  it("weight 0 leaves the pose alone; the node weight scales it; a position target works too", async () => {
    const plain = character("Plain", "rest.animgraph.json");
    const zero = character("Zero", "ik.animgraph.json");
    const half = character("Half", "ikHalf.animgraph.json");
    const full = character("Full", "ik.animgraph.json");
    const want = new Vector3(0.1, 0.4, 0.15);
    zero.anim.ik("LeftFoot").target(want, { weight: 0 });
    half.anim.ik("LeftFoot").target(want);
    full.anim.ik("LeftFoot").target(want);
    await ready(plain.node, zero.node, half.node, full.node);
    steps(2);
    expect(diff(pose(zero.node), pose(plain.node))).toBeLessThan(SAME);
    expect(Vector3.distance(at(pose(full.node), LEFT_FOOT), want)).toBeLessThan(SOLVED);
    const halfway = Vector3.distance(at(pose(half.node), LEFT_FOOT), want);
    expect(halfway).toBeGreaterThan(0.01);
    expect(halfway).toBeLessThan(Vector3.distance(at(pose(plain.node), LEFT_FOOT), want));
    destroyAll();
  });

  it("follows the Animator's ikTargets binding; a code target overrides it and target(null) gives it back", async () => {
    const bound = target("Bound", [0.1, 0.4, 0.15]);
    const other = new Vector3(0.15, 0.3, 0.1);
    const { node, anim } = character("Bound", "ik.animgraph.json", { animator: { ikTargets: ["LeftFoot"], ikTargetNodes: [bound] } });
    await ready(node);
    steps(2);
    expect(Vector3.distance(at(pose(node), LEFT_FOOT), bound.transform!.worldPosition)).toBeLessThan(SOLVED);
    anim.ik("LeftFoot").target(other);
    steps(1);
    expect(Vector3.distance(at(pose(node), LEFT_FOOT), other)).toBeLessThan(SOLVED);
    anim.ik("LeftFoot").target(null);
    steps(1);
    expect(Vector3.distance(at(pose(node), LEFT_FOOT), bound.transform!.worldPosition)).toBeLessThan(SOLVED);
    destroyAll();
  });

  it("warns once for a goal the graph doesn't have", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { node, anim } = character("Unknown", "ik.animgraph.json");
      anim.ik("RightHand").target(new Vector3(0, 1, 0));
      await ready(node);
      steps(3);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('IK target "RightHand"'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    destroyAll();
  });
});

describe("rig LOD", () => {
  it("switches a node with lodSkip off past rigCullDistance from the main camera, and on again nearby", async () => {
    const cam = GameObject.create("Camera");
    made.push(cam);
    cam.addComponent(Camera);
    cam.transform!.position = [0, 1, -50];
    const plain = character("Plain", "rest.animgraph.json");
    const { node, anim } = character("Far", "ikLod.animgraph.json", { animator: { rigCullDistance: 10 } });
    const want = new Vector3(0.1, 0.4, 0.15);
    anim.ik("LeftFoot").target(want);
    await ready(node, plain.node);
    steps(2);
    expect(diff(pose(node), pose(plain.node))).toBeLessThan(SAME);
    cam.transform!.position = [0, 1, -5];
    steps(2);
    expect(Vector3.distance(at(pose(node), LEFT_FOOT), want)).toBeLessThan(SOLVED);
    // rigCullDistance 0: never switched off.
    anim.rigCullDistance = 0;
    cam.transform!.position = [0, 1, -500];
    steps(2);
    expect(Vector3.distance(at(pose(node), LEFT_FOOT), want)).toBeLessThan(SOLVED);
    destroyAll();
  });
});

describe("Animator.warp", () => {
  it("lands the root on the target at the window's end; a null target plays the clip's own motion", async () => {
    const goal = new Vector3(0.5, 0, 2);
    const warped = character("Warped", "warp.animgraph.json", { skeleton: "anim/small.skel", animator: { rootMotion: "transform" } });
    const plain = character("Plain", "warp.animgraph.json", { skeleton: "anim/small.skel", animator: { rootMotion: "transform" } });
    warped.anim.warp("w", { position: goal, rotation: Quaternion.identity });
    plain.anim.warp("w", { position: goal });
    plain.anim.warp("w", null);
    await ready(warped.node, plain.node);
    steps(18); // 0.6 s: the window's end
    // One step of root motion is 1.4 / 30 ≈ 4.7 cm; the end is met within a step's rounding.
    expect(Vector3.distance(warped.node.transform!.worldPosition, goal)).toBeLessThan(0.05);
    // Unwarped, the walk covers 0.6 × 1.4 = 0.84 m along +Z.
    expect(Vector3.distance(plain.node.transform!.worldPosition, new Vector3(0, 0, 0.84))).toBeLessThan(0.05);
    destroyAll();
  });

  it("warns once for a window the graph doesn't have", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { node, anim } = character("NoWindow", "warp.animgraph.json", { skeleton: "anim/small.skel" });
      anim.warp("Vault", { position: new Vector3(1, 0, 1) });
      await ready(node);
      steps(2);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('motion-warp window "Vault"'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    destroyAll();
  });
});

describe("the grounder", () => {
  it("places the feet on a sloped collider once the rays have made the round trip (physics on)", async () => {
    // A slope rising toward +X through the origin: the left foot (x = 0.1) stands higher than the right (x = -0.1).
    const ground = GameObject.create("Ground");
    made.push(ground);
    ground.transform!.position = [0, -0.1, 0];
    ground.transform!.rotation = Quaternion.rotateZ((20 * Math.PI) / 180);
    ground.addComponent(BoxCollider, { size: new Vector3(4, 0.2, 4) });
    const { node } = character("Grounded", "grounder.animgraph.json");
    const plain = character("Plain", "rest.animgraph.json");
    await ready(node, plain.node);
    await vi.waitFor(() => {
      steps(1);
      const m = pose(node);
      expect(at(m, LEFT_FOOT).y - at(m, RIGHT_FOOT).y).toBeGreaterThan(0.03);
    });
    const m = pose(node), p = pose(plain.node);
    // The feet follow the slope: the left one up, the right one down (or held), never both at their animated height.
    expect(at(m, LEFT_FOOT).y).toBeGreaterThan(at(p, LEFT_FOOT).y + 0.01);
    expect(at(m, RIGHT_FOOT).y).toBeLessThanOrEqual(at(p, RIGHT_FOOT).y + SAME);
    destroyAll();
  });
});

describe("without the physics plugin", () => {
  it("the grounder's rays miss: the feet keep their animated height", async () => {
    engine.dispose();
    applyTestPlugins(["myco.physics"]);
    try {
      engine = await Engine.create({ headless: true });
      world = engine.world;
      const { node } = character("Grounded", "grounder.animgraph.json");
      const plain = character("Plain", "rest.animgraph.json");
      await ready(node, plain.node);
      steps(5);
      expect(diff(pose(node), pose(plain.node))).toBeLessThan(SAME);
      destroyAll();
    } finally {
      applyTestPlugins();
    }
  });
});
