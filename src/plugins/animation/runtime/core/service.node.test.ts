// ADR 0370 (T13t): the `AnimationCore` World service in a headless Engine, as the player and the dedicated server run it.
// The core loads lazily, the first time a World has an Animator; project files load through `Assets` from `file:` URLs
// (read from disk, as the server serves a project); the Engine's own frames run the animation stages, which now get a
// frame and evaluate through the World's namespace, matching anim-offline (`../wasm/fixtures/expected.json`, its
// tolerance: 1e-4 on matrix entries). Time comes from `engine.step(dt)`.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Engine } from "../../../../engine/core/Engine";
import { GameObject } from "../../../../engine/scene/GameObject";
import { Assets } from "../../../../engine/scene/Assets";
import { Animator } from "../components/Animator";
import { frameFor } from "../stages/frame";
import { PLAY } from "../wasm/wire/core";
import { animationCoreOf, startAnimationCore } from "./service";

interface Expected {
  bones: number;
  dt: number;
  tolerance: number;
  play: number[];
}

const expected = JSON.parse(readFileSync(new URL("../wasm/fixtures/expected.json", import.meta.url), "utf8")) as Expected;
const fileUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url).href;

let engine: Engine | null = null;
afterAll(() => engine?.dispose());

describe("the AnimationCore World service", () => {
  it("loads the core the first time a World has an Animator, and runs the stages through it", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "anim/small.skel": fileUrl("small.skel"), "anim/walk.anim": fileUrl("walk.anim"), "anim/missing.anim": fileUrl("nope.anim") }));
    engine = await Engine.create({ headless: true });
    engine.createWorld({ name: "Other" });
    const world = engine.world;
    const other = engine._world("Other")!;
    engine.step(expected.dt);
    expect(frameFor(world, expected.dt, false)).toBeNull();

    GameObject.create("Hero").addComponent(Animator);
    expect(frameFor(world, expected.dt, false)).toBeNull(); // loading
    await vi.waitFor(() => expect(animationCoreOf(world)).not.toBeNull()); // the Animator started it
    const ns = (await startAnimationCore(world))!; // running: the same namespace
    expect(ns).toBe(animationCoreOf(world));
    expect(frameFor(world, expected.dt, false)?.core).toBe(ns);
    expect(animationCoreOf(other)).toBeNull(); // no Animator there

    // Two Worlds asking for the same file at once: one read, one handle, two references.
    const otherNs = (await startAnimationCore(other))!;
    const [skel, skelAgain] = await Promise.all([ns.acquireFile("anim/small.skel", "skeleton"), otherNs.acquireFile("anim/small.skel", "skeleton")]);
    expect(skel).not.toBe(0);
    expect(skelAgain).toBe(skel);
    expect(ns.core.references(skel)).toBe(2);
    const walk = await ns.acquireFile("anim/walk.anim", "clip");
    expect(walk).not.toBe(0);
    expect(await ns.acquireFile("anim/missing.anim", "clip")).toBe(0);
    expect(await ns.acquireFile("anim/unknown.anim", "clip")).toBe(0);

    const h = ns.createInstance(skel);
    ns.commands.put(PLAY, { instance: h, clip: walk, playId: 1, speed: 1 });
    for (let f = 0; f < 10; f++) engine.step(expected.dt);
    const at = ns.core.matrixOffset(h);
    const m = ns.core.views().matrices.subarray(at, at + expected.bones * 12);
    expect(m.reduce((w, v, i) => Math.max(w, Math.abs(v - expected.play[i]!)), 0)).toBeLessThan(expected.tolerance);
  });
});
