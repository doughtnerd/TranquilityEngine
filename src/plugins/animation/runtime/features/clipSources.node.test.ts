// T19 (ADR 0371): where an Animator's clip comes from, in a headless Engine through the public API (`myco`) and the
// render-sync contract (`skinningMatrices`, what T16 reads). An authored clip (`*.anim.json`) plays its raw form, made
// on the fly and bound to the Animator's skeleton by name; the editor's compiled clip (`setCompiledClipSource`, the seam
// the editor's compile cache fills) is preferred when it has one; a build's compiled file (`*.anim.bin` beside the
// source) is preferred over both. Time comes from `engine.step(dt)` only. Compiled clips are told apart by serving a
// different clip's bytes (the `walk.anim` fixture) and comparing with its anim-offline matrices at the fixture's
// tolerance (1e-4 on matrix entries); the raw form against the same raw bytes loaded as a file must match exactly.
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { animSourceToJson, emptyAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { compiledClipPath } from "../../../../engine/animation/compile/keys";
import { compileRawClip } from "../../../../engine/animation/compile/rawClip";
import { readSkeletonInfo } from "../assetInfo";
import { animationCoreOf } from "../core/service";
import { instanceForSkeleton, skinningMatrices } from "../skeletonInstances";
import { setCompiledClipSource, type CompiledClipRequest } from "./clipSources";

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(fixtureUrl(name)));
const expected = JSON.parse(readFileSync(fixtureUrl("expected.json"), "utf8")) as { dt: number; tolerance: number; play: number[] };
const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
const dt = expected.dt;

const SKEL = "anim/small.skel";
const skeleton = readSkeletonInfo(fixture("small.skel"))!;

/** A 1 s looping clip turning bones 1–4 about +Y (named as the skeleton names them: `bone1`…). */
function wave(): AnimSource {
  const turn = (b: number) => ({ kind: "bone" as const, bone: `bone${b}`, translation: [], scale: [], rotation: [[0, 0, 0, 0, 1], [0.5, 0, Math.sin(0.2 * b), 0, Math.cos(0.2 * b)], [1, 0, 0, 0, 1]] as [number, number, number, number, number][] });
  return { ...emptyAnimSource(), name: "Wave", duration: 1, loop: true, tracks: [1, 2, 3, 4].map(turn) };
}
const lamp = (): AnimSource => ({ ...emptyAnimSource(), duration: 1, tracks: [{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, 2]]] }] });

const WAVE = "anim/wave.anim.json";
const WAVE_RAW = "anim/wave-raw.anim";
const BUILT = "anim/built.anim.json";
const LAMP = "anim/lamp.anim.json";
const WALK = "anim/walk.anim";

let engine: Engine;
let world: World;
const made: GameObject[] = [];
const steps = (n: number) => {
  for (let i = 0; i < n; i++) engine.step(dt);
};
const maxDiff = (m: ArrayLike<number> | null, e: readonly number[]): number => {
  if (!m) return Number.POSITIVE_INFINITY;
  let w = 0;
  for (let i = 0; i < e.length; i++) w = Math.max(w, Math.abs(m[i]! - e[i]!));
  return w;
};

async function hero(): Promise<{ node: GameObject; anim: Animator }> {
  const node = GameObject.create("Hero");
  made.push(node);
  node.addComponent(Skeleton, { skeleton: SKEL });
  const anim = node.addComponent(Animator);
  await vi.waitFor(() => expect(instanceForSkeleton(world, node)).not.toBe(0));
  return { node, anim };
}

/** Plays each `[animator, clip]` and steps with dt 0 until all show (resolved, loaded and sent), then 10 frames. */
async function play(...plays: [Animator, string][]): Promise<void> {
  for (const [anim, clip] of plays) anim.play(clip);
  await vi.waitFor(() => {
    engine.step(0);
    for (const [anim, clip] of plays) expect(anim.state().name).toBe(clip);
  });
  steps(10);
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      [SKEL]: fixtureUrl("small.skel").href,
      [WAVE]: animSourceToJson(wave()),
      [WAVE_RAW]: dataUrl(compileRawClip(wave(), skeleton).bytes),
      [BUILT]: animSourceToJson(wave()),
      [compiledClipPath(BUILT, SKEL)]: fixtureUrl("walk.anim").href,
      [LAMP]: animSourceToJson(lamp()),
      [WALK]: fixtureUrl("walk.anim").href,
    }),
  );
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterEach(() => {
  setCompiledClipSource(null);
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
});

afterAll(() => engine?.dispose());

