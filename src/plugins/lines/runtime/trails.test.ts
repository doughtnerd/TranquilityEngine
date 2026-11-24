// ADR 0396: a trail's history is game state, sampled by the `lines.Trails` system in every World, so it's read here in a
// headless World through the Component's own interface.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Time } from "../../../myco";
import { TrailRenderer } from "./TrailRenderer";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function headless(): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

describe("trail sampling (ADR 0396)", () => {
  it("adds a point each time the node moves at least minVertexDistance, keeping a live head between", async () => {
    const engine = await headless();
    const node = GameObject.create("bullet");
    const trail = node.addBehavior(TrailRenderer, { lifetime: 10, minVertexDistance: 1 });
    engine.step(0.1);
    expect(trail.positionCount).toBe(1); // the first point, where it started
    node.transform!.position.x = 0.4;
    engine.step(0.1);
    expect(trail.positionCount).toBe(2); // plus the live head
    expect(trail.getPosition(1).x).toBeCloseTo(0.4);
    node.transform!.position.x = 1.2;
    engine.step(0.1);
    expect(trail.positionCount).toBe(2); // a second fixed point, which is also the head
    expect(trail.getPosition(0).x).toBe(0);
    expect(trail.getPosition(1).x).toBeCloseTo(1.2);
  });

  it("ages points by scaled time and drops those older than lifetime; paused time freezes it", async () => {
    const engine = await headless();
    const node = GameObject.create("comet");
    const trail = node.addBehavior(TrailRenderer, { lifetime: 0.5, minVertexDistance: 0.01 });
    for (let i = 0; i < 10; i++) {
      node.transform!.position.x = i;
      engine.step(0.1);
    }
    expect(trail.positionCount).toBeGreaterThanOrEqual(5);
    expect(trail.positionCount).toBeLessThanOrEqual(6);
    expect(trail.getPosition(0).x).toBeGreaterThanOrEqual(4);
    Time.timeScale = 0;
    const before = trail.getAge(0);
    node.transform!.position.x = 50;
    engine.step(0.1);
    expect(trail.getAge(0)).toBe(before);
    Time.timeScale = 1;
  });

  it("stops adding points when not emitting, ages out, and clear() empties it", async () => {
    const engine = await headless();
    const node = GameObject.create("car");
    const trail = node.addBehavior(TrailRenderer, { lifetime: 0.25, minVertexDistance: 0.01 });
    for (let i = 0; i < 3; i++) {
      node.transform!.position.x = i;
      engine.step(0.1);
    }
    trail.emitting = false;
    for (let i = 0; i < 5; i++) {
      node.transform!.position.x = 10 + i;
      engine.step(0.1);
    }
    expect(trail.positionCount).toBe(0);
    trail.emitting = true;
    trail.addPosition([1, 2, 3]);
    expect(trail.getPosition(0).y).toBe(2);
    trail.clear();
    expect(trail.positionCount).toBe(0);
  });

  it("autodestruct destroys the node once its trail has aged out", async () => {
    const engine = await headless();
    const node = GameObject.create("spark");
    node.addBehavior(TrailRenderer, { lifetime: 0.2, autodestruct: true });
    for (let i = 0; i < 10 && node.isValid; i++) engine.step(0.1);
    expect(node.isValid).toBe(false);
  });
});
