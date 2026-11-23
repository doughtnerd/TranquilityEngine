// ADR 0372 (T32): the Animator graph API in a headless Engine, through the public API (`myco`), the render-sync contract
// (`skeletonInstances.ts`) and the buffers. Graph assets are `*.animgraph.json` sources compiled at run time by T30's
// compiler; clips are the T31 graph fixtures (`../wasm/fixtures/graph_*.anim`, 12 bones on `small.skel`), served
// through `Assets` from `file:` and `data:` URLs. Time comes from `engine.step(dt)` only; steps of 0 let loads finish
// without time passing. Poses of two instances fed the same inputs in one core are compared at 1e-6 (the core is
// deterministic: the same instructions on the same inputs give the same bits; the margin only covers reading back).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, AnimatorStateChanges, Assets, BoneAttachment, Engine, GameBehavior, GameObject, Quaternion, Skeleton, Vector3, animatorParams, type AnimatorStateChange } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { ByteWriter, encodeStringTable, writeContainer } from "../../../../engine/animation/binaryWriter";
import { invert34, multiply34, toMat4 } from "../affine";
import { readSkeletonInfo } from "../assetInfo";
import { instanceForSkeleton, skinningMatrices } from "../skeletonInstances";
import { Mat4 } from "../../../../engine/core/math";
import type { AnimationPlayResult } from "../types";

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const skel = readSkeletonInfo(new Uint8Array(readFileSync(fixtureUrl("small.skel"))))!;
const dt = 1 / 30;
/** Same core, same inputs: identical computations (see the header). */
const SAME = 1e-6;

const json = (v: unknown) => `data:application/json,${encodeURIComponent(JSON.stringify(v))}`;
const clip = (id: string, path: string, extra: Record<string, unknown> = {}) => ({ id, family: "sources", kind: "clipPlayer", params: { clip: `asset:${path}`, ...extra } });
const single = (path: string) => ({ format: "myco.animgraph-source@1", output: "c", nodes: [clip("c", path)] });

/** The main graph: a machine (Idle, Locomotion over a 2D blend space, Jump, Crouch, Vault, Dead), a slot, a linked-graph layer. */
const HERO = {
  format: "myco.animgraph-source@1",
  output: "out",
  parameters: [
    { name: "x", type: "float" },
    { name: "y", type: "float" },
    { name: "moving", type: "bool" },
    { name: "grounded", type: "bool", default: true },
    { name: "canVault", type: "bool", computed: true },
    { name: "aim", type: "vec3" },
  ],
  nodes: [
    clip("idle", "idle"),
    clip("walk", "walk"),
    clip("run", "run"),
    clip("idleSample", "idle"),
    clip("jump", "run", { loop: "once" }),
    clip("vault", "run", { loop: "once" }),
    { id: "move", family: "sources", kind: "blendSpace2D", inputs: ["idleSample", "walk", "run"], params: { x: "x", y: "y", coords: [0, 0, 0, 1, 1, 1] } },
    {
      id: "machine",
      family: "logic",
      kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          {
            name: "Idle",
            root: "idle",
            transitions: [
              { to: "Locomotion", if: { param: "moving", op: "==", value: true }, how: "crossfade", duration: 0.2 },
              { to: "Crouch", if: { request: "Crouch" }, duration: 0.1 },
              { to: "Vault", if: { param: "canVault", op: "==", value: true }, how: "cut" },
            ],
          },
          { name: "Locomotion", root: "move", transitions: [{ to: "Idle", if: { param: "moving", op: "==", value: false }, duration: 0.1 }] },
          { name: "Jump", root: "jump", transitions: [{ to: "Idle", when: "exit", duration: 0.1 }] },
          { name: "Crouch", root: "idle", transitions: [{ to: "Idle", if: { request: "Stand" }, duration: 0.1 }] },
          { name: "Vault", root: "vault", transitions: [{ to: "Idle", when: "exit", duration: 0.1 }] },
          { name: "Dead", root: "idle" },
        ],
        anyState: [{ to: "Jump", if: { all: [{ request: "Jump" }, { param: "grounded", op: "==", value: true }] }, how: "cut" }],
      },
    },
    { id: "upper", family: "slots", kind: "slot", inputs: ["machine"], params: { mask: "asset:upper" }, slot: { name: "UpperBody" } },
    { id: "weapon", family: "slots", kind: "linked", linked: { name: "Weapon", graph: "asset:graphs/sword.animgraph.json" } },
    { id: "out", family: "mixing", kind: "inertialize", inputs: ["upper"] },
  ],
  layers: [{ name: "Arms", root: "weapon", mask: "asset:upper", weight: 1 }],
};

