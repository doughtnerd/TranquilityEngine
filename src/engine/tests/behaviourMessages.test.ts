import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, BoxCollider2D, CircleCollider2D, Engine, GameBehavior, GameObject, RigidBody2D, SceneManager, type Collision2D, type Component } from "../../myco";

// ADR 0303: the World delivers behaviour messages (physics hooks) with lifecycle hooks' rules.

class RejectingProbe extends GameBehavior {
  async onCollisionEnter(_c: Collision2D): Promise<void> {
    await Promise.resolve();
    throw new Error("async boom");
  }
}

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
  Assets.clearSources();
});

async function physics2D(): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10] as [number, number] } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("behaviour messages from physics (ADR 0303)", () => {
  it("logs an async onCollisionEnter that rejects, with the behaviour's name", async () => {
    const engine = await physics2D();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -2;
    floor.addBehavior(BoxCollider2D).size.set(10, 1);
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D);
    ball.addBehavior(CircleCollider2D, { radius: 0.5 });
    ball.addBehavior(RejectingProbe);
    for (let i = 0; i < 90; i++) engine.step(1 / 60);
    await flush();
    const messages = error.mock.calls.map((c) => String(c[0]));
    expect(messages).toContain("[myco] RejectingProbe.onCollisionEnter rejected:");
  });
});

const heard: string[] = [];

class Listener extends GameBehavior {
  label = "";
  onTriggerEnter(other: Component) { heard.push(`${this.label}:${other.node.name}`); }
}

class Thrower extends GameBehavior {
  onTriggerEnter(_other: Component) { throw new Error("sync boom"); }
}

class Rejecter extends GameBehavior {
  async onTriggerEnter(_other: Component) {
    await Promise.resolve();
    throw new Error("async boom");
  }
}

describe("World._sendMessage (ADR 0303)", () => {
  async function world() {
    heard.length = 0;
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    return engine.world;
  }

  it("calls the hook on each active behaviour that defines it, with the sender's argument", async () => {
    const w = await world();
    const a = GameObject.create("a"), b = GameObject.create("b");
    a.addBehavior(Listener, { label: "a1" });
    a.addBehavior(Listener, { label: "a2" });
    b.addBehavior(Listener, { label: "b" });
    const other = GameObject.create("other").addBehavior(Listener, { label: "o" });
    w._sendMessage([a, b], "onTriggerEnter", other);
    expect(heard).toEqual(["a1:other", "a2:other", "b:other"]);
  });

  it("delivers to each node once when the sender names it twice", async () => {
    const w = await world();
    const a = GameObject.create("a");
    a.addBehavior(Listener, { label: "a" });
    w._sendMessage([a, a, a], "onTriggerEnter", a.getBehavior(Listener)!);
    expect(heard).toEqual(["a:a"]);
  });

  it("skips disabled behaviours, inactive nodes, destroyed nodes and scenes being edited", async () => {
    const w = await world();
    const off = GameObject.create("off");
    off.addBehavior(Listener, { label: "disabled" }).enabled = false;
    const inactive = GameObject.create("inactive");
    inactive.addBehavior(Listener, { label: "inactive" });
    inactive.setActive(false);
    const gone = GameObject.create("gone");
    gone.addBehavior(Listener, { label: "gone" });
    GameObject.destroy(gone);
    engines[engines.length - 1].step(1 / 60); // destroyed at the end of the frame
    const edited = GameObject.create("edited");
    edited.addBehavior(Listener, { label: "edited" });
    w.setEditMode(edited.entity, true);
    const live = GameObject.create("live");
    const arg = live.addBehavior(Listener, { label: "live" });
    w._sendMessage([off, inactive, gone, edited, live], "onTriggerEnter", arg);
    expect(heard).toEqual(["live:live"]);
  });

  it("logs a hook that throws with the behaviour's name and keeps delivering", async () => {
    const w = await world();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = GameObject.create("a");
    a.addBehavior(Thrower);
    const after = a.addBehavior(Listener, { label: "after" });
    w._sendMessage([a], "onTriggerEnter", after);
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(["[myco] Thrower.onTriggerEnter threw:"]);
    expect(heard).toEqual(["after:a"]);
  });

  it("logs a hook whose Promise rejects with the behaviour's name", async () => {
    const w = await world();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = GameObject.create("a");
    const r = a.addBehavior(Rejecter);
    w._sendMessage([a], "onTriggerEnter", r);
    await flush();
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(["[myco] Rejecter.onTriggerEnter rejected:"]);
  });
});
