import { describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Transform, defineBuffer, defineComponent, defineSystem, f32 } from "../index";

const Velocity = defineComponent("test.Velocity", { x: f32, y: f32, z: f32 });
const Hits = defineBuffer<{ who: string }>("test.Hits");

defineSystem({
  name: "test.Move",
  phase: "update",
  query: [Transform, Velocity],
  run(rows, ctx) {
    for (const r of rows) r.transform.position.addScaled(r.velocity as { x: number; y: number; z: number }, ctx.dt);
  },
});

defineSystem({
  name: "test.First",
  phase: "update",
  before: ["engine.UpdateScripts"],
  run() {
    order.push("system:first");
  },
});

const order: string[] = [];
const seen: string[] = [];

class Pusher extends GameBehavior {
  update() {
    order.push("script:update");
    Hits.push({ who: this.node.name });
  }
}

class Reader extends GameBehavior {
  lateUpdate() {
    for (const h of Hits.read()) seen.push(h.who);
  }
}

describe("user systems and data (ADR 0017)", () => {
  it("moves data-component rows and honors before/after", async () => {
    const engine = await Engine.create({ headless: true });
    const a = GameObject.create("a");
    a.addData(Velocity, { x: 60 });
    const inactive = GameObject.create("b");
    inactive.addData(Velocity, { x: 60 });
    inactive.setActive(false);
    a.addBehavior(Pusher);
    engine.step(1 / 60);
    expect(a.transform!.position.x).toBeCloseTo(1);
    expect(inactive.transform!.position.x).toBe(0);
    expect(order.slice(0, 2)).toEqual(["system:first", "script:update"]);
    expect(engine.world.scheduler.order("update")).toEqual(["engine.NetReceive", "engine.ReplicationReceive", "engine.ReplicationInterpolate", "test.First", "engine.UpdateScripts", "test.Move"]);
  });

  it("buffers are readable the same frame and cleared at the end of it", async () => {
    seen.length = 0;
    const engine = await Engine.create({ headless: true });
    GameObject.create("pusher").addBehavior(Pusher);
    GameObject.create("reader").addBehavior(Reader);
    engine.step(1 / 60);
    engine.step(1 / 60);
    expect(seen).toEqual(["pusher", "pusher"]);
    expect(Hits.read()).toHaveLength(0);
  });
});