/** A 2D blend space alone at the output. */
const BLEND = {
  format: "myco.animgraph-source@1",
  output: "move",
  parameters: [
    { name: "x", type: "float" },
    { name: "y", type: "float" },
  ],
  nodes: [clip("idleSample", "idle"), clip("walk", "walk"), clip("run", "run"), { id: "move", family: "sources", kind: "blendSpace2D", inputs: ["idleSample", "walk", "run"], params: { x: "x", y: "y", coords: [0, 0, 0, 1, 1, 1] } }],
};

/** The upper body: bone3 and its descendants (3, 4, 7, 8, 9, 10, 11). */
const UPPER = { format: "myco.mask@1", entries: [{ bone: "bone3" }] };
const MASKED = [3, 4, 7, 8, 9, 10, 11];
const UNMASKED = [0, 1, 2, 5, 6];

/** A one-second clip with no bones and cues A (0), B (0.4), C (0.7): sections A [0, 0.4), B [0.4, 0.7), C [0.7, 1). */
function cuedClip(): Uint8Array {
  const NONE = 0xffffffff;
  const info = new ByteWriter().f32(1).f32(30).u32(31).u32(1).u32(NONE).u32(0).u32(NONE).u32(0).finish();
  const track = new ByteWriter().u8(14).u8(0).u8(0).u8(0).u32(NONE).u32(NONE).u32(NONE).u32(NONE).u32(NONE).u32(0).u32(3).finish();
  const keys = new ByteWriter();
  [0, 0.4, 0.7].forEach((t, i) => keys.f32(t).f32(t).u32s([3, i, 0, 0, 0]).u32(0));
  return writeContainer("MYCOANIM", 1, 0, [
    { kind: 1, count: 3, data: encodeStringTable(["A", "B", "C"]) },
    { kind: 2, count: 1, data: info },
    { kind: 3, count: 1, data: track },
    { kind: 4, count: 3, data: keys.finish() },
  ]);
}

const SKEL = "anim/small.skel";
const SHOT = "anim/shot.anim";
const CUED = "anim/cued.anim";

let engine: Engine;
let world: World;
const made: GameObject[] = [];

