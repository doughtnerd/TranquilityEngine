// ADR 0348, 0373 (T73): the animation take source in a headless Engine. A short run of a graph Animator is recorded through
// the take source into the records a take file holds (the host is a plain collector standing in for the audio take
// recorder; `audio/runtime/capture/take.test.ts` covers the file framing of such records), the records are read back, and:
//
// - the frames read equal the live recorder's frames of the same run (same inputs, reports, parameters, root motion);
// - re-evaluating any frame from a take keyframe gives the pose the World showed then, bit for bit;
// - a take re-evaluates against a graph that changed in a way its snapshot refuses by saying no (null), not by a wrong pose.
//
// Time comes from `engine.step(dt)` only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TakeExtensionRecord } from "../../../../../engine/audio/take/extensions";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../../myco";
import type { World } from "../../../../../engine/core/World";
import { skinningMatrices } from "../../skeletonInstances";
import { ANIM_FRAME, ANIM_KEY, ANIM_RAW, ANIM_SELECT, ANIM_TARGET } from "./frameRecord";
import { AnimatorRecorder } from "./recorder";
import { animationTakeSource } from "./takeRecord";
import { readAnimationTake } from "./takeRead";
import { TakeReplayer } from "./takeReplay";

const fixtureUrl = (name: string) => new URL(`../../wasm/fixtures/${name}`, import.meta.url);
const dt = 1 / 30;
const clip = (id: string, path: string, extra: Record<string, unknown> = {}) => ({ id, family: "sources", kind: "clipPlayer", params: { clip: `asset:${path}`, ...extra } });

const GRAPH = {
  format: "myco.animgraph-source@1",
  output: "machine",
  parameters: [
    { name: "x", type: "float" },
    { name: "y", type: "float" },
    { name: "moving", type: "bool" },
  ],
  nodes: [
    clip("idle", "idle"),
    clip("walk", "walk"),
    clip("run", "run"),
    clip("idleSample", "idle"),
    clip("jump", "run", { loop: "once" }),
    { id: "move", family: "sources", kind: "blendSpace2D", inputs: ["idleSample", "walk", "run"], params: { x: "x", y: "y", coords: [0, 0, 0, 1, 1, 1] } },
    {
      id: "machine",
      family: "logic",
      kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          { name: "Idle", root: "idle", transitions: [{ to: "Locomotion", if: { param: "moving", op: "==", value: true }, duration: 0.2 }] },
          { name: "Locomotion", root: "move", transitions: [{ to: "Idle", if: { param: "moving", op: "==", value: false }, duration: 0.1 }] },
          { name: "Jump", root: "jump", transitions: [{ to: "Locomotion", when: "exit", duration: 0.15 }] },
        ],
        anyState: [{ to: "Jump", if: { request: "Jump" }, duration: 0.05 }],
      },
    },
  ],
};

const SKEL = "anim/small.skel";
let engine: Engine;
let world: World;

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      [SKEL]: fixtureUrl("small.skel").href,
      idle: fixtureUrl("graph_idle.anim").href,
      walk: fixtureUrl("graph_walk.anim").href,
      run: fixtureUrl("graph_run.anim").href,
      "hero.animgraph.json": GRAPH,
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

async function hero(name: string): Promise<{ node: GameObject; anim: Animator }> {
  const node = GameObject.create(name);
  node.addComponent(Skeleton, { skeleton: SKEL });
  const anim = node.addComponent(Animator, { graph: "hero.animgraph.json", parameters: {}, linkedGraphNodes: [], linkedGraphs: [], defaultClip: "" });
  await vi.waitFor(() => {
    engine.step(0);
    expect(skinningMatrices(world, node)).not.toBeNull();
  });
  return { node, anim };
}

/** A take host that collects what the source writes, in order, as a take file would hold it. */
function collector() {
  const records: TakeExtensionRecord[] = [];
  let seq = 1;
  let open = true;
  return {
    records,
    close: () => void (open = false),
    host: {
      engine,
      get seconds() {
        return records.length / 100;
      },
      write(type: number, payload: Uint8Array): boolean {
        if (!open) return false;
        records.push({ type, seq: seq++, payload: payload.slice() });
        return true;
      },
    },
  };
}

/** A scripted run; keeps the pose the World showed after each frame, by the frame's index in `rec`. */
function play(node: GameObject, anim: Animator, rec: AnimatorRecorder, frames: number): Map<number, Float32Array> {
  const poses = new Map<number, Float32Array>();
  for (let i = 0; i < frames; i++) {
    if (i === 3) anim.set("moving", true);
    anim.set("x", Math.min(1, i / 40));
    anim.set("y", (i % 17) / 17);
    if (i === 25 || i === 61) anim.request("Jump", { within: 0.2 });
    if (i === 80) anim.set("moving", false);
    engine.step(dt);
    const f = rec.latest;
    if (f) poses.set(f.index, skinningMatrices(world, node)!.slice());
  }
  return poses;
}

