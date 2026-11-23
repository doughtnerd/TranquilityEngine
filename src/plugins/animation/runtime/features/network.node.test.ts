// ADR 0370 "Networking", 0372 "Replication" (T33): Animators over 0033's netcode, in a headless Engine with a client
// World ("P1") and a server World linked by the loopback transport on a fake clock that advances with `engine.step`, so
// everything is deterministic. Through the public API (`myco`), the render-sync contract (`skeletonInstances.ts`) and
// the netcode's own interfaces (`predictedTick`, the editor's `predictionStats`).
//
// Tolerances: a client pose is compared with the server's pose at the client's interpolation tick (whole ticks here:
// the fake clock steps one tick per frame) at 1e-5: both Worlds evaluate in the same core, on the same inputs from the
// same times, so they compute the same bits (the margin only covers reading back). Positions of predicted characters
// are compared at 2 mm: replication quantises positions to 1 mm, and a corrected prediction restarts from the quantised
// server state (ADR 0033 §6).
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Animator,
  AnimatorStateChanges,
  Assets,
  Engine,
  GameBehavior,
  GameObject,
  Quaternion,
  Replicated,
  Skeleton,
  Transform,
  Vector3,
  defineInput,
  defineSystem,
  i32,
  predictedTick,
  type AnimatorStateChange,
  type BootstrapConfig,
} from "../../../../myco";
import { World } from "../../../../engine/core/World";
import { netSession } from "../../../../engine/net/session";
import { predictionStats } from "../../../../engine/net/prediction";
import { readClipInfo, readSkeletonInfo } from "../assetInfo";
import { skinningMatrices } from "../skeletonInstances";
import type { AnimationPlayResult } from "../types";

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const skel = readSkeletonInfo(new Uint8Array(readFileSync(fixtureUrl("small.skel"))))!;
const walkInfo = readClipInfo(new Uint8Array(readFileSync(fixtureUrl("walk.anim"))))!;

/** Same core, same inputs (see the header). */
const SAME = 1e-5;
/** Positions of predicted characters (see the header). */
const NEAR = 2e-3;

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

function step(engine: Engine, frames = 1, after?: () => void): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    engine.step(DT);
    after?.();
  }
}
const pause = () => new Promise((r) => setTimeout(r, 0));

const json = (v: unknown) => `data:application/json,${encodeURIComponent(JSON.stringify(v))}`;
const clip = (id: string, path: string, extra: Record<string, unknown> = {}) => ({ id, family: "sources", kind: "clipPlayer", params: { clip: `asset:${path}`, ...extra } });
const held = (path: string, at: number) => ({ format: "myco.animgraph-source@1", output: "c", nodes: [clip("c", path, { speed: 0, start: at })] });

/** A machine (Idle, Locomotion over a 2D blend space, Crouch) under an upper-body slot, with a linked-graph layer. */
const HERO = {
  format: "myco.animgraph-source@1",
  output: "upper",
  parameters: [
    { name: "x", type: "float", replicate: true },
    { name: "y", type: "float", replicate: true },
    { name: "moving", type: "bool", replicate: true },
    { name: "local", type: "float" },
  ],
  nodes: [
    clip("idle", "idle"),
    clip("walk", "walk"),
    clip("run", "run"),
    clip("idleSample", "idle"),
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
            ],
          },
          { name: "Locomotion", root: "move", transitions: [{ to: "Idle", if: { param: "moving", op: "==", value: false }, duration: 0.1 }] },
          { name: "Crouch", root: "idle", transitions: [{ to: "Idle", if: { request: "Stand" }, duration: 0.1 }] },
        ],
      },
    },
    { id: "upper", family: "slots", kind: "slot", inputs: ["machine"], params: { mask: "asset:upper" }, slot: { name: "UpperBody" } },
  ],
};

