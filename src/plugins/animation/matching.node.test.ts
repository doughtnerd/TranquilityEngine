// ADR 0372 (T42t): motion matching on the ECS in a headless Engine. Three authored clips on `small.skel` move its root
// bone at 0 (idle), 1.4 (walk) and 3.5 m/s (run) along +Z, compiled as an export compiles them (the editor module's
// compressor extracts their root curves) and served as `clips/*.anim`. A small pose database (trajectory positions and
// facings 1/3, 2/3 and 1 s ahead) is baked in the test with the editor's module (`posedb_bake`, the bake the editor's
// Pose Database tool runs, T55) from those clips, and served beside its source as `*.posedb.bin`; the runtime loads it
// and binds the clips it lists.
// The host writes the character's position, yaw and velocity into the node's parameters; the test sets only the
// desired velocity (`Animator.set`), and the Animator's root motion (`rootMotion: "transform"`) shows which clip the
// search picked: the node's speed. Time comes from `engine.step(dt)` only. Speeds are measured over 0.5 s once the
// search has settled (the trajectory spring lags the desired velocity and switches blend in), so the bands are wide
// but disjoint: idle under 0.2 m/s, walk 1–2 m/s, run over 2.8 m/s.
//
// It lives beside the plugin's halves, not in `runtime/`, because baking needs the editor module, which runtime files
// (tests too) never import (ADR 0133).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton, Vector3 } from "../../myco";
import { parseAnimSource } from "../../engine/animation/animSource";
import { compileRawClip, rootMotionAxes } from "../../engine/animation/compile/rawClip";
import type { World } from "../../engine/core/World";
import { loadAnimationCompiler } from "./editor/compile/compiler";
import { readSkeletonInfo } from "./runtime/assetInfo";
import { matchDebugOf, watchMatchDebug } from "./runtime/features/matching/debug";
import { skinningMatrices } from "./runtime/skeletonInstances";

const fixtureUrl = (name: string) => new URL(`./runtime/wasm/fixtures/${name}`, import.meta.url);
const skeletonBytes = new Uint8Array(readFileSync(fixtureUrl("small.skel")));
const skel = readSkeletonInfo(skeletonBytes)!;
const dt = 1 / 30;

/** A one-second looping clip moving the root bone at `speed` m/s along +Z, its root motion extracted. */
function locomotion(speed: number) {
  const y = skel.restModel[7]!;
  return {
    format: "myco.anim-source@1",
    duration: 1,
    loop: true,
    rootMotion: { bone: skel.names[0], axes: ["x", "z", "yaw"] },
    tracks: [{ kind: "bone", target: { bone: skel.names[0] }, translation: [[0, 0, y, 0], [1, 0, y, speed]] }],
  };
}
const SOURCES: Record<string, ReturnType<typeof locomotion>> = {
  "clips/idle.anim": locomotion(0),
  "clips/walk.anim": locomotion(1.4),
  "clips/run.anim": locomotion(3.5),
};

const graph = (database: string) => ({
  format: "myco.animgraph-source@1",
  output: "mm",
  parameters: [
    { name: "position", type: "vec3" },
    { name: "yaw", type: "float" },
    { name: "velocity", type: "vec3" },
    { name: "desired", type: "vec3" },
    { name: "lod", type: "float", default: 1 },
  ],
  nodes: [{ id: "mm", family: "matching", kind: "poseDatabase", params: { database, position: "position", yaw: "yaw", velocity: "velocity", desiredVelocity: "desired", lod: "lod", interval: 2 } }],
});

let engine: Engine;
let world: World;

/** Each clip compiled as an export compiles it (the compressor extracts the root curve), by project path. */
async function compileClips(): Promise<Record<string, Uint8Array>> {
  const compiler = await loadAnimationCompiler();
  const out: Record<string, Uint8Array> = {};
  for (const [path, json] of Object.entries(SOURCES)) {
    const source = parseAnimSource(json, path).value;
    const record = Float32Array.from([1e-5, 1e-5, 0, 32, 0, 0, rootMotionAxes(source.rootMotion), 0]);
    const compiled = compiler.compressClip(compileRawClip(source, skel).bytes, skeletonBytes, record);
    if (!compiled.ok) throw new Error(`compile failed: ${compiled.error}`);
    out[path] = compiled.bytes;
  }
  return out;
}

