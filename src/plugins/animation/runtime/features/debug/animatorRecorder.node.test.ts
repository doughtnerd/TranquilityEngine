// ADR 0373 "Live debugger" (T52): the recorder in a headless Engine. A graph Animator (a machine over a 2D blend space,
// requests, a one-shot state) runs on the T31 graph fixtures (`../../wasm/fixtures/graph_*.anim`, 12 bones on
// `small.skel`); the recorder keeps its frames through the World's evaluate tap. Re-evaluated poses are compared with
// the poses the play World showed at those frames for exact equality: the core is deterministic, and replaying the
// same rows and commands from a snapshot runs the same instructions on the same inputs. Time comes from
// `engine.step(dt)` only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../../myco";
import type { World } from "../../../../../engine/core/World";
import { skinningMatrices } from "../../skeletonInstances";
import { BLOCK_CONDITION, BLOCK_READY } from "../../wasm/wire/debug";
import { AnimatorRecorder } from "./animatorRecorder";

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

/** Plays a scripted run of `frames` frames, keeping the pose the World showed after each recorded frame. */
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

describe("the recorder", () => {
  it("re-evaluates any kept frame's pose exactly, from the nearest keyframe and the recorded inputs", async () => {
    const { node, anim } = await hero("Replayed");
    const rec = new AnimatorRecorder(anim, { seconds: 10, keyframeEvery: 1 });
    const poses = play(node, anim, rec, 100);
    const frames = rec.frames;
    expect(frames.length).toBe(100);
    // A keyframe on the first frame and every second (30 frames at 1/30 s).
    expect(frames.filter((f) => rec.isKeyframe(f.index)).map((f) => f.index - frames[0]!.index)).toEqual([0, 30, 60, 90]);
    // On a keyframe, between keyframes, across a request and a state change, and backwards (a fresh restore).
    for (const i of [0, 1, 29, 30, 44, 63, 99, 12]) {
      const index = frames[i]!.index;
      const pose = rec.reevaluate(index);
      expect(pose, `frame ${i}`).not.toBeNull();
      expect(Array.from(pose!), `frame ${i}`).toEqual(Array.from(poses.get(index)!));
    }
    // Distinct frames have distinct poses (the comparison isn't vacuous).
    expect(Array.from(poses.get(frames[10]!.index)!)).not.toEqual(Array.from(poses.get(frames[70]!.index)!));
    rec.dispose();
    GameObject.destroy(node);
  });

  it("keeps the last N seconds, starting at a keyframe", async () => {
    const { node, anim } = await hero("Ring");
    const rec = new AnimatorRecorder(anim, { seconds: 1, keyframeEvery: 0.5 });
    play(node, anim, rec, 75);
    const frames = rec.frames;
    const span = frames.at(-1)!.time - frames[0]!.time;
    expect(span).toBeLessThanOrEqual(1 + 1e-6);
    expect(span).toBeGreaterThanOrEqual(0.5 - dt - 1e-6);
    expect(rec.isKeyframe(frames[0]!.index)).toBe(true);
    // Frame numbers run on; the newest is the 75th frame recorded.
    expect(frames.at(-1)!.index).toBe(74);
    expect(frames.every((f, i) => i === 0 || f.index === frames[i - 1]!.index + 1)).toBe(true);
    // A dropped frame can't be re-evaluated.
    expect(rec.reevaluate(0)).toBeNull();
    // Raising the length keeps more from now on.
    rec.seconds = 3;
    play(node, anim, rec, 60);
    expect(rec.frames.at(-1)!.time - rec.frames[0]!.time).toBeGreaterThan(1.5);
    rec.dispose();
    GameObject.destroy(node);
  });

  it("records the inputs by name and the debug report with transition blockers", async () => {
    const { node, anim } = await hero("Named");
    const rec = new AnimatorRecorder(anim);
    anim.set("x", 0.5);
    engine.step(dt);
    anim.request("Jump", { within: 0.25 });
    engine.step(dt);
    const frames = rec.frames;
    expect(frames[0]!.inputs).toContainEqual({ kind: "param", name: "x", value: 0.5 });
    expect(frames[1]!.inputs).toContainEqual({ kind: "request", name: "Jump", lifetime: 0.25 });
    expect(frames[0]!.parameters[0]).toBe(0.5);
    // Idle's transition to Locomotion waits for `moving == true` (its operand is 0 now).
    const report = frames[0]!.report;
    const idle = report.transitions.find((t) => t.blocker === BLOCK_CONDITION);
    expect(idle?.value).toBe(0);
    expect(report.machines[0]!.current).toBe(0);
    expect(report.nodes.some((n) => n.weight > 0.99)).toBe(true);
    // The any-state Jump fired on the request.
    expect(frames[1]!.report.transitions.some((t) => t.blocker === BLOCK_READY) || frames[1]!.report.machines[0]!.current === 2).toBe(true);
    rec.dispose();
    GameObject.destroy(node);
  });

  it("shows a past pose on the live character until the next evaluate or show(null)", async () => {
    const { node, anim } = await hero("Shown");
    const rec = new AnimatorRecorder(anim);
    const poses = play(node, anim, rec, 40);
    const live = skinningMatrices(world, node)!.slice();
    const past = rec.frames[5]!.index;
    expect(rec.show(past)).toBe(true);
    expect(rec.showing).toBe(past);
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(poses.get(past)!));
    expect(rec.show(null)).toBe(true);
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(live));
    // Stepping puts the live pose back before the core evaluates.
    rec.show(past);
    engine.step(0);
    expect(rec.showing).toBeNull();
    expect(Array.from(skinningMatrices(world, node)!)).not.toEqual(Array.from(poses.get(past)!));
    rec.dispose();
    GameObject.destroy(node);
  });
});