/** A linked-graph node alone at the output (weapon sets): its graph restarts when linked. */
const ARMS = {
  format: "myco.animgraph-source@1",
  output: "weapon",
  nodes: [{ id: "weapon", family: "slots", kind: "linked", linked: { name: "Weapon", graph: "asset:graphs/sword.animgraph.json" } }],
};

/** An idle pose under a full-body slot: the predicted character's graph. */
const ROLLER = {
  format: "myco.animgraph-source@1",
  output: "full",
  nodes: [clip("idle", "idle"), { id: "full", family: "slots", kind: "slot", inputs: ["idle"], slot: { name: "Full" } }],
};

const SKEL = "anim/small.skel";
const SHOT = "anim/shot.anim";
const WALK = "anim/walk.anim";

beforeAll(() => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      [SKEL]: fixtureUrl("small.skel").href,
      idle: fixtureUrl("graph_idle.anim").href,
      walk: fixtureUrl("graph_walk.anim").href,
      run: fixtureUrl("graph_run.anim").href,
      [SHOT]: fixtureUrl("graph_shot.anim").href,
      [WALK]: fixtureUrl("walk.anim").href,
      upper: json({ format: "myco.mask@1", entries: [{ bone: "bone3" }] }),
      "hero.animgraph.json": HERO,
      "roller.animgraph.json": ROLLER,
      // Held poses (speed 0), so what a linked graph shows doesn't depend on when it started.
      "graphs/sword.animgraph.json": held("walk", 0.2),
      "graphs/axe.animgraph.json": held("run", 0.3),
      "prefabs/anim-hero.json": {
        format: "myco.scene@1",
        nodes: [
          {
            id: "hero",
            name: "Hero",
            components: [
              { type: "net.Replicated", data: { mode: "interpolated", replicateTransform: false } },
              { type: "engine.Transform", data: { position: [0, 0, 0] } },
              { type: "engine.Skeleton", data: { skeleton: SKEL } },
              { type: "engine.Animator", data: { graph: "hero.animgraph.json" } },
            ],
          },
          // A hit volume on the hand: the server keeps evaluating this skeleton's pose for it.
          { id: "hand", name: "Hand", parent: "hero", components: [{ type: "engine.Transform" }, { type: "engine.BoneAttachment", data: { bone: "bone4" } }] },
        ],
      },
      "arms.animgraph.json": ARMS,
      "prefabs/anim-arms.json": {
        format: "myco.scene@1",
        nodes: [
          {
            id: "arms",
            name: "Arms",
            components: [
              { type: "net.Replicated", data: { replicateTransform: false } },
              { type: "engine.Transform" },
              { type: "engine.Skeleton", data: { skeleton: SKEL } },
              { type: "engine.Animator", data: { graph: "arms.animgraph.json" } },
            ],
          },
          { id: "hand", name: "Hand", parent: "arms", components: [{ type: "engine.Transform" }, { type: "engine.BoneAttachment", data: { bone: "bone4" } }] },
        ],
      },
      "prefabs/anim-roller.json": {
        format: "myco.scene@1",
        nodes: [
          {
            id: "roller",
            name: "Roller",
            components: [
              { type: "net.Replicated", data: { mode: "predicted" } },
              { type: "engine.Transform", data: { position: [0, 0, 0] } },
              { type: "engine.CharacterController" },
              { type: "engine.Skeleton", data: { skeleton: SKEL } },
              { type: "engine.Animator", data: { graph: "roller.animgraph.json", updateMode: "fixed", rootMotion: "characterController" } },
            ],
          },
        ],
      },
    }),
  );
});

// ------------------------------------------------------------------------------------------------ predicted gameplay

/** The owner's input: 1 on the tick a roll is asked for, 2 on the tick a still one (the clip's last instant) is. */
const Roll = defineInput("test.animnet.Roll", { roll: i32 });
/** The server ticks P1 asks for a roll and a still play on (-1: none). */
let rollTick = -1;
let stillTick = -1;
/** The server knows something the client doesn't (a stun, say): it refuses rolls. */
let serverRefuses = false;

