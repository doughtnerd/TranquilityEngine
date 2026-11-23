// The live debugger's play-session source (ADR 0373 "In play mode"; T52) over a headless Engine's World: the graph
// Animators it lists per graph, the Hierarchy's live selection resolved to an Animator above it, newest frames from the
// recorder, a real debug report named by the overlay (the failing comparison with the operand's value), parameter edits
// through `Animator.set`, and recorded poses shown only while paused. Graph fixtures: the T31 clips on `small.skel`.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton, Vector2 } from "../../../../myco";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import type { World } from "../../../../engine/core/World";
import { skinningMatrices } from "../../runtime/skeletonInstances";
import { createLocalSource, type LocalDebugSource } from "./localSource";
import { overlayModel } from "./overlayLogic";

const fixtureUrl = (name: string) => new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url);
const dt = 1 / 30;
const GRAPH = {
  format: "myco.animgraph-source@1",
  output: "machine",
  parameters: [
    { name: "speed", type: "float" },
    { name: "aim", type: "vec2" },
  ],
  nodes: [
    { id: "idle", family: "sources", kind: "clipPlayer", params: { clip: "asset:idle" } },
    { id: "run", family: "sources", kind: "clipPlayer", params: { clip: "asset:run" } },
    {
      id: "machine", family: "logic", kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          { name: "Idle", root: "idle", transitions: [{ to: "Run", if: { param: "speed", op: ">", value: 0.5 }, duration: 0.1 }] },
          { name: "Run", root: "run", transitions: [{ to: "Idle", if: { param: "speed", op: "<=", value: 0.5 }, duration: 0.1 }] },
        ],
      },
    },
  ],
};
const OTHER = { format: "myco.animgraph-source@1", output: "c", nodes: [{ id: "c", family: "sources", kind: "clipPlayer", params: { clip: "asset:idle" } }] };

let engine: Engine;
let world: World;
let paused = false;
let selected: GameObject | null = null;
let source: LocalDebugSource;

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "anim/small.skel": fixtureUrl("small.skel").href,
      idle: fixtureUrl("graph_idle.anim").href,
      run: fixtureUrl("graph_run.anim").href,
      "hero.animgraph.json": GRAPH,
      "other.animgraph.json": OTHER,
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
  source = createLocalSource({ worlds: () => [world], paused: () => paused, liveNode: () => selected, redraw: () => {} });
});

afterAll(() => {
  source?.dispose();
  engine?.dispose();
});

async function character(name: string, graph: string): Promise<{ node: GameObject; anim: Animator; mesh: GameObject }> {
  const node = GameObject.create(name);
  node.addComponent(Skeleton, { skeleton: "anim/small.skel" });
  const anim = node.addComponent(Animator, { graph, parameters: {}, linkedGraphNodes: [], linkedGraphs: [], defaultClip: "" });
  const mesh = GameObject.create(`${name} mesh`, { parent: node });
  await vi.waitFor(() => {
    engine.step(0);
    expect(skinningMatrices(world, node)).not.toBeNull();
  });
  return { node, anim, mesh };
}

describe("the play-session source", () => {
  it("lists graph Animators per graph and follows the live selection up to an Animator", async () => {
    const hero = await character("Hero", "hero.animgraph.json");
    const other = await character("Other", "other.animgraph.json");
    expect(source.live).toBe(true);
    expect(source.targets("hero.animgraph.json").map((t) => t.label)).toEqual(["Hero"]);
    expect(source.targets("asset:hero.animgraph.json").map((t) => t.label)).toEqual(["Hero"]);
    expect(source.targets().map((t) => t.label).sort()).toEqual(["Hero", "Other"]);
    const id = source.targets("hero.animgraph.json")[0]!.id;
    selected = hero.mesh; // a child of the character
    expect(source.selected()).toBe(id);
    selected = null;
    expect(source.selected()).toBeNull();
    GameObject.destroy(other.node);
    GameObject.destroy(hero.node);
    engine.step(0);
    expect(source.targets()).toEqual([]);
  });

  it("gives newest frames whose report the overlay names, and routes parameter edits to Animator.set", async () => {
    const { node, anim } = await character("Edited", "hero.animgraph.json");
    const target = source.targets("hero.animgraph.json")[0]!;
    // Before any recorded frame (selected while paused), the frame is read now.
    expect(source.frame(target.id)?.index).toBe(-1);
    const set = vi.spyOn(anim, "set");
    expect(source.set(target.id, "speed", 0.2)).toBe(true);
    expect(source.set(target.id, "aim", [0.5, 1])).toBe(true);
    expect(set).toHaveBeenNthCalledWith(1, "speed", 0.2);
    expect(set.mock.calls[1]![1]).toBeInstanceOf(Vector2);
    engine.step(dt);
    const frame = source.frame(target.id)!;
    expect(frame.index).toBe(0);
    expect(frame.parameters).toEqual([expect.closeTo(0.2, 6), [0.5, 1]]);
    const overlay = overlayModel(parseAnimGraph(GRAPH).value, target.tables, frame.report);
    expect(overlay.machines.get("machine")?.current).toBe("Idle");
    expect(overlay.nodes.get("idle")?.weight).toBeCloseTo(1, 6);
    expect(overlay.transitions.get("machine/Idle/0")).toEqual({ blocker: "condition", why: "Its condition is false: speed > 0.5 fails, because speed is 0.20." });
    // An edit takes the machine on.
    source.set(target.id, "speed", 0.9);
    for (let i = 0; i < 5; i++) engine.step(dt);
    expect(overlayModel(parseAnimGraph(GRAPH).value, target.tables, source.frame(target.id)!.report).machines.get("machine")?.current).toBe("Run");
    expect(source.set("gone#1", "speed", 1)).toBe(false);
    set.mockRestore();
    GameObject.destroy(node);
    engine.step(0);
  });

  it("shows a recorded pose only while paused", async () => {
    const { node, anim } = await character("Scrubbed", "hero.animgraph.json");
    const target = source.targets("hero.animgraph.json")[0]!;
    source.frame(target.id); // starts recording
    const poses: Float32Array[] = [];
    for (let i = 0; i < 20; i++) {
      anim.set("speed", i / 10);
      engine.step(dt);
      poses.push(skinningMatrices(world, node)!.slice());
    }
    const rec = source.recording(target.id)!;
    expect(rec.frames).toHaveLength(20);
    expect(rec.seconds).toBe(10);
    paused = false;
    expect(rec.show(rec.frames[4]!.index)).toBe(false);
    paused = true;
    expect(rec.show(rec.frames[4]!.index)).toBe(true);
    expect(rec.showing).toBe(rec.frames[4]!.index);
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(poses[4]!));
    expect(rec.show(null)).toBe(true);
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(poses[19]!));
    paused = false;
    rec.seconds = 5;
    expect(source.recording(target.id)!.seconds).toBe(5);
    GameObject.destroy(node);
    engine.step(0);
  });
});