const steps = (n: number, d = dt) => {
  for (let i = 0; i < n; i++) engine.step(d);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

interface HeroOptions {
  graph?: string;
  skeleton?: boolean;
  parameters?: Record<string, number | boolean | number[]>;
  linkedGraphNodes?: string[];
  linkedGraphs?: string[];
  defaultClip?: string;
}

function makeHero(name: string, o: HeroOptions = {}): { node: GameObject; anim: Animator } {
  const node = GameObject.create(name);
  made.push(node);
  if (o.skeleton !== false) node.addComponent(Skeleton, { skeleton: SKEL });
  const anim = node.addComponent(Animator, {
    graph: o.graph ?? "",
    parameters: o.parameters ?? {},
    linkedGraphNodes: o.linkedGraphNodes ?? [],
    linkedGraphs: o.linkedGraphs ?? [],
    defaultClip: o.defaultClip ?? "",
  });
  return { node, anim };
}

/** Steps with dt 0 until every node's skeleton has an evaluated pose (graphs loaded, instances made): no time passes. */
async function ready(...nodes: GameObject[]): Promise<void> {
  await vi.waitFor(() => {
    engine.step(0);
    for (const n of nodes) expect(skinningMatrices(world, n)).not.toBeNull();
  });
}

const pose = (node: GameObject): Float32Array => skinningMatrices(world, node)!.slice();
/** The largest difference between two poses over `bones` (all by default). */
function diff(a: Float32Array, b: Float32Array, bones?: readonly number[]): number {
  let w = 0;
  for (const bone of bones ?? Array.from({ length: skel.bones }, (_, i) => i)) for (let k = 0; k < 12; k++) w = Math.max(w, Math.abs(a[bone * 12 + k]! - b[bone * 12 + k]!));
  return w;
}

/** Bone `b`'s model-space 3×4 from skinning matrices (model = skinning × bind). */
function model(m: Float32Array, b: number): Float64Array {
  const out = new Float64Array(12);
  multiply34(out, 0, m, b * 12, skel.bind, b * 12);
  return out;
}
/** Bone `b`'s local rotation from skinning matrices. */
function localRotation(m: Float32Array, b: number): Quaternion {
  const p = skel.parents[b]!;
  const local = new Float64Array(12);
  const inv = new Float64Array(12);
  invert34(inv, 0, model(m, p), 0);
  multiply34(local, 0, inv, 0, model(m, b), 0);
  const m4 = new Float64Array(16);
  toMat4(m4, 0, local, 0);
  const pos = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1];
  Mat4.decompose(m4, 0, pos, 0, q, 0, s, 0);
  return new Quaternion(q[0]!, q[1]!, q[2]!, q[3]!);
}
const angle = (a: Quaternion, b: Quaternion) => 1 - Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);

/** Collects AnimatorStateChanges records every frame (read in lateUpdate, after animation.Apply pushed them). */
const changes: AnimatorStateChange[] = [];

function destroyAll(): void {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
  changes.length = 0;
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      [SKEL]: fixtureUrl("small.skel").href,
      idle: fixtureUrl("graph_idle.anim").href,
      walk: fixtureUrl("graph_walk.anim").href,
      run: fixtureUrl("graph_run.anim").href,
      [SHOT]: fixtureUrl("graph_shot.anim").href,
      [CUED]: `data:application/octet-stream;base64,${Buffer.from(cuedClip()).toString("base64")}`,
      // JSON files load as their contents; a reference without a JSON ending is fetched from its URL.
      upper: json(UPPER),
      "masks/upper.mask.json": UPPER,
      "hero.animgraph.json": HERO,
      "blend.animgraph.json": BLEND,
      "run.animgraph.json": single("run"),
      "idle.animgraph.json": single("idle"),
      "graphs/sword.animgraph.json": single("walk"),
      "graphs/axe.animgraph.json": single("run"),
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
  const watcher = GameObject.create("Watcher");
  watcher.addBehavior(
    class extends GameBehavior {
      lateUpdate(): void {
        changes.push(...AnimatorStateChanges.read());
      }
    },
  );
});

afterAll(() => engine?.dispose());

