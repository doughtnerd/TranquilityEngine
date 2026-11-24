// ADR 0371, 0372 (T22t): a stopped tween group forgets only its own program. A headless Engine through the public API
// (`myco`), alone in its file: host ids count up page-wide from 1 and a fresh core's first timeline handle is small, so
// the ids can be counted up to that handle quickly (see `tweens.node.test.ts` for the rest of tweens and groups).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { animationCoreOf } from "../core/service";
import { Engine, GameObject, Light, parallel, sequence, tween } from "../../../../myco";

let engine: Engine;
const steps = (n: number, dt: number) => {
  for (let i = 0; i < n; i++) engine.step(dt);
};
const lamp = (name: string): Light => GameObject.create(name).addComponent(Light, { type: "point" });

beforeAll(async () => {
  engine = await Engine.create({ headless: true });
  // The first tween starts the World's core (loaded lazily); wait for it once.
  const t = tween(lamp("Warmup"), "intensity", 2, { duration: 0 });
  await vi.waitFor(() => {
    engine.step(0);
    expect(t.isPlaying).toBe(false);
  });
});

afterAll(() => engine?.dispose());

describe("a stopped group", () => {
  it("leaves the other groups running, whatever ids they have", { timeout: 20_000 }, async () => {
    // A group's run is kept by its host id, its core timeline by a handle; both are numbers. A stopped group once
    // forgot the run keyed by its *handle*, so a group whose host id equalled that handle stopped writing and never
    // resolved. Burn host ids until the next group's id is the stopped group's handle.
    const core = animationCoreOf(engine.world)!.core;
    const a = lamp("A"), b = lamp("B"), burn = lamp("Burn");
    const stopped = sequence(tween(a, "intensity", 5, { duration: 10, from: 0 }));
    const probe = tween(a, "range", 5, { duration: 10, from: 0 });
    engine.step(0);
    const active = [...core.timelineActive()];
    expect(active).toHaveLength(1);
    const handle = active[0]!;
    const rows = core.tweenRows();
    expect(rows.count).toBe(1);
    const next = rows.columns[0]! + 1; // the probe's host id (= its column) was the last one given
    probe.stop();
    expect(next).toBeLessThan(handle);
    // `parallel` of k members takes k + 1 ids (the group's, then each member's); a lone tween takes one.
    let left = handle - next;
    while (left > 0) {
      if (left === 1) {
        tween(burn, "intensity", 1, { duration: 0 });
        left = 0;
      } else {
        const k = Math.min(4096, left - 1);
        parallel(...Array.from({ length: k }, () => tween(burn, "intensity", 1, { duration: 0 })));
        left -= k + 1;
      }
    }
    b.intensity = 0;
    const running = sequence(tween(b, "intensity", 10, { duration: 1, ease: "linear" }));
    engine.step(0); // the burners and `running` start: `running` gets the id `handle`
    stopped.stop();
    steps(2, 0.25);
    expect(b.intensity).toBeCloseTo(5, 5);
    steps(3, 0.25);
    await expect(running).resolves.toEqual({ reason: "finished" });
    await expect(stopped).resolves.toEqual({ reason: "stopped" });
  });
});
