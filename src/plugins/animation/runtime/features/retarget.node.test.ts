// ADR 0372 (T41t): runtime retargeting on the ECS in a headless Engine. A clip authored on skeleton A
// (`retarget_src.skel`, `retarget_walk.anim`) drives an Animator on skeleton B (`retarget_tgt.skel`) through a RETARGET
// node whose map names A, written as graph sources and compiled at run time. The bone maps are guessed (Humanoid), the
// map is made with chain alignment, and the node pins every IK goal with root axes scaled / unscaled / scaled: the
// same setup native/anim/crates/anim-wasm/tests/retarget_fixtures.rs ran on the native core, so the skinning
// matrices must equal its `retarget_expected.json` within the fixture's tolerance (1e-5: the core is deterministic, the
// margin covers printing). Time comes from `engine.step(dt)` only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { skinningMatrices } from "../skeletonInstances";

interface Fixture {
  bones: number;
  dt: number;
  frames: number;
  tolerance: number;
  goals: number;
  matrices: number[];
}

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl("retarget_expected.json"), "utf8")) as Fixture;

const SOURCE = { format: "myco.animgraph-source@1", output: "walk", nodes: [{ id: "walk", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/retarget_walk.anim" } }] };
const retargetGraph = (map: string) => ({
  format: "myco.animgraph-source@1",
  output: "rt",
  nodes: [
    {
      id: "rt",
      family: "retarget",
      kind: "retarget",
      params: { map, source: "asset:graphs/source.animgraph.json", rootX: "scaled", rootY: "unscaled", rootZ: "scaled", goalWeights: Array.from({ length: fixture.goals }, () => 1) },
    },
  ],
});

let engine: Engine;
let world: World;
const made: GameObject[] = [];

function hero(name: string, graph: string, retargetSource = ""): GameObject {
  const node = GameObject.create(name);
  made.push(node);
  node.addComponent(Skeleton, { skeleton: "anim/retarget_tgt.skel", retargetSource });
  node.addComponent(Animator, { graph });
  return node;
}

async function ready(...nodes: GameObject[]): Promise<void> {
  await vi.waitFor(() => {
    engine.step(0);
    for (const n of nodes) expect(skinningMatrices(world, n)).not.toBeNull();
  });
}

const worst = (m: Float32Array) => fixture.matrices.reduce((w, x, i) => Math.max(w, Math.abs(m[i]! - x)), 0);

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "anim/retarget_src.skel": fixtureUrl("retarget_src.skel").href,
      "anim/retarget_tgt.skel": fixtureUrl("retarget_tgt.skel").href,
      "anim/retarget_walk.anim": fixtureUrl("retarget_walk.anim").href,
      "graphs/source.animgraph.json": SOURCE,
      "retarget.animgraph.json": retargetGraph("asset:anim/retarget_src.skel"),
      // A map naming the target itself: only a Skeleton's retargetSource gives it the right source.
      "self.animgraph.json": retargetGraph("asset:anim/retarget_tgt.skel"),
      "nosource.animgraph.json": retargetGraph("asset:profiles/none.skelprofile.json"),
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

describe("a RETARGET node on the ECS", () => {
  it("drives skeleton B with a clip on skeleton A like the native core; Skeleton.retargetSource overrides the map's source", async () => {
    const byMap = hero("ByMap", "retarget.animgraph.json");
    const bySource = hero("BySource", "self.animgraph.json", "anim/retarget_src.skel");
    await ready(byMap, bySource);
    for (let f = 0; f < fixture.frames; f++) engine.step(fixture.dt);
    expect(skinningMatrices(world, byMap)!.length).toBe(fixture.bones * 12);
    expect(worst(skinningMatrices(world, byMap)!)).toBeLessThan(fixture.tolerance);
    expect(worst(skinningMatrices(world, bySource)!)).toBeLessThan(fixture.tolerance);
  });

  it("warns once and plays nothing when no source skeleton is named", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const node = hero("NoSource", "nosource.animgraph.json");
      await ready(node);
      engine.step(fixture.dt);
      expect(warn.mock.calls.filter(([m]) => String(m).includes("names no source skeleton"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