describe("graph instances and parameters", () => {
  it("parameters drive a blend space: Animator.parameters, set() before the graph loads and animatorParams bulk writes", async () => {
    const byField = makeHero("ByField", { graph: "blend.animgraph.json", parameters: { x: 1, y: 1 } });
    const bySet = makeHero("BySet", { graph: "blend.animgraph.json" });
    bySet.anim.set("x", 1); // queued by name until the graph has loaded
    bySet.anim.set("y", 1);
    const bulk = makeHero("Bulk", { graph: "blend.animgraph.json" });
    const rest = makeHero("Rest", { graph: "blend.animgraph.json" });
    const run = makeHero("Run", { graph: "run.animgraph.json" });
    const idle = makeHero("Idle", { graph: "idle.animgraph.json" });
    await ready(byField.node, bySet.node, bulk.node, rest.node, run.node, idle.node);
    // Bulk writes by index once the graph is known (indexOf is -1 before).
    const params = animatorParams(bulk.node)!;
    const ix = params.indexOf("x"), iy = params.indexOf("y");
    expect([ix, iy]).toEqual([0, 1]);
    expect(params.indexOf("nope")).toBe(-1);
    params.set(ix, 1);
    params.set(iy, 1);
    expect(animatorParams(GameObject.create("Nobody"))).toBeNull();
    steps(10);
    // (1, 1) is the run sample alone; (0, 0) the idle sample alone.
    for (const h of [byField, bySet, bulk]) expect(diff(pose(h.node), pose(run.node)), h.node.name).toBeLessThan(SAME);
    expect(diff(pose(rest.node), pose(idle.node))).toBeLessThan(SAME);
    expect(diff(pose(run.node), pose(idle.node))).toBeGreaterThan(1e-3);
    destroyAll();
  });

  it("refuses unknown names and kind mismatches with one warning each", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { node, anim } = makeHero("Typed", { graph: "hero.animgraph.json" });
      await ready(node);
      anim.set("nope", 1);
      anim.set("nope", 2);
      anim.set("moving", 1); // a bool
      anim.set("moving", 2);
      anim.set("aim", new Vector3(1, 2, 3)); // fits
      anim.set("x", true); // a float
      engine.step(0);
      const texts = warn.mock.calls.map(([m]) => String(m));
      expect(texts.filter((t) => t.includes('"nope"'))).toHaveLength(1);
      expect(texts.filter((t) => t.includes('"moving"'))).toHaveLength(1);
      expect(texts.filter((t) => t.includes('"x"'))).toHaveLength(1);
      expect(texts.filter((t) => t.includes('"aim"'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
      destroyAll();
    }
  });

  it("runs a graph's logic on an Animator without a Skeleton (zero bones)", async () => {
    const { anim } = makeHero("Ghost", { graph: "hero.animgraph.json", skeleton: false });
    await vi.waitFor(() => {
      engine.step(0);
      expect(anim.state().name).toBe("Idle");
    });
    anim.jump("Crouch");
    steps(1);
    expect(anim.state().name).toBe("Crouch");
    destroyAll();
  });
});

/** A hero on the main graph, in Idle. */
async function heroInIdle(name = "Hero", o: HeroOptions = {}): Promise<{ node: GameObject; anim: Animator }> {
  const h = makeHero(name, { graph: "hero.animgraph.json", ...o });
  await ready(h.node);
  await vi.waitFor(() => {
    engine.step(0);
    expect(h.anim.state().name).toBe("Idle");
  });
  return h;
}

const entered = (anim: Animator) => changes.filter((c) => c.animator === anim).map((c) => c.to);

describe("the state machine from code", () => {
  it("fills AnimatorStateChanges with the layer, from and to", async () => {
    const { anim } = await heroInIdle();
    expect(changes.filter((c) => c.animator === anim)).toEqual([{ animator: anim, layer: "Base", from: null, to: "Idle" }]);
    anim.set("moving", true);
    steps(2);
    expect(changes.filter((c) => c.animator === anim).at(-1)).toEqual({ animator: anim, layer: "Base", from: "Idle", to: "Locomotion" });
    destroyAll();
  });

  it("reports state(): the state left, its weight and the target during a transition, then the new state", async () => {
    const { anim } = await heroInIdle();
    steps(3);
    expect(anim.state()).toMatchObject({ name: "Idle", weight: 1, transitioningTo: null });
    expect(anim.state("Base").time).toBeCloseTo(3 * dt, 4);
    anim.set("moving", true);
    steps(3); // the crossfade (0.2 s) started on the first of these frames
    const s = anim.state();
    expect(s.name).toBe("Idle");
    expect(s.transitioningTo).toBe("Locomotion");
    expect(s.weight).toBeGreaterThan(0);
    expect(s.weight).toBeLessThan(1);
    expect(s.time).toBeGreaterThan(3 * dt);
    steps(10);
    const after = anim.state(0);
    expect(after).toMatchObject({ name: "Locomotion", weight: 1, transitioningTo: null });
    expect(after.time).toBeGreaterThan(0.2);
    expect(after.normalizedTime).toBeGreaterThan(0);
    expect(anim.state("NoSuchLayer").name).toBe("");
    destroyAll();
  });

  it("consumes a request a transition reads, and lets an unread one expire", async () => {
    const { anim } = await heroInIdle();
    anim.set("grounded", false);
    anim.request("Jump", { within: 0.1 });
    steps(5); // 0.17 s: expired unread
    anim.set("grounded", true);
    steps(5);
    expect(entered(anim)).not.toContain("Jump");
    anim.request("Jump", { within: 0.1 });
    steps(2);
    expect(anim.state().name).toBe("Jump");
    expect(entered(anim).filter((s) => s === "Jump")).toHaveLength(1);
    destroyAll();
  });

  it("travels along the shortest path, and refuses an unreachable state with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { anim } = await heroInIdle();
      anim.set("moving", true);
      steps(10);
      expect(anim.state().name).toBe("Locomotion");
      changes.length = 0;
      const crouch = anim.travel("Crouch", { layer: "Base" });
      let result: unknown = null;
      void crouch.then((r) => (result = r));
      for (let i = 0; i < 30 && !result; i++) {
        engine.step(dt);
        await tick();
      }
      expect(result).toEqual({ reason: "arrived" });
      expect(entered(anim)).toEqual(["Idle", "Crouch"]); // Locomotion → Idle → Crouch, though moving still says Locomotion
      const again = anim.travel("Crouch"); // already there
      steps(1);
      expect(await again).toEqual({ reason: "arrived" });
      const dead = anim.travel("Dead");
      steps(1);
      expect(await dead).toEqual({ reason: "unreachable" });
      expect(warn.mock.calls.filter(([m]) => String(m).includes('"Dead"'))).toHaveLength(1);
      const none = anim.travel("Nowhere");
      steps(1);
      expect(await none).toEqual({ reason: "unreachable" });
      expect(anim.state().name).toBe("Crouch");
    } finally {
      warn.mockRestore();
      destroyAll();
    }
  });

  it("jumps straight to a state with no path", async () => {
    const { anim } = await heroInIdle();
    anim.jump("Dead");
    steps(1);
    expect(anim.state()).toMatchObject({ name: "Dead", transitioningTo: null });
    expect(entered(anim).at(-1)).toBe("Dead");
    destroyAll();
  });

  it("feeds a transition from a computed parameter, logging a throwing one once", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { anim } = await heroInIdle();
      let ledge = false;
      anim.compute("canVault", () => ledge);
      steps(3);
      expect(anim.state().name).toBe("Idle");
      ledge = true;
      steps(1);
      expect(anim.state().name).toBe("Vault");
      anim.compute("canVault", () => {
        throw new Error("no ledge sensor");
      });
      steps(3);
      expect(err.mock.calls.filter(([m]) => String(m).includes('"canVault"'))).toHaveLength(1);
      anim.compute("canVault", null);
    } finally {
      err.mockRestore();
      destroyAll();
    }
  });
});

