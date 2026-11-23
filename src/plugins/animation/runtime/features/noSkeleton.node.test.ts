// ADR 0370, 0371, 0372 (T17b): an Animator with no Skeleton on its node or below gets a zero-bone core instance, so
// property tracks and notifies play without a rig; a Skeleton added later rebinds it. A headless Engine through the
// public API (`myco`); the clips are `props.anim` and `notifies.anim` (see `properties.node.test.ts`).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameBehavior, GameObject, Light, Skeleton, type AnimationEvent } from "../../../../myco";
import { skinningMatrices } from "../skeletonInstances";
import { animatorRuntime } from "./instances";

const fixtureUrl = (name: string) => new URL(`../wasm/fixtures/${name}`, import.meta.url);
const SKEL = "anim/small.skel";
const PROPS = "anim/props.anim";
const NOTIFIES = "anim/notifies.anim";
const dt = 1 / 30;

let engine: Engine;
const steps = (n: number) => {
  for (let i = 0; i < n; i++) engine.step(dt);
};
const heard: string[] = [];

class Probe extends GameBehavior {
  footstep(_e: AnimationEvent) {
    heard.push("footstep");
  }
}

const instanceOf = (anim: Animator) => animatorRuntime(anim)?.instance ?? 0;

function rigless() {
  const node = GameObject.create("Prop");
  const anim = node.addComponent(Animator);
  node.addComponent(Probe);
  const lamp = GameObject.create("Lamp", { parent: node }).addComponent(Light, { type: "point" });
  return { node, anim, lamp };
}

async function start(anim: Animator, clip: string): Promise<void> {
  anim.play(clip);
  await vi.waitFor(() => {
    engine.step(0);
    expect(anim.state().name).toBe(clip);
  });
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      [SKEL]: fixtureUrl("small.skel").href,
      [PROPS]: fixtureUrl("props.anim").href,
      [NOTIFIES]: fixtureUrl("notifies.anim").href,
    }),
  );
  engine = await Engine.create({ headless: true });
});

afterAll(() => engine?.dispose());

describe("Animator without a Skeleton (T17b)", () => {
  it("animates a light's intensity and delivers notifies to a behaviour", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { node, anim, lamp } = rigless();
    await vi.waitFor(() => expect(instanceOf(anim)).not.toBe(0));
    expect(animatorRuntime(anim)!.skeleton).toBeNull();
    expect(skinningMatrices(engine.world, node)).toBeNull();

    await start(anim, PROPS);
    steps(6);
    expect(lamp.intensity).toBeCloseTo(2 * 6 * dt, 3);

    heard.length = 0;
    await start(anim, NOTIFIES);
    steps(9); // footstep at 0.25
    expect(heard).toEqual(["footstep"]);
    warn.mockRestore();
  });

  it("rebinds to a Skeleton added later, and keeps playing when it is removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { node, anim, lamp } = rigless();
    await vi.waitFor(() => expect(instanceOf(anim)).not.toBe(0));
    const before = instanceOf(anim);
    const skeleton = node.addComponent(Skeleton, { skeleton: SKEL });
    await vi.waitFor(() => expect(animatorRuntime(anim)!.skeleton).not.toBeNull());
    expect(instanceOf(anim)).not.toBe(0);
    expect(instanceOf(anim)).not.toBe(before);

    await start(anim, PROPS);
    steps(6);
    expect(lamp.intensity).toBeCloseTo(2 * 6 * dt, 3);
    steps(1);
    expect(skinningMatrices(engine.world, node)).not.toBeNull();

    GameObject.destroy(skeleton);
    await vi.waitFor(() => {
      engine.step(0);
      expect(instanceOf(anim)).not.toBe(0);
      expect(animatorRuntime(anim)!.skeleton).toBeNull();
    });
    await start(anim, PROPS);
    steps(3);
    expect(lamp.intensity).toBeCloseTo(2 * 3 * dt, 3);
    warn.mockRestore();
  });
});
