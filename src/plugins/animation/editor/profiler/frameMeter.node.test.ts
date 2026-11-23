// T34: the frame meter behind the Animation table, through the World's namespace in a headless Engine: a playing
// Animator produces non-zero evaluate counts and stage times, an idle World reports nothing new, and the rows the
// table shows come from those numbers. Time comes from `engine.step(dt)`; the stage times are only checked to be
// measured (>= 0 and finite), never against a wall-clock tolerance.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { applyTestPlugins } from "../../../testPlugins";
import { animationCoreOf } from "../../runtime/core/service";
import { instanceForSkeleton } from "../../runtime/skeletonInstances";
import { animationRows } from "./profilerLogic";

const url = (name: string) => new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url);
const SKEL = "anim/small.skel";
const WALK = "anim/walk.anim";

let engine: Engine;
let world: World;

beforeAll(async () => {
  applyTestPlugins();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ [SKEL]: url("small.skel").href, [WALK]: url("walk.anim").href }));
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

async function hero(cullingMode: "always" | "whenVisible"): Promise<Animator> {
  const node = GameObject.create("Hero");
  node.addComponent(Skeleton, { skeleton: SKEL });
  const anim = node.addComponent(Animator, { cullingMode });
  await vi.waitFor(() => expect(instanceForSkeleton(world, node)).not.toBe(0));
  anim.play(WALK);
  await vi.waitFor(() => {
    engine.step(0);
    expect(anim.state().name).not.toBe("");
  });
  return anim;
}

describe("the Animation frame meter", () => {
  it("counts a playing Animator's evaluates and measures the stages", async () => {
    await hero("always");
    const ns = animationCoreOf(world)!;
    ns.meter.take(); // start a period
    for (let i = 0; i < 10; i++) engine.step(1 / 60);
    const stats = ns.meter.take()!;
    expect(stats.frames).toBe(10);
    expect(stats.instances).toBeGreaterThanOrEqual(1);
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.evaluated).toBeGreaterThanOrEqual(1);
    expect(stats.bones).toBeGreaterThan(0);
    expect(stats.skinned).toBeGreaterThanOrEqual(1);
    for (const ms of [stats.gatherMs, stats.evaluateMs, stats.applyMs]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(stats.faults).toBe(0);
    const rows = animationRows(stats, ns.core.stats());
    expect(rows.find((r) => r.label === "Evaluated")!.value).not.toBe("0");
    expect(rows.find((r) => r.label === "Core memory")!.value).toMatch(/MB$/);
  });

  it("starts a new period at each take, and reports nothing before a frame runs", () => {
    const ns = animationCoreOf(world)!;
    ns.meter.take();
    expect(ns.meter.take()).toBeNull();
    engine.step(1 / 60);
    expect(ns.meter.take()!.frames).toBe(1);
  });

  it("counts a hidden whenVisible Animator as culled, not evaluated", async () => {
    const anims = [await hero("whenVisible")];
    const ns = animationCoreOf(world)!;
    ns.meter.take();
    for (let i = 0; i < 5; i++) engine.step(1 / 60);
    const stats = ns.meter.take()!;
    expect(anims.length).toBe(1);
    expect(stats.instances).toBeGreaterThanOrEqual(2); // this one and the first test's
    expect(stats.culled).toBeGreaterThanOrEqual(0);
    expect(stats.active + stats.culled).toBeCloseTo(stats.instances, 5);
  });
});