describe("slots", () => {
  async function playUntilDone(p: Promise<AnimationPlayResult>, max = 60): Promise<{ frames: number; result: AnimationPlayResult | null }> {
    let result: AnimationPlayResult | null = null;
    void p.then((r) => (result = r));
    await tick();
    let frames = 0;
    while (!result && frames < max) {
      engine.step(dt);
      frames++;
      await tick();
    }
    return { frames, result };
  }

  it("plays a section named by the clip's cues to its end: the promise resolves finished", async () => {
    const { anim } = await heroInIdle();
    const p = anim.play(CUED, { slot: "UpperBody", section: "B" }); // [0.4, 0.7): 9 frames
    expect(anim.onFinished).toBe(p);
    const { frames, result } = await playUntilDone(p);
    expect(result).toEqual({ reason: "finished" });
    expect(frames).toBeGreaterThanOrEqual(9);
    expect(frames).toBeLessThanOrEqual(11);
    destroyAll();
  });

  it("plays explicit section times, and finishes after a blend-out", async () => {
    const { anim } = await heroInIdle();
    const { frames, result } = await playUntilDone(anim.play(SHOT, { slot: "UpperBody", section: { start: 0.2, end: 0.5 }, fade: 0.1 }));
    expect(result).toEqual({ reason: "finished" });
    expect(frames).toBeGreaterThanOrEqual(8);
    expect(frames).toBeLessThanOrEqual(11);
    destroyAll();
  });

  it("refuses an unknown section or slot: the play resolves stopped with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { anim } = await heroInIdle();
      const a = anim.play(CUED, { slot: "UpperBody", section: "Z" });
      const b = anim.play(SHOT, { slot: "Legs" });
      await tick();
      steps(1);
      expect(await a).toEqual({ reason: "stopped" });
      expect(await b).toEqual({ reason: "stopped" });
      expect(warn.mock.calls.some(([m]) => String(m).includes('"Z"'))).toBe(true);
      expect(warn.mock.calls.some(([m]) => String(m).includes('"Legs"'))).toBe(true);
    } finally {
      warn.mockRestore();
      destroyAll();
    }
  });

  it("interrupts a play with the next one in its slot, and stops a slot", async () => {
    const { anim } = await heroInIdle();
    const first = anim.play(SHOT, { slot: "UpperBody" });
    await tick();
    steps(2);
    const second = anim.play(SHOT, { slot: "UpperBody", fade: 0.1 });
    await tick();
    steps(1);
    expect(await first).toEqual({ reason: "interrupted" });
    anim.stop({ slot: "UpperBody", fade: 0.1 });
    steps(1);
    expect(await second).toEqual({ reason: "stopped" });
    const third = anim.play(SHOT, { slot: "UpperBody" });
    await tick();
    steps(1);
    anim.stop(); // every slot
    steps(1);
    expect(await third).toEqual({ reason: "stopped" });
    destroyAll();
  });

  it("ends slot plays stopped when the Animator is destroyed", async () => {
    const { node, anim } = await heroInIdle();
    const p = anim.play(SHOT, { slot: "UpperBody", loop: true });
    await tick();
    steps(2);
    GameObject.destroy(node);
    engine.step(0);
    expect(await p).toEqual({ reason: "stopped" });
    destroyAll();
  });
});