describe("clip sources (T19)", () => {
  it("play an authored clip's raw form, made on the fly and bound to the Animator's skeleton by name", async () => {
    const a = await hero();
    const b = await hero();
    await play([a.anim, WAVE], [b.anim, WAVE_RAW]);
    const ma = skinningMatrices(world, a.node)!.slice();
    const mb = skinningMatrices(world, b.node)!.slice();
    expect(ma).toEqual(mb);
    expect(maxDiff(ma, expected.play)).toBeGreaterThan(0.01); // not the walk
  });

  it("prefer the editor's compiled clip when it has one, asking with the Animator's skeleton", async () => {
    const asked: CompiledClipRequest[] = [];
    setCompiledClipSource({ compiled: async (r) => (asked.push(r), fixture("walk.anim")) });
    const { node, anim } = await hero();
    await play([anim, WAVE]);
    expect(asked).toEqual([{ clip: WAVE, skeleton: SKEL }]);
    expect(maxDiff(skinningMatrices(world, node), expected.play)).toBeLessThan(expected.tolerance);
  });

  it("play the raw form while the editor has no compiled clip yet", async () => {
    setCompiledClipSource({ compiled: async () => null });
    const a = await hero();
    const b = await hero();
    await play([a.anim, WAVE], [b.anim, WAVE_RAW]);
    expect(skinningMatrices(world, a.node)!.slice()).toEqual(skinningMatrices(world, b.node)!.slice());
  });

  // T70: a raw clip whose compile finishes switches to the compiled bytes in place: the play goes on from where it is (its
  // time keeps counting, no state change), and from then on it samples the compiled clip (told apart by serving the walk
  // fixture's bytes as the "compiled" form): the same pose as an Animator that played the walk file from the same frame.
  it("switch a playing raw clip to its compiled form in place when the compile finishes", async () => {
    let finish: ((bytes: Uint8Array) => void) | undefined;
    setCompiledClipSource({ compiled: async (_r, onCompiled) => ((finish = onCompiled), null) });
    const a = await hero();
    const b = await hero();
    const c = await hero();
    await play([a.anim, WAVE], [b.anim, WALK], [c.anim, WAVE_RAW]);
    expect(a.anim.state().time).toBe(b.anim.state().time);
    expect(skinningMatrices(world, a.node)!.slice()).toEqual(skinningMatrices(world, c.node)!.slice()); // still raw
    const before = a.anim.state().time;
    finish!(fixture("walk.anim"));
    await Promise.resolve();
    steps(5);
    expect(a.anim.state()).toMatchObject({ name: WAVE });
    expect(a.anim.state().time).toBeCloseTo(before + 5 * dt, 5);
    expect(skinningMatrices(world, a.node)!.slice()).toEqual(skinningMatrices(world, b.node)!.slice());
    expect(maxDiff(skinningMatrices(world, a.node), Array.from(skinningMatrices(world, c.node)!))).toBeGreaterThan(0.01);
  });

  it("prefer a build's compiled file beside the source over everything else", async () => {
    const asked: CompiledClipRequest[] = [];
    setCompiledClipSource({ compiled: async (r) => (asked.push(r), null) });
    const { node, anim } = await hero();
    await play([anim, BUILT]);
    expect(asked).toEqual([]);
    expect(maxDiff(skinningMatrices(world, node), expected.play)).toBeLessThan(expected.tolerance);
  });

  it("ask for a clip without bone tracks with no skeleton (it binds none)", async () => {
    const asked: CompiledClipRequest[] = [];
    setCompiledClipSource({ compiled: async (r) => (asked.push(r), null) });
    const { anim } = await hero();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await play([anim, LAMP]);
    warn.mockRestore();
    expect(asked).toEqual([{ clip: LAMP, skeleton: null }]);
  });

  it("bind an authored clip again to a skeleton that appears after the Animator played it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await hero();
    const late = GameObject.create("Late");
    made.push(late);
    const anim = late.addComponent(Animator);
    // Played with no skeleton: the raw form binds no bones.
    anim.play(WAVE);
    await vi.waitFor(() => {
      engine.step(0);
      expect(anim.state().name).toBe(WAVE);
    });
    late.addComponent(Skeleton, { skeleton: SKEL });
    await vi.waitFor(() => expect(instanceForSkeleton(world, late)).not.toBe(0));
    await play([a.anim, WAVE], [anim, WAVE]);
    warn.mockRestore();
    expect(skinningMatrices(world, late)!.slice()).toEqual(skinningMatrices(world, a.node)!.slice());
  });

  it("let go of the clips bound to an Animator's earlier skeleton once it binds to a new one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const late = GameObject.create("Rebound");
    made.push(late);
    const anim = late.addComponent(Animator);
    const url = fixtureUrl("walk.anim").href;
    /** The Animator's references to the walk file (one per skeleton it holds the clip for). */
    const held = (): number => {
      const core = animationCoreOf(world)?.core;
      const h = core?.acquireLoaded(url, "clip") ?? 0;
      if (!h) return 0;
      const n = core!.references(h) - 1;
      core!.release(h);
      return n;
    };
    // Played with no skeleton: the Animator holds the file once, for "no bones".
    anim.play(WALK);
    await vi.waitFor(() => {
      engine.step(0);
      expect(held()).toBe(1);
    });
    late.addComponent(Skeleton, { skeleton: SKEL });
    await vi.waitFor(() => expect(instanceForSkeleton(world, late)).not.toBe(0));
    await play([anim, WALK]);
    warn.mockRestore();
    // Held for the Skeleton now; the "no bones" entry went with the rebind (its play ended there).
    expect(held()).toBe(1);
    GameObject.destroy(late);
    engine.step(0);
    expect(held()).toBe(0);
  });
});
