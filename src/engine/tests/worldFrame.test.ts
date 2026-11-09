import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameBehavior, GameObject } from "../../myco";
import { World } from "../core/World";
import type { RenderSurface } from "../render/RenderSurface";

// ADR 0160: a World runs its own frame in ADR 0011's order, and "inside a frame, at its end; outside,
// now" is one rule on the World. Bare Worlds: no Engine, no renderer.

const log: string[] = [];

class Recorder extends GameBehavior {
  start(): void {
    log.push("start");
  }
  fixedUpdate(): void {
    log.push("fixedUpdate");
  }
  update(): void {
    log.push(`update inFrame=${this.node.world.inFrame}`);
  }
  lateUpdate(): void {
    log.push("lateUpdate");
  }
  onDestroy(): void {
    log.push("onDestroy");
  }
}

/** A surface that records what it's asked, and whether the node's world matrix was propagated by sync. */
function fakeSurface(node: () => GameObject | null): RenderSurface {
  return {
    // Propagated (step 7) before sync: the transform is no longer dirty when the surface reads it.
    sync: (w: World) => log.push(`sync ${w.name} dirty=${(w as unknown as { worldDirty: Uint8Array }).worldDirty[node()!.entity]}`),
    render: (w: World) => log.push(`render ${w.name} active=${World.active === w}`),
  } as unknown as RenderSurface;
}

let world: World;
let previous: World | null;

beforeEach(() => {
  log.length = 0;
  previous = World.active;
  world = new World("runtime", {}, { name: "A", tags: ["client"] });
});

afterEach(() => {
  World.active = previous;
});

function spawn(name = "N"): GameObject {
  return World._runIn(world, () => {
    const node = GameObject.create(name);
    node.addBehavior(Recorder);
    return node;
  });
}

describe("World.step", () => {
  it("runs one frame in ADR 0011 order, with the World current, then restores the current World", () => {
    const node = spawn();
    World._runIn(world, () => (node.transform!.position = [3, 0, 0]));
    const other = new World("runtime", {}, { name: "B", tags: ["client"] });
    World.active = other;
    world.step(1 / 60, { surface: fakeSurface(() => node) });
    expect(log).toEqual(["start", "fixedUpdate", "update inFrame=true", "lateUpdate", "sync A dirty=0", "render A active=true"]);
    expect(World.active).toBe(other);
    expect(world.inFrame).toBe(false);
    expect(world.time.frameCount).toBe(1);
  });

  it("runs fixed steps at the World's own rate, carrying the remainder", () => {
    spawn();
    world.time.fixedDeltaTime = 1 / 30;
    world.step(1 / 60);
    expect(log.filter((l) => l === "fixedUpdate")).toHaveLength(0);
    expect(world.time.fixedAlpha).toBeCloseTo(0.5);
    world.step(1 / 60);
    expect(log.filter((l) => l === "fixedUpdate")).toHaveLength(1);
    expect(world.time.fixedStepCount).toBe(1);
  });

  it("clamps the frame time and stops fixed steps while time is scaled to zero", () => {
    spawn();
    world.step(10);
    expect(world.time.unscaledDeltaTime).toBe(0.25); // maxFrameTime
    expect(world.time.fixedStepCount).toBe(5); // maxSubSteps
    world.time.timeScale = 0;
    log.length = 0;
    world.step(1 / 60);
    expect(log).toEqual(["update inFrame=true", "lateUpdate"]);
    expect(world.time.deltaTime).toBe(0);
  });

  it("reports its phases' timings when asked", () => {
    const timings: number[][] = [];
    world.step(1 / 60, { timings: (...ms) => timings.push(ms) });
    expect(timings).toHaveLength(1);
    expect(timings[0]).toHaveLength(3);
  });

  it("still ends the frame when a phase throws", () => {
    const node = spawn();
    World._runIn(world, () => node.addBehavior(class extends GameBehavior {
      update(): void {
        throw new Error("boom");
      }
    }));
    let ran = false;
    const surface = { sync: () => { throw new Error("sync failed"); }, render: () => {} } as unknown as RenderSurface;
    world.step(1 / 60); // starts behaviors; a script's error is caught and logged by the World
    expect(() => world.step(1 / 60, { surface })).toThrow("sync failed");
    world.atFrameEnd(() => (ran = true));
    expect(ran).toBe(true); // not in a frame any more: runs now
    expect(world.inFrame).toBe(false);
  });
});

describe("the end-of-frame rule (atFrameEnd, applyDestroys)", () => {
  it("runs work now, with the World current, outside a frame", () => {
    let current: World | null = null;
    world.atFrameEnd(() => (current = World.active));
    expect(current).toBe(world);
  });

  it("defers work queued inside a frame to its end, after deferred destroys", () => {
    const node = spawn();
    world.step(1 / 60);
    log.length = 0;
    const doomed = spawn("Doomed");
    world.step(1 / 60); // its start
    log.length = 0;
    World._runIn(world, () =>
      node.addBehavior(class extends GameBehavior {
        update(): void {
          GameObject.destroy(doomed);
          this.node.world.applyDestroys(); // inside a frame: waits for step 10
          log.push(`after applyDestroys valid=${doomed.isValid}`);
          this.node.world.atFrameEnd(() => log.push(`frame end inFrame=${world.inFrame} valid=${doomed.isValid}`));
        }
      }),
    );
    world.step(1 / 60); // the new behavior starts
    world.step(1 / 60);
    expect(log).toContain("after applyDestroys valid=true");
    expect(log.indexOf("onDestroy")).toBeLessThan(log.indexOf("frame end inFrame=false valid=false"));
  });

  it("applies destroys at once outside a frame", () => {
    const node = spawn();
    world.step(1 / 60);
    World._runIn(world, () => GameObject.destroy(node));
    expect(node.isValid).toBe(true);
    world.applyDestroys();
    expect(node.isValid).toBe(false);
    expect(log).toContain("onDestroy");
  });
});

describe("World.redraw and advanceClock", () => {
  it("redraws without stepping: transforms propagated, synced and rendered with the World current", () => {
    const node = spawn();
    World._runIn(world, () => (node.transform!.position = [5, 0, 0]));
    world.redraw(fakeSurface(() => node));
    expect(log).toEqual(["sync A dirty=0", "render A active=true"]);
    expect(world.time.frameCount).toBe(0);
  });

  it("advances the clock alone", () => {
    spawn();
    world.advanceClock(0.1);
    expect(world.time).toMatchObject({ deltaTime: 0.1, unscaledDeltaTime: 0.1, frameCount: 1 });
    expect(world.time.time).toBeCloseTo(0.1);
    expect(log).toEqual([]);
    world.advanceClock(0);
    expect(world.time.deltaTime).toBe(0);
  });
});