describe("the animation take source", () => {
  it("writes the Animator's records in order, and a reader gets frames equal to the live recorder's", async () => {
    const { node, anim } = await hero("Recorded");
    const live = new AnimatorRecorder(anim, { seconds: 10 });
    const c = collector();
    const run = animationTakeSource.start(c.host);
    play(node, anim, live, 100);
    run.stop();
    c.close();

    const types = c.records.map((r) => r.type);
    expect(types[0]).toBe(ANIM_TARGET);
    expect(types.filter((t) => t === ANIM_FRAME)).toHaveLength(100);
    expect(types.filter((t) => t === ANIM_RAW)).toHaveLength(100);
    expect(types.filter((t) => t === ANIM_KEY)).toHaveLength(4); // the first frame and each second
    expect(types.filter((t) => t === ANIM_SELECT)).toHaveLength(0); // one Animator: declared once, never reselected
    // Each frame's records come in the order key, raw, frame.
    expect(types.slice(1, 4)).toEqual([ANIM_KEY, ANIM_RAW, ANIM_FRAME]);

    const take = readAnimationTake(c.records);
    expect(take.problems).toEqual([]);
    expect(take.targets).toHaveLength(1);
    const target = take.targets[0]!;
    expect(target.info).toMatchObject({ label: "Recorded", graph: "hero.animgraph.json", bones: 12 });
    expect(target.info.tables.parameters).toEqual(["x", "y", "moving"]);
    expect(target.changedWhileRecording).toBe(false);
    // The take source's recorder started with the take's source, the live one a step before: compare by frame, after the
    // live recorder's extra opening frames.
    const liveFrames = live.frames;
    const first = liveFrames.length - target.entries.length;
    expect(first).toBeGreaterThanOrEqual(0);
    target.entries.forEach((e, i) => {
      const f = liveFrames[first + i]!;
      expect({ ...e.frame, index: 0 }).toEqual({ ...f, index: 0 });
    });
    expect(target.entries.filter((e) => e.key).length).toBe(4);
    expect(take.duration).toBeCloseTo(100 * dt, 6);
    live.dispose();
    GameObject.destroy(node);
  });

  it("re-evaluates any frame from a take keyframe to the pose the World showed, bit for bit", async () => {
    const { node, anim } = await hero("Replayed");
    const live = new AnimatorRecorder(anim, { seconds: 10 });
    const c = collector();
    const run = animationTakeSource.start(c.host);
    const poses = play(node, anim, live, 100);
    run.stop();
    const target = readAnimationTake(c.records).targets[0]!;
    const replay = new TakeReplayer(target, anim);
    const indexOf = (i: number) => target.entries[i]!.frame.index;
    // The live recorder numbers its frames alike (both started at the first step after the take's did, or before): map by order.
    const liveIndex = live.frames.at(-100)!.index;
    for (const i of [0, 1, 29, 30, 44, 63, 99, 12]) {
      const pose = replay.reevaluate(indexOf(i));
      expect(pose, `frame ${i}`).not.toBeNull();
      expect(Array.from(pose!), `frame ${i}`).toEqual(Array.from(poses.get(liveIndex + i)!));
    }
    expect(replay.isKeyframe(indexOf(30))).toBe(true);
    expect(replay.isKeyframe(indexOf(31))).toBe(false);
    // Distinct frames have distinct poses (the comparison isn't vacuous).
    expect(Array.from(poses.get(liveIndex + 10)!)).not.toEqual(Array.from(poses.get(liveIndex + 70)!));
    // Showing writes the pose on the live character until show(null).
    const livePose = skinningMatrices(world, node)!.slice();
    expect(replay.show(indexOf(5))).toBe(true);
    expect(replay.showing).toBe(indexOf(5));
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(poses.get(liveIndex + 5)!));
    expect(replay.show(null)).toBe(true);
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(livePose));
    // A frame that isn't in the take can't be shown.
    expect(replay.reevaluate(100_000)).toBeNull();
    replay.dispose();
    live.dispose();
    GameObject.destroy(node);
  });

  it("follows several Animators, picks one up that starts later, and stops writing when the take stops", async () => {
    const a = await hero("First");
    const c = collector();
    const run = animationTakeSource.start(c.host);
    engine.step(dt);
    const b = await hero("Second"); // starts while the take records
    for (let i = 0; i < 5; i++) engine.step(dt);
    run.stop();
    const written = c.records.length;
    engine.step(dt);
    expect(c.records.length).toBe(written);
    const take = readAnimationTake(c.records);
    expect(take.problems).toEqual([]);
    expect(take.targets.map((t) => t.info.label).sort()).toEqual(["First", "Second"]);
    expect(c.records.some((r) => r.type === ANIM_SELECT)).toBe(true);
    for (const t of take.targets) expect(t.entries.length).toBeGreaterThan(0);
    GameObject.destroy(a.node);
    GameObject.destroy(b.node);
  });

  it("leaves out a record that doesn't read, with a problem, and keeps the rest", async () => {
    const { node } = await hero("Damaged");
    const c = collector();
    const run = animationTakeSource.start(c.host);
    for (let i = 0; i < 10; i++) engine.step(dt);
    run.stop();
    const frames = c.records.findIndex((r) => r.type === ANIM_FRAME);
    expect(frames).toBeGreaterThan(0);
    const bad = c.records.map((r, i) => (i === frames ? { ...r, payload: r.payload.slice(0, 6) } : r));
    const take = readAnimationTake(bad);
    expect(take.problems).toHaveLength(1);
    expect(take.problems[0]).toContain("animation frame record doesn't read");
    expect(take.targets[0]!.entries.length).toBe(9);
    GameObject.destroy(node);
  });
});
