// ADR 0370 (T13t): the animation core's host in Node, through the interface its callers use. A headless Engine with two
// Worlds starts the `AnimationCore` World service in each (`startAnimationCore`, the path a tween takes; the page's one
// core loads from disk as on the dedicated server), loads the fixture skeleton and clips into both namespaces, plays and
// crossfades through the World's command writer, evaluates, and compares the bone matrices with what anim-offline
// computed (`../wasm/fixtures/expected.json`; the same values `../wasm/core.node.test.ts` checks against the raw exports,
// at the fixture's tolerance: 1e-4 on matrix entries, f32 against f64 over a short bone chain). Then: reference counts
// across Worlds, snapshot and restore, views that survive memory growth, and release on World teardown and when the
// Engine (an editor play session) is disposed. Time comes from the core's `evaluate(dt)` only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../../../../engine/core/Engine";
import type { World } from "../../../../engine/core/World";
import { CHANGE_INTERRUPTED, PASS_NORMAL, PLAY, PLAY_INERTIALIZE, STATUS_OK, STATUS_STALE_HANDLE } from "../wasm/wire/core";
import { frameFor } from "../stages/frame";
import type { AnimationCore } from "./AnimationCore";
import type { AnimationWorldCore } from "./AnimationWorldCore";
import { loadAnimationCore } from "./loader";
import { animationCoreOf, startAnimationCore } from "./service";