describe("linked graphs and layer weights", () => {
  it("swaps a linked graph (linkedGraphs and link()), puts the default back with null, and weighs the layer", async () => {
    const sword = makeHero("Sword", { graph: "hero.animgraph.json" });
    const axeField = makeHero("AxeField", { graph: "hero.animgraph.json", linkedGraphNodes: ["Weapon"], linkedGraphs: ["graphs/axe.animgraph.json"] });
    const axeCall = makeHero("AxeCall", { graph: "hero.animgraph.json" });
    axeCall.anim.link("Weapon", "graphs/axe.animgraph.json");
    await ready(sword.node, axeField.node, axeCall.node);
    await vi.waitFor(async () => {
      engine.step(0);
      await tick();
      expect(diff(pose(axeField.node), pose(sword.node), MASKED)).toBeGreaterThan(0);
      expect(diff(pose(axeCall.node), pose(sword.node), MASKED)).toBeGreaterThan(0);
    });
    steps(6);
    // The Arms layer (masked to the upper body) runs the linked graph: the axe's run there, the base elsewhere.
    expect(diff(pose(axeField.node), pose(axeCall.node))).toBeLessThan(SAME);
    expect(diff(pose(axeField.node), pose(sword.node), UNMASKED)).toBeLessThan(SAME);
    expect(diff(pose(axeField.node), pose(sword.node), MASKED)).toBeGreaterThan(1e-3);
    // Layer weight 0: the base shows everywhere.
    for (const h of [sword, axeField]) h.anim.layerWeight("Arms", 0);
    steps(1);
    expect(diff(pose(axeField.node), pose(sword.node))).toBeLessThan(SAME);
    for (const h of [sword, axeField]) h.anim.layerWeight(1, 1); // layer 1 is "Arms" (0 is the base)
    // null puts the default (sword) back: the axe hero's arms differ from what they were.
    axeCall.anim.link("Weapon", null);
    steps(3);
    expect(diff(pose(axeCall.node), pose(axeField.node), MASKED)).toBeGreaterThan(1e-3);
    destroyAll();
  });
});