async function bake(clipBytes: Record<string, Uint8Array>): Promise<Uint8Array> {
  const compiler = await loadAnimationCompiler();
  const schema = [1 / 3, 2 / 3, 1].flatMap((t) => [
    { kind: 2, bone: -1, weight: 1, timeOffset: t },
    { kind: 3, bone: -1, weight: 1, timeOffset: t },
  ]);
  const clips = Object.entries(clipBytes).map(([asset, bytes]) => ({ bytes, asset, ranges: [] }));
  const out = compiler.bakePoseDatabase(skeletonBytes, clips, schema, {});
  if (!("bytes" in out)) throw new Error(`bake failed: ${out.error}`);
  return out.bytes;
}

beforeAll(async () => {
  const clips = await compileClips();
  const db = await bake(clips);
  const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "anim/small.skel": fixtureUrl("small.skel").href,
      ...Object.fromEntries(Object.entries(clips).map(([path, bytes]) => [path, dataUrl(bytes)])),
      // The bake beside its source: the graph names the source.
      "db/loco.posedb.bin": dataUrl(db),
      "loco.animgraph.json": graph("asset:db/loco.posedb.json"),
      "unbaked.animgraph.json": graph("asset:db/unbaked.posedb.json"),
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

function hero(name: string, graphPath: string): { node: GameObject; anim: Animator } {
  const node = GameObject.create(name);
  node.addComponent(Skeleton, { skeleton: "anim/small.skel" });
  const anim = node.addComponent(Animator, { graph: graphPath, rootMotion: "transform" });
  return { node, anim };
}

async function ready(node: GameObject): Promise<void> {
  await vi.waitFor(() => {
    engine.step(0);
    expect(skinningMatrices(world, node)).not.toBeNull();
  });
}

/** The node's ground speed over the next `seconds`. */
function speedOver(node: GameObject, seconds: number): number {
  const from = node.transform!.worldPosition;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) engine.step(dt);
  const to = node.transform!.worldPosition;
  return Math.hypot(to.x - from.x, to.z - from.z) / (n * dt);
}

describe("a pose-database node on the ECS", () => {
  it("switches clips as the desired velocity changes", async () => {
    const { node, anim } = hero("Matcher", "loco.animgraph.json");
    await ready(node);
    anim.set("desired", new Vector3(0, 0, 0));
    speedOver(node, 1);
    expect(speedOver(node, 0.5)).toBeLessThan(0.2);
    anim.set("desired", new Vector3(0, 0, 3.5));
    speedOver(node, 1.5);
    expect(speedOver(node, 0.5)).toBeGreaterThan(2.8);
    anim.set("desired", new Vector3(0, 0, 1.4));
    speedOver(node, 1.5);
    const walk = speedOver(node, 0.5);
    expect(walk).toBeGreaterThan(1);
    expect(walk).toBeLessThan(2);
    anim.set("desired", new Vector3(0, 0, 0));
    speedOver(node, 1.5);
    expect(speedOver(node, 0.5)).toBeLessThan(0.2);
    GameObject.destroy(node);
  });

  // T70: the core's match report, read for an Animator while it's watched (the editor's match debug view asks so): the
  // trajectory the node predicted (the database's three offsets, ahead of a character running along +Z), the playing
  // frame's clip by the name the database lists, and that frame's trajectory.
  it("reports the predicted trajectory and the matched frame while watched", async () => {
    const { node, anim } = hero("Watched", "loco.animgraph.json");
    await ready(node);
    expect(matchDebugOf(anim)).toBeNull(); // not watched: nothing read
    watchMatchDebug(anim, true);
    anim.set("desired", new Vector3(0, 0, 3.5));
    speedOver(node, 1.5);
    const d = matchDebugOf(anim)!;
    expect(d.predicted.map((s) => s.time)).toEqual([1 / 3, 2 / 3, 1].map(Math.fround));
    expect(d.predicted.every((s) => s.position[1] > 0.5 && Math.abs(s.position[0]) < 0.1)).toBe(true);
    expect(d.predicted[2]!.position[1]).toBeGreaterThan(d.predicted[0]!.position[1]);
    expect(d.matched).toMatchObject({ clip: "clips/run.anim", mirrored: false });
    expect(d.matched!.trajectory.map((s) => s.time)).toEqual(d.predicted.map((s) => s.time));
    // The run clip's own trajectory: 3.5 m/s ahead.
    expect(d.matched!.trajectory[2]!.position[1]).toBeCloseTo(3.5, 1);
    watchMatchDebug(anim, false);
    expect(matchDebugOf(anim)).toBeNull();
    GameObject.destroy(node);
  });

  it("warns once when the database has no baked file beside its source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { node } = hero("Unbaked", "unbaked.animgraph.json");
      await ready(node);
      engine.step(dt);
      expect(warn.mock.calls.filter(([m]) => String(m).includes("db/unbaked.posedb.bin"))).toHaveLength(1);
      GameObject.destroy(node);
    } finally {
      warn.mockRestore();
    }
  });
});