interface Expected {
  maxBones: number;
  bones: number;
  dt: number;
  tolerance: number;
  play: number[];
  crossfade: number[];
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../wasm/fixtures/${name}`, import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("../wasm/fixtures/expected.json", import.meta.url), "utf8")) as Expected;
const dt = Math.fround(expected.dt);
const LIMITS = { maxInstances: 16, maxBones: expected.maxBones, arenaInitialBytes: 1 << 16 };

let engine: Engine;
let worldA: World;
let worldB: World;
let core: AnimationCore;
let a: AnimationWorldCore;
let b: AnimationWorldCore;

/** A namespace's assets: the fixture skeleton and two clips, keyed by file name. */
function assets(ns: AnimationWorldCore) {
  return {
    skel: ns.acquire("small.skel", "skeleton", () => ({ kind: "skeleton", bytes: fixture("small.skel") })),
    walk: ns.acquire("walk.anim", "clip", () => ({ kind: "clip", bytes: fixture("walk.anim") })),
    run: ns.acquire("run.anim", "clip", () => ({ kind: "clip", bytes: fixture("run.anim") })),
  };
}

const matrices = (h: number): Float32Array => {
  const at = core.matrixOffset(h);
  return core.views().matrices.slice(at, at + expected.bones * 12);
};
const maxDiff = (m: Float32Array, e: number[]): number => m.reduce((w, v, i) => Math.max(w, Math.abs(v - e[i]!)), 0);
const play = (ns: AnimationWorldCore, instance: number, clip: number, playId: number, fade = 0, flags = 0) =>
  ns.commands.put(PLAY, { instance, clip, playId, layer: 0, fade, speed: 1, start: 0, flags });

beforeAll(async () => {
  // The page's core starts with the first load's limits; the World service's later load shares it.
  const load = await loadAnimationCore(LIMITS);
  if (load.status !== "ready") throw new Error("no simd128 in this Node");
  core = load.core;
  engine = await Engine.create({ headless: true });
  engine.createWorld({ name: "B" });
  worldA = engine.world;
  worldB = engine._world("B")!;
  expect(frameFor(worldA, dt, false)).toBeNull(); // nothing has started the service yet
  a = (await startAnimationCore(worldA))!;
  b = (await startAnimationCore(worldB))!;
});

afterAll(() => engine?.dispose());

describe("the animation core host", () => {
  it("loads once per page, with the limits asked for and the memory the core said it needs", async () => {
    expect(await loadAnimationCore()).toEqual({ status: "ready", core });
    expect(core.limits).toEqual(LIMITS);
    expect(core.stats().neededBytes).toBeGreaterThan(0);
    expect([a.core, b.core]).toEqual([core, core]);
    expect(a.id).not.toBe(b.id);
  });

  it("answers a frame for a World once its core is ready", () => {
    const frame = frameFor(worldA, dt, false)!;
    expect(frame.core).toBe(a);
    expect([frame.world, frame.dt, frame.fixed, frame.pass]).toEqual([worldA, dt, false, PASS_NORMAL]);
    expect(frameFor(worldB, 0.02, true)?.dt).toBe(0.02);
  });

  it("plays and crossfades in two Worlds through the command path, matching anim-offline", () => {
    const fa = assets(a);
    const fb = assets(b);
    expect([fa.skel, fa.walk, fa.run].every((h) => h !== 0), `status ${core.lastStatus()}`).toBe(true);
    expect(fb).toEqual(fa); // one copy in the arena, shared
    const ha = a.createInstance(fa.skel);
    const hb = b.createInstance(fb.skel);
    expect(ha * hb).not.toBe(0);
    play(a, ha, fa.walk, 1);
    play(b, hb, fb.walk, 1);
    for (let f = 0; f < 10; f++) {
      a.evaluate(PASS_NORMAL, dt, dt);
      b.evaluate(PASS_NORMAL, dt, dt);
    }
    expect(maxDiff(matrices(ha), expected.play)).toBeLessThan(expected.tolerance);
    expect(maxDiff(matrices(hb), expected.play)).toBeLessThan(expected.tolerance);

    // World A crossfades; World B isn't evaluated, so its pose stays where it was.
    const before = matrices(hb);
    play(a, ha, fa.run, 2, 0.5);
    const waiting = a.evaluate(PASS_NORMAL, dt, dt);
    const changes = Array.from({ length: waiting }, (_, i) => core.stateChange(i));
    expect(changes).toContainEqual(expect.objectContaining({ kind: CHANGE_INTERRUPTED, playId: 1, instance: ha }));
    for (let f = 0; f < 5; f++) a.evaluate(PASS_NORMAL, dt, dt);
    expect(maxDiff(matrices(ha), expected.crossfade)).toBeLessThan(expected.tolerance);
    expect(matrices(hb)).toEqual(before);
  });

  it("counts asset references over every World", () => {
    const skel = a.acquire("small.skel", "skeleton", () => {
      throw new Error("loaded already: the source isn't read");
    });
    // The play test's two acquires and this one.
    expect(core.references(skel)).toBe(3);
    expect(a.release(skel)).toBe(true);
    expect(core.references(skel)).toBe(2);
    expect(b.release(skel)).toBe(true);
    expect(b.release(skel)).toBe(false); // World B held one
    expect(core.references(skel)).toBe(1);
    // Same key, another kind: another asset (and these bytes aren't a clip).
    expect(a.acquire("small.skel", "clip", { kind: "clip", bytes: fixture("small.skel") })).toBe(0);
    expect(b.acquire("small.skel", "skeleton", { kind: "skeleton", bytes: new Uint8Array(0) })).toBe(skel);
  });

  it("restores a snapshot to identical later frames", () => {
    const f = assets(a);
    const h = a.createInstance(f.skel);
    play(a, h, f.walk, 0);
    for (let i = 0; i < 4; i++) a.evaluate(PASS_NORMAL, dt, dt);
    play(a, h, f.run, 0, 0.3, PLAY_INERTIALIZE);
    a.evaluate(PASS_NORMAL, dt, dt);
    const snap = core.snapshot(h)!;
    expect(snap.length).toBeGreaterThan(0);
    const record = () => Array.from({ length: 6 }, () => (a.evaluate(PASS_NORMAL, dt, dt), matrices(h)));
    const first = record();
    expect(core.restore(h, snap)).toBe(STATUS_OK);
    expect(record()).toEqual(first);
    expect(a.destroyInstance(h)).toBe(STATUS_OK);
    expect(core.snapshot(h)).toBeNull();
  });

  // T70: a clip replaced in place keeps its handle, references and plays, is known by its new key from then on, and
  // counts a version; refused bytes change nothing.
  it("replaces a clip's file in place under its new key", () => {
    const skel = a.acquire("small.skel", "skeleton", () => ({ kind: "skeleton", bytes: fixture("small.skel") }));
    const raw = a.acquire("swap-raw", "clip", { kind: "clip", bytes: fixture("walk.anim") });
    const h = a.createInstance(skel);
    play(a, h, raw, 7);
    for (let i = 0; i < 3; i++) a.evaluate(PASS_NORMAL, dt, dt);
    const refs = core.references(raw);
    expect(core.assetVersion(raw)).toBe(0);
    expect(core.replaceClip(raw, "swap-compiled", new Uint8Array([1, 2, 3]))).not.toBe(STATUS_OK);
    expect(core.assetVersion(raw)).toBe(0);
    expect(core.replaceClip(raw, "swap-compiled", fixture("run.anim"))).toBe(STATUS_OK);
    expect(core.assetVersion(raw)).toBe(1);
    expect(core.references(raw)).toBe(refs);
    expect(a.acquire("swap-compiled", "clip", () => ({ kind: "clip", bytes: new Uint8Array(0) }))).toBe(raw); // shared by its new key
    expect(core.replaceClip(raw, "swap-compiled", fixture("run.anim"))).toBe(STATUS_OK); // already that one: nothing to do
    expect(core.assetVersion(raw)).toBe(1);
    const waiting = a.evaluate(PASS_NORMAL, dt, dt);
    expect(Array.from({ length: waiting }, (_, i) => core.stateChange(i)).filter((c) => c.instance === h)).toEqual([]); // the play goes on
    expect(core.replaceClip(0x7fff_0001, "x", fixture("run.anim"))).toBe(STATUS_STALE_HANDLE);
    a.destroyInstance(h);
  });

  // T70: match reports are read after each evaluate only for flagged instances, and stop with the flag or the instance.
  it("reads match reports for flagged instances only", () => {
    const skel = a.acquire("small.skel", "skeleton", () => ({ kind: "skeleton", bytes: fixture("small.skel") }));
    const h = a.createInstance(skel);
    a.evaluate(PASS_NORMAL, dt, dt);
    expect(core.matchDebug(h)).toBeNull();
    core.setMatchDebug(h, true);
    expect(core.matchDebug(h)).toBeNull(); // not evaluated since
    a.evaluate(PASS_NORMAL, dt, dt);
    expect(core.matchDebug(h)).toEqual({ instance: h, nodes: [] }); // the implicit graph has no pose-database node
    core.setMatchDebug(h, false);
    expect(core.matchDebug(h)).toBeNull();
    core.setMatchDebug(h, true);
    a.destroyInstance(h);
    a.evaluate(PASS_NORMAL, dt, dt);
    expect(core.matchDebug(h)).toBeNull();
    core.setMatchDebug(h, true); // a destroyed instance can't be flagged
    expect(core.matchDebug(h)).toBeNull();
  });

  it("keeps its views readable when loads grow the memory", () => {
    const f = assets(a);
    const h = a.createInstance(f.skel);
    play(a, h, f.walk, 0);
    for (let i = 0; i < 3; i++) a.evaluate(PASS_NORMAL, dt, dt);
    const pose = matrices(h);
    const old = core.views();
    const oldBytes = core.stats().memoryBytes;
    const clip = fixture("humanoid_run.anim");
    let loaded = 0;
    while (core.buffer() === old.buffer && loaded < 4096) expect(a.acquire(`grow-${loaded++}`, "clip", { kind: "clip", bytes: clip })).not.toBe(0);
    expect(core.stats().memoryBytes).toBeGreaterThan(oldBytes);
    expect(old.matrices.length).toBe(0); // the memory moved: the old view is detached
    expect(core.views() === old).toBe(false);
    expect(matrices(h)).toEqual(pose);
    a.evaluate(PASS_NORMAL, dt, dt); // and it still evaluates
    expect(matrices(h)).not.toEqual(pose);
  });

  it("closes a World's namespace when the World is torn down", () => {
    const f = assets(b);
    const h = b.createInstance(f.skel);
    const refs = core.references(f.skel);
    const instances = core.stats().instances;
    engine.findWorld("B")!.destroy();
    expect(b.open).toBe(false);
    expect(animationCoreOf(worldB)).toBeNull();
    expect(frameFor(worldB, dt, false)).toBeNull();
    expect(core.stats().instances).toBe(instances - 2); // the play test's and this one
    expect(core.references(f.skel)).toBe(refs - 2); // World B's two references to the skeleton (the reference test's and this one)
    expect(b.destroyInstance(h)).toBe(STATUS_STALE_HANDLE);
    expect(b.createInstance(f.skel)).toBe(0);
    // World A still plays with the shared assets.
    expect(core.references(f.walk)).toBeGreaterThan(0);
  });

  it("releases what the session loaded when its Engine is disposed", () => {
    expect(core.stats().assets).toBeGreaterThan(3);
    engine.dispose();
    expect(animationCoreOf(worldA)).toBeNull();
    expect(core.stats()).toMatchObject({ assets: 0, idleAssets: 0, instances: 0 });
  });
});