defineSystem({
  name: "test.animnet.write",
  phase: "fixedUpdate",
  worlds: ["client"],
  run(_rows, ctx) {
    const tick = ctx.time.network!.serverTick;
    Roll.write({ roll: tick === rollTick ? 1 : tick === stillTick ? 2 : 0 });
  },
});

/**
 * Predicted gameplay: a roll input plays the walk clip, a root-motion one-shot, in the full-body slot; a still one
 * plays only its last instant (no movement: it loads the clip on both ends without anything to predict).
 */
defineSystem({
  name: "test.animnet.roll",
  phase: "fixedUpdate",
  predicted: true,
  worlds: ["client", "server"],
  query: [Transform],
  run(rows, ctx) {
    for (const row of rows) {
      const anim = row.node.getBehavior(Animator);
      const roll = anim ? Roll.of(row.node)?.roll : 0;
      if (roll === 1 && !(serverRefuses && netSession(ctx.world)?.isServer)) void anim!.play(WALK, { slot: "Full" });
      else if (roll === 2) void anim!.play(WALK, { slot: "Full", section: { start: walkInfo.duration } });
    }
  },
});

/** Server positions of the roller by tick. */
const serverLog = new Map<number, { p: Vector3; yaw: number }>();
defineSystem({
  name: "test.animnet.log",
  phase: "lateUpdate",
  worlds: ["server"],
  run(_rows, ctx) {
    const tick = netSession(ctx.world)!.time.tick;
    for (const a of GameObject.findObjectsOfType(Animator)) if (a.node.name === "Roller") serverLog.set(tick, { p: a.node.transform!.worldPosition, yaw: yawOf(a.node.transform!.worldRotation) });
  },
});

const yawOf = (q: Quaternion) => 2 * Math.atan2(q.y, q.w);

// ------------------------------------------------------------------------------------------------ helpers

function bootstrap(options: Record<string, unknown>): BootstrapConfig {
  // "Solo" isn't networked: the reference for root motion the core applies itself.
  return { worlds: [{ name: "P1", tags: ["client"] }, { name: "Server", tags: ["server"] }, { name: "Solo", tags: ["default"] }], links: [{ from: "P1", to: "Server", transport: "loopback", options: { now, ...options } }] };
}

async function start(options: Record<string, unknown> = {}) {
  serverLog.clear();
  rollTick = stillTick = -1;
  serverRefuses = false;
  const engine = await Engine.create({ headless: true, bootstrap: bootstrap(options) });
  engines.push(engine);
  const server = engine._world("Server")!;
  const p1 = engine._world("P1")!;
  for (let i = 0; i < 120 && netSession(p1)!.serverPeer?.state !== "open"; i++) step(engine);
  expect(netSession(p1)!.serverPeer?.state).toBe("open");
  return { engine, server, p1, solo: engine._world("Solo")! };
}

