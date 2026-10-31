import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Time, Vector3 } from "../index";

const log: string[] = [];

class Logger extends GameBehavior {
  label = "";
  awake() { log.push(`${this.label}:awake`); }
  onEnable() { log.push(`${this.label}:onEnable`); }
  start() { log.push(`${this.label}:start`); }
  fixedUpdate() { log.push(`${this.label}:fixedUpdate`); }
  update() { log.push(`${this.label}:update`); }
  lateUpdate() { log.push(`${this.label}:lateUpdate`); }
  onDisable() { log.push(`${this.label}:onDisable`); }
  onDestroy() { log.push(`${this.label}:onDestroy`); }
}

class Waiter extends GameBehavior {
  done = false;
  async start() {
    await this.wait.seconds(0.5);
    this.done = true;
  }
}

let engine: Engine;
const frame = 1 / 60;

beforeEach(async () => {
  log.length = 0;
  engine = await Engine.create({ headless: true });
});

describe("lifecycle (ADR 0007, 0011)", () => {
  it("runs hooks in Unity order across the first frame", () => {
    const node = GameObject.create("A");
    node.addBehavior(Logger, { label: "a" });
    expect(log).toEqual(["a:awake", "a:onEnable"]); // immediately on add
    engine.step(frame);
    expect(log).toEqual(["a:awake", "a:onEnable", "a:start", "a:fixedUpdate", "a:update", "a:lateUpdate"]);
  });

  it("defers awake until the node is first active", () => {
    const node = GameObject.create("A");
    node.setActive(false);
    node.addBehavior(Logger, { label: "a" });
    expect(log).toEqual([]);
    node.setActive(true);
    expect(log).toEqual(["a:awake", "a:onEnable"]);
  });

  it("disables a subtree when an ancestor is deactivated", () => {
    const parent = GameObject.create("P");
    const child = GameObject.create("C", { parent });
    const b = child.addBehavior(Logger, { label: "c" });
    parent.setActive(false);
    expect(child.activeInHierarchy).toBe(false);
    expect(b.isActiveAndEnabled).toBe(false);
    expect(log).toContain("c:onDisable");
  });

  it("destroys at the end of the frame, children first, onDisable before onDestroy", () => {
    const parent = GameObject.create("P");
    parent.addBehavior(Logger, { label: "p" });
    const child = GameObject.create("C", { parent });
    child.addBehavior(Logger, { label: "c" });
    engine.step(frame);
    log.length = 0;
    GameObject.destroy(parent);
    expect(parent.isValid).toBe(true); // still readable this frame
    engine.step(frame);
    expect(parent.isValid).toBe(false);
    expect(child.isValid).toBe(false);
    const tail = log.slice(log.indexOf("c:onDisable"));
    expect(tail).toEqual(["c:onDisable", "c:onDestroy", "p:onDisable", "p:onDestroy"]);
  });

  it("runs parents before children within a hook", () => {
    const parent = GameObject.create("P");
    const child = GameObject.create("C", { parent });
    child.addBehavior(Logger, { label: "c" });
    parent.addBehavior(Logger, { label: "p" });
    engine.step(frame);
    const updates = log.filter((l) => l.endsWith(":update"));
    expect(updates).toEqual(["p:update", "c:update"]);
  });

  it("resolves waits on game time and drops them when disabled", async () => {
    const w1 = GameObject.create("W1").addBehavior(Waiter);
    const w2 = GameObject.create("W2").addBehavior(Waiter);
    engine.step(frame); // start() runs, waits are registered
    w2.enabled = false;
    for (let i = 0; i < 40; i++) engine.step(frame);
    await Promise.resolve();
    expect(Time.time).toBeGreaterThan(0.5);
    expect(w1.done).toBe(true);
    expect(w2.done).toBe(false);
  });
});

describe("transforms (ADR 0010, 0019)", () => {
  it("exposes live local vectors and computed world positions", () => {
    const parent = GameObject.create("P");
    const child = GameObject.create("C", { parent });
    parent.transform!.position.x = 5;
    child.transform!.position.set(1, 2, 0);
    expect(child.transform!.worldPosition.toArray()).toEqual([6, 2, 0]);

    parent.transform!.rotation2D = 90;
    const wp = child.transform!.worldPosition;
    expect(wp.x).toBeCloseTo(3);
    expect(wp.y).toBeCloseTo(1);

    const snapshot = child.transform!.position.clone();
    child.transform!.position.x = 10;
    expect(snapshot.x).toBe(1);
  });

  it("keeps the world transform when reparenting", () => {
    const a = GameObject.create("A");
    a.transform!.position = new Vector3(3, 0, 0);
    const b = GameObject.create("B");
    b.transform!.position = new Vector3(10, 4, 0);
    b.setParent(a);
    expect(b.transform!.worldPosition.toArray().map((v) => Math.round(v * 1e4) / 1e4)).toEqual([10, 4, 0]);
    expect(b.transform!.position.x).toBeCloseTo(7);
  });

  it("survives storage growth (views are re-pointed)", () => {
    const first = GameObject.create("first");
    const pos = first.transform!.position;
    for (let i = 0; i < 600; i++) GameObject.create(`n${i}`);
    pos.x = 42;
    expect(first.transform!.worldPosition.x).toBe(42);
  });
});