describe("bone overrides", () => {
  it("override a bone for one frame: skinning matrices and BoneAttachments see it, descendants follow", async () => {
    const twin = makeHero("Twin", { defaultClip: "idle" });
    const hero = makeHero("Posed", { defaultClip: "idle" });
    const prop = GameObject.create("Prop", { parent: hero.node });
    prop.addComponent(BoneAttachment, { bone: "bone4" });
    await vi.waitFor(() => {
      engine.step(0);
      expect(instanceForSkeleton(world, twin.node)).not.toBe(0);
      expect(instanceForSkeleton(world, hero.node)).not.toBe(0);
      expect(hero.anim.state().name).not.toBe("");
      expect(twin.anim.state().name).not.toBe("");
    });
    const q = Quaternion.rotateZ(0.7);
    let on = true;
    hero.node.addBehavior(
      class extends GameBehavior {
        lateUpdate(): void {
          if (on) hero.anim.bone("bone3").localRotation = q;
        }
      },
    );
    steps(5);
    const posed = pose(hero.node), plain = pose(twin.node);
    expect(angle(localRotation(posed, 3), q)).toBeLessThan(1e-6);
    expect(angle(localRotation(plain, 3), q)).toBeGreaterThan(1e-4);
    // Bones outside the overridden branch keep the evaluated pose; descendants keep their local transforms.
    expect(diff(posed, plain, [0, 1, 2, 5, 6])).toBeLessThan(SAME);
    expect(angle(localRotation(posed, 4), localRotation(plain, 4))).toBeLessThan(1e-6);
    expect(diff(posed, plain, [4])).toBeGreaterThan(1e-4);
    // The reads give the override (until the next frame's Apply drops it).
    expect(angle(hero.anim.bone("bone3").localRotation, q)).toBeLessThan(1e-6);
    // The attachment follows the overridden bone4 (the hero's node sits at the origin).
    const m4 = model(posed, 4);
    expect(Vector3.distance(prop.transform!.worldPosition, new Vector3(m4[3]!, m4[7]!, m4[11]!))).toBeLessThan(1e-5);
    // No write, no override: the next frame shows the evaluated pose again.
    on = false;
    steps(1);
    expect(diff(pose(hero.node), pose(twin.node))).toBeLessThan(SAME);
    destroyAll();
  });

  it("warns once for a bone the skeleton doesn't have", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { node, anim } = makeHero("NoBone", { defaultClip: "idle" });
      await vi.waitFor(() => {
        engine.step(0);
        expect(instanceForSkeleton(world, node)).not.toBe(0);
      });
      const b = anim.bone("Tail");
      b.localPosition = new Vector3(1, 0, 0);
      expect(b.localPosition.length).toBe(0);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('"Tail"'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      destroyAll();
    }
  });
});

describe("crossfade with a mask (implicit graph)", () => {
  it("leaves the bones the mask leaves out on the base layer", async () => {
    const masked = makeHero("Masked");
    const base = makeHero("Base");
    const full = makeHero("Full");
    await vi.waitFor(() => {
      engine.step(0);
      for (const h of [masked, base, full]) expect(instanceForSkeleton(world, h.node)).not.toBe(0);
    });
    for (const h of [masked, base, full]) h.anim.play("idle");
    await vi.waitFor(() => {
      engine.step(0);
      for (const h of [masked, base, full]) expect(h.anim.state().name).toBe("idle");
    });
    steps(3);
    masked.anim.crossfade("run", 0.1, { layer: 1, mask: "masks/upper.mask.json" });
    full.anim.crossfade("run", 0.1, { layer: 1 });
    await vi.waitFor(async () => {
      engine.step(0);
      await tick();
      expect(masked.anim.state(1).name).toBe("run");
      expect(full.anim.state(1).name).toBe("run");
    });
    steps(6);
    const m = pose(masked.node), b = pose(base.node), f = pose(full.node);
    expect(diff(m, b, UNMASKED)).toBeLessThan(SAME);
    expect(diff(m, b, MASKED)).toBeGreaterThan(1e-3);
    expect(diff(f, b, UNMASKED)).toBeGreaterThan(1e-3); // without a mask the run reaches every bone
    destroyAll();
  });
});