/** Steps (letting loads finish between frames) until `ready` holds. */
async function until(engine: Engine, ready: () => boolean, what: string, frames = 600): Promise<void> {
  for (let i = 0; i < frames; i++) {
    if (ready()) return;
    step(engine);
    await pause();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The Animator on the node named `name` in `world`, or null. */
function animatorIn(world: World, name: string): Animator | null {
  return World._runIn(world, () => GameObject.findObjectsOfType(Animator).find((a) => a.node.name === name) ?? null);
}

const pose = (world: World, node: GameObject) => skinningMatrices(world, node)?.slice() ?? null;
/**
 * The bones a server computes for the heroes' hit volume (T70: a server writes matrices only for the bones BoneAttachments
 * follow and their ancestors): bone4 and its chain to the root.
 */
const SERVER_BONES: readonly number[] = (() => {
  const chain: number[] = [];
  for (let b = 4; b >= 0; b = skel.parents[b]!) chain.push(b);
  return chain;
})();
/** The largest difference between two poses over the bones the server computes. */
function diff(a: Float32Array, b: Float32Array): number {
  let w = 0;
  for (const bone of SERVER_BONES) for (let k = 0; k < 12; k++) w = Math.max(w, Math.abs(a[bone * 12 + k]! - b[bone * 12 + k]!));
  return w;
}

/** Records the server's pose per tick and the client's with its interpolation time, after each step. */
function poseLog(server: World, p1: World, serverNode: GameObject, clientNode: GameObject) {
  const byTick = new Map<number, Float32Array>();
  const client: { at: number; pose: Float32Array }[] = [];
  return {
    byTick,
    client,
    sample() {
      const s = pose(server, serverNode), c = pose(p1, clientNode);
      if (s) byTick.set(netSession(server)!.time.tick, s);
      const t = netSession(p1)!.time;
      if (c) client.push({ at: t.interpolationTick + t.interpolationFraction, pose: c });
    },
    /** The client's samples with interpolation times in [from, to] are the server's pose at that tick (see the header). */
    expectMatch(from: number, to = Number.POSITIVE_INFINITY) {
      const samples = client.filter((s) => s.at >= from && s.at <= to && byTick.has(Math.round(s.at)));
      expect(samples.length).toBeGreaterThan(10);
      for (const s of samples) expect(diff(s.pose, byTick.get(Math.round(s.at))!), `client at ${s.at.toFixed(2)}`).toBeLessThan(SAME);
    },
  };
}

// ------------------------------------------------------------------------------------------------ interpolated ghosts

describe("server to client replication (interpolated ghosts)", { timeout: 60_000 }, () => {
  it("replicates parameters, states, slot plays and links; the client re-evaluates and matches the server's pose", async () => {
    const { engine, server, p1 } = await start();
    const heroNode = World._runIn(server, () => GameObject.instantiate("prefabs/anim-hero.json"));
    let ghost: Animator | null = null;
    await until(engine, () => (ghost = animatorIn(p1, "Hero")) !== null && pose(p1, ghost.node) !== null && pose(server, heroNode) !== null, "the ghost's pose");
    const hero = heroNode.getBehavior(Animator)!;
    const g = ghost!;

    // The client follows: parameters at the interpolation tick, so its machine enters Locomotion by itself.
    const log = poseLog(server, p1, heroNode, g.node);
    const changes: AnimatorStateChange[] = [];
    World._runIn(p1, () =>
      GameObject.create("Watcher").addBehavior(
        class extends GameBehavior {
          lateUpdate(): void {
            for (const c of AnimatorStateChanges.read()) if (c.animator === g) changes.push(c);
          }
        },
      ),
    );
    World._runIn(server, () => {
      hero.set("moving", true);
      hero.set("x", 1);
      hero.set("y", 1);
      hero.set("local", 3); // not declared replicate: never sent
    });
    step(engine, 1, log.sample);
    const changedAt = netSession(server)!.time.tick;
    step(engine, 90, log.sample);
    expect(hero.state().name).toBe("Locomotion");
    expect(g.state().name).toBe("Locomotion");
    expect((JSON.parse(g.netParameters) as [number, [number, unknown][]])[1].map(([, v]) => v)).not.toContain(3); // "local" isn't among the replicated values (the wire starts with a tick, so the string is no test)
    expect(changes.map((c) => c.to)).toEqual(["Locomotion"]); // its own transition, no jump
    log.expectMatch(changedAt + 0.5 * 60); // past the 0.2 s crossfade out of the (unsynchronised) Idle

    // A slot play starts on the client at its start tick and ends there too.
    let played!: Promise<AnimationPlayResult>;
    World._runIn(server, () => (played = hero.play(SHOT, { slot: "UpperBody" })));
    step(engine, 1, log.sample);
    const playedAt = netSession(server)!.time.tick;
    let serverDone: AnimationPlayResult | null = null;
    void played.then((r) => (serverDone = r));
    await until(engine, () => JSON.parse(g.netSlots || "[]").length > 0, "the replicated slot play");
    // It starts on the client once the interpolation time reaches its start tick (the buffer is 100 ms, 6 ticks).
    await until(engine, () => netSession(p1)!.time.interpolationTick > playedAt + 1, "the interpolation tick");
    // The client's play: `onFinished` is its latest slot play's promise once it has started (until then, a resolved `stopped`).
    let clientDone: AnimationPlayResult | null = null;
    const seen = new Set<Promise<AnimationPlayResult>>();
    for (let i = 0; i < 240 && !(clientDone && serverDone); i++) {
      const p = g.onFinished;
      if (!seen.has(p)) {
        seen.add(p);
        void p.then((r) => r.reason !== "stopped" && (clientDone = r));
      }
      step(engine, 1, log.sample);
      await pause();
    }
    expect(serverDone).toEqual({ reason: "finished" });
    expect(clientDone).toEqual({ reason: "finished" });
    log.expectMatch(playedAt - 5, netSession(p1)!.time.interpolationTick);
    // The play showed: the pose moved on from where it was when it started.
    expect(diff(log.byTick.get(playedAt - 1)!, log.byTick.get(playedAt + 10)!)).toBeGreaterThan(1e-3);
  });

  it("replicates link choices: the client links at the server's tick", async () => {
    const { engine, server, p1 } = await start();
    const armsNode = World._runIn(server, () => GameObject.instantiate("prefabs/anim-arms.json"));
    let ghost: Animator | null = null;
    await until(engine, () => (ghost = animatorIn(p1, "Arms")) !== null && pose(p1, ghost.node) !== null && pose(server, armsNode) !== null, "the ghost's pose");
    const arms = armsNode.getBehavior(Animator)!;
    const g = ghost!;
    const log = poseLog(server, p1, armsNode, g.node);
    // A graph neither side has loaded yet: each links it once it has loaded, so the client may land later.
    World._runIn(server, () => arms.link("Weapon", "graphs/axe.animgraph.json"));
    await until(engine, () => g.netLinks.includes("axe"), "the replicated link");
    const first = netSession(server)!.time.tick;
    for (let i = 0; i < 30; i++) {
      step(engine, 1, log.sample);
      await pause();
    }
    expect(JSON.parse(g.netLinks)[0].slice(0, 2)).toEqual(["Weapon", "graphs/axe.animgraph.json"]);
    log.expectMatch(first + 10);
    // Back to the default (loaded on both): the client links at the server's tick.
    World._runIn(server, () => arms.link("Weapon", null));
    step(engine, 1, log.sample);
    const linkedAt = netSession(server)!.time.tick;
    step(engine, 30, log.sample);
    expect(JSON.parse(g.netLinks)[0].slice(0, 2)).toEqual(["Weapon", null]);
    expect(diff(log.byTick.get(linkedAt - 1)!, log.byTick.get(linkedAt)!)).toBeGreaterThan(1e-3); // the pose changed at the link
    log.expectMatch(linkedAt - 10);
  });

  it("a client whose machine drifts from the server's jumps back once, after the grace time", async () => {
    const { engine, server, p1 } = await start();
    const heroNode = World._runIn(server, () => GameObject.instantiate("prefabs/anim-hero.json"));
    let ghost: Animator | null = null;
    await until(engine, () => (ghost = animatorIn(p1, "Hero")) !== null && pose(p1, ghost.node) !== null, "the ghost's pose");
    const g = ghost!;
    World._runIn(server, () => heroNode.getBehavior(Animator)!.set("moving", true));
    step(engine, 60);
    expect(g.state().name).toBe("Locomotion");

    const changes: string[] = [];
    World._runIn(p1, () =>
      GameObject.create("Watcher").addBehavior(
        class extends GameBehavior {
          lateUpdate(): void {
            for (const c of AnimatorStateChanges.read()) if (c.animator === g) changes.push(`${c.from}>${c.to}`);
          }
        },
      ),
    );
    World._runIn(p1, () => g.jump("Crouch")); // local drift: nothing on the server asks for Crouch
    step(engine, 3);
    expect(g.state().name).toBe("Crouch");
    step(engine, 60);
    expect(g.state().name).toBe("Locomotion");
    // One reconciling jump, then it stays: no snapping every tick.
    expect(changes).toEqual(["Locomotion>Crouch", "Crouch>Locomotion"]);
    // T70: it jumped back as far into Locomotion as the server is (its time since the replicated entry tick, about 2 s
    // minus the interpolation delay), not to the state's start (which would be under 1 s by now).
    expect(g.state().time).toBeGreaterThan(1.5);
  });

  it("servers evaluate only what gameplay reads: no pose without a BoneAttachment, the graph still runs", async () => {
    const { engine, server } = await start();
    const heroNode = World._runIn(server, () => GameObject.instantiate("prefabs/anim-hero.json"));
    // A server-only character with no hit volume.
    const plain = World._runIn(server, () => {
      const n = GameObject.create("Plain");
      n.addComponent(Skeleton, { skeleton: SKEL });
      n.addComponent(Animator, { graph: "hero.animgraph.json" });
      return n;
    });
    const plainAnim = plain.getBehavior(Animator)!;
    await until(engine, () => pose(server, heroNode) !== null && plainAnim.state().name === "Idle", "both graphs");
    World._runIn(server, () => plainAnim.set("moving", true));
    step(engine, 30);
    // The graph runs (its machine took the transition), but no skinning pose is produced.
    expect(plainAnim.state().name).toBe("Locomotion");
    expect(pose(server, plain)).toBeNull();
    // The followed skeleton keeps its pose, and the hit volume follows its bone.
    expect(pose(server, heroNode)).not.toBeNull();
    const hand = heroNode.children.find((c) => c.name === "Hand")!;
    const bone4 = skel.restModel.subarray(4 * 12, 5 * 12);
    expect(Vector3.distance(hand.transform!.worldPosition, new Vector3(bone4[3]!, bone4[7]!, bone4[11]!))).toBeGreaterThan(1e-4); // animated, not the rest pose
    // T70: of the followed skeleton, only bone4 and its ancestors get matrices on the server: their rows move with the
    // walk, the other bones' rows are never written (they keep what the row held).
    const chain = new Set<number>();
    for (let b = 4; b >= 0; b = skel.parents[b]!) chain.add(b);
    const others = Array.from({ length: skel.bones }, (_, b) => b).filter((b) => !chain.has(b));
    expect(others.length).toBeGreaterThan(0);
    const before = pose(server, heroNode)!;
    step(engine, 7);
    const after = pose(server, heroNode)!;
    const row = (m: Float32Array, b: number) => Array.from(m.subarray(b * 12, b * 12 + 12));
    expect(row(after, 4)).not.toEqual(row(before, 4));
    for (const b of others) expect(row(after, b), `bone ${b}`).toEqual(row(before, b));
  });
});

// ------------------------------------------------------------------------------------------------ predicted ghosts

/** Ticks the walk clip plays for as a one-shot. */
const ROLL_TICKS = Math.ceil(walkInfo.duration / DT);

describe("predicted ghosts: hybrid root motion", { timeout: 60_000 }, () => {
  /** P1 owns a predicted roller the server spawned; a still play has been played (so both ends have the clip loaded, with nothing mispredicted). */
  async function roller(latencyMs: number) {
    const worlds = await start({ latencyMs });
    const { engine, server, p1 } = worlds;
    const node = World._runIn(server, () => GameObject.instantiate("prefabs/anim-roller.json"));
    const id = netSession(p1)!.serverPeer!.id;
    World._runIn(server, () => (node.getBehavior(Replicated)!.ownerId = id));
    let ghost: Animator | null = null;
    await until(engine, () => (ghost = animatorIn(p1, "Roller")) !== null && ghost.node.getBehavior(Replicated)!.isPredictedLocally && pose(p1, ghost.node) !== null, "the predicted ghost");
    const clientLog = new Map<number, { p: Vector3; yaw: number }>();
    const sample = () => {
      const t = ghost!.node.transform!;
      clientLog.set(predictedTick(p1), { p: t.worldPosition, yaw: yawOf(t.worldRotation) });
    };
    const run = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        step(engine, 1, sample);
        await pause();
      }
    };
    stillTick = predictedTick(p1) + 5;
    await run(ROLL_TICKS + 60);
    return { ...worlds, node, anim: node.getBehavior(Animator)!, ghost: ghost!, clientLog, run };
  }

  const at = (log: Map<number, { p: Vector3; yaw: number }>, tick: number) => log.get(tick)!.p;

  /** Every tick in [from, to] both logged: P1's prediction is the server's state (within `NEAR`). */
  function expectSameTicks(client: Map<number, { p: Vector3; yaw: number }>, from: number, to: number): number {
    let compared = 0;
    for (let t = from; t <= to; t++) {
      const c = client.get(t), s = serverLog.get(t);
      if (!c || !s) continue;
      expect(Vector3.distance(c.p, s.p), `tick ${t}`).toBeLessThan(NEAR);
      expect(Math.abs(c.yaw - s.yaw), `tick ${t}`).toBeLessThan(1e-3);
      compared++;
    }
    return compared;
  }

  it("the owner predicts a root-motion one-shot exactly as the server moves it, once (not again in FixedEvaluate)", async () => {
    const { server, p1, solo, anim, clientLog, run } = await roller(60);
    const before = { ...predictionStats(p1)! };
    const start = anim.node.transform!.worldPosition;
    const T0 = (rollTick = predictedTick(p1) + 10);
    const serverTickAtT0 = netSession(server)!.time.tick;
    await run(ROLL_TICKS + 60);
    // The client moved on T0 + 1 itself, long before the server got there (60 ms each way plus the command slack).
    expect(T0 - serverTickAtT0).toBeGreaterThanOrEqual(6);
    expect(Vector3.distance(at(clientLog, T0 + 1), at(clientLog, T0))).toBeGreaterThan(1e-4);
    expect(at(clientLog, T0)).toEqual(at(clientLog, T0 - 1)); // the start tick itself doesn't move
    // Tick for tick, the prediction is the server's state, with no correction.
    expect(expectSameTicks(clientLog, T0 - 5, T0 + ROLL_TICKS + 5)).toBeGreaterThan(ROLL_TICKS);
    const after = predictionStats(p1)!;
    expect(after.mispredictions - before.mispredictions).toBe(0);
    expect(after.rollbacks - before.rollbacks).toBe(0);

    // Moved once: as far as the core's own root motion moves a node with no networking (FixedEvaluate on the server
    // didn't apply the core's root delta on top of predicted root motion).
    const moved = serverLog.get(T0 + ROLL_TICKS + 5)!.p.clone().sub(start);
    expect(moved.length).toBeGreaterThan(0.05);
    const ref = World._runIn(solo, () => {
      const n = GameObject.create("Reference");
      n.addComponent(Skeleton, { skeleton: SKEL });
      n.addComponent(Animator, { graph: "roller.animgraph.json", updateMode: "fixed", rootMotion: "transform" });
      return n;
    });
    const refAnim = ref.getBehavior(Animator)!;
    let done: AnimationPlayResult | null = null;
    World._runIn(solo, () => void refAnim.play(WALK, { slot: "Full" }).then((r) => (done = r)));
    for (let i = 0; i < ROLL_TICKS + 120 && !done; i++) await run(1);
    expect(done).toEqual({ reason: "finished" });
    // 1e-3: the core samples the clip's root bone, predicted root motion its extracted root curve.
    expect(Vector3.distance(ref.transform!.worldPosition, moved)).toBeLessThan(1e-3);
  });

  it("a server play the owner didn't predict is reconciled: the slot play and its start tick, then re-simulated as the server moved", async () => {
    const { server, p1, anim, ghost, clientLog, run } = await roller(60);
    const before = { ...predictionStats(p1)! };
    const start = anim.node.transform!.worldPosition;
    // The server plays the one-shot on its own (no input asked for it).
    World._runIn(server, () => void anim.play(WALK, { slot: "Full" }));
    const playedAt = netSession(server)!.time.tick;
    await run(ROLL_TICKS + 90);
    const after = predictionStats(p1)!;
    expect(after.rollbacks - before.rollbacks).toBeGreaterThanOrEqual(1);
    // The client adopted the play with the server's start tick: its re-simulated ticks match the server's, and stay so.
    const last = predictedTick(p1);
    expect(serverLog.get(playedAt + ROLL_TICKS + 5)!.p.clone().sub(start).length).toBeGreaterThan(0.05);
    expect(expectSameTicks(clientLog, last - 60, last)).toBeGreaterThan(30);
    expect(Vector3.distance(ghost.node.transform!.worldPosition, anim.node.transform!.worldPosition)).toBeLessThan(NEAR);
    const settled = predictionStats(p1)!;
    await run(60);
    expect(predictionStats(p1)!.rollbacks).toBe(settled.rollbacks); // no further corrections
  });

  it("a played-again tick (re-simulation) doesn't start the play twice, and a correction replays it deterministically", async () => {
    const { server, p1, anim, ghost, clientLog, run } = await roller(60);
    const T0 = (rollTick = predictedTick(p1) + 10);
    await run(13); // the client is rolling; the server, behind it, hasn't got to T0 yet
    expect(netSession(server)!.time.tick).toBeLessThan(T0);
    const roll = ghost.onFinished; // the client's play of the roll
    const before = { ...predictionStats(p1)! };
    // The server nudges the character before the roll: the client rolls back to before T0 and re-simulates the roll.
    World._runIn(server, () => (anim.node.transform!.worldPosition = anim.node.transform!.worldPosition.add(new Vector3(0.5, 0, 0))));
    await run(ROLL_TICKS + 90);
    const after = predictionStats(p1)!;
    expect(after.rollbacks - before.rollbacks).toBe(1);
    expect(after.resimulatedTicks - before.resimulatedTicks).toBeGreaterThan(5);
    // The re-simulated T0 asked for the roll again and got the first play back: no second play.
    expect(ghost.onFinished).toBe(roll);
    expect(await roll).toEqual({ reason: "finished" });
    // Re-simulated with the roll's root motion as the server moved: the same place, and the same ticks since (after
    // the 100 ms the correction's smoothing takes to blend in).
    const last = predictedTick(p1);
    expect(expectSameTicks(clientLog, last - 60, last)).toBeGreaterThan(30);
    expect(Vector3.distance(ghost.node.transform!.worldPosition, anim.node.transform!.worldPosition)).toBeLessThan(NEAR);
    expect(anim.node.transform!.worldPosition.x).toBeGreaterThan(0.4); // the nudge happened
  });

  it("a play the owner predicted that the server didn't make is dropped and stopped, and the character goes back", async () => {
    const { p1, anim, ghost, clientLog, run } = await roller(60);
    const start = anim.node.transform!.worldPosition;
    serverRefuses = true;
    const T0 = (rollTick = predictedTick(p1) + 10);
    await run(14);
    expect(Vector3.distance(at(clientLog, T0 + 3), start)).toBeGreaterThan(1e-3); // the client predicted the roll
    const roll = ghost.onFinished;
    await run(ROLL_TICKS + 60);
    expect(await roll).toEqual({ reason: "stopped" }); // the mispredicted play was stopped
    expect(Vector3.distance(anim.node.transform!.worldPosition, start)).toBe(0); // the server never moved it
    expect(Vector3.distance(ghost.node.transform!.worldPosition, start)).toBeLessThan(NEAR);
    const last = predictedTick(p1);
    expect(expectSameTicks(clientLog, last - 60, last)).toBeGreaterThan(30);
  });
});
