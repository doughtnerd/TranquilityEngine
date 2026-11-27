// ADR 0435: the engine says which game code is running (the behaviour and hook a World calls, the defined system its
// scheduler runs), so a service a script calls can name who asked; outside any hook it says nothing.
import { afterEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, defineSystem } from "../index";
import { _undefineSystem } from "../core/systems";
import { runningScript, type RunningScript } from "../core/runningScript";

const SYSTEM = "test.runningScript.probe";
const seen: { label: string; at: RunningScript | null }[] = [];
const engines: Engine[] = [];

afterEach(() => {
  _undefineSystem(SYSTEM);
  for (const e of engines.splice(0)) e.dispose();
  seen.length = 0;
});

class Inner extends GameBehavior {
  onEnable(): void {
    seen.push({ label: "inner", at: runningScript() });
  }
}

class Outer extends GameBehavior {
  private added = false;
  update(): void {
    seen.push({ label: "outer", at: runningScript() });
    if (this.added) return;
    this.added = true;
    this.node.addBehavior(Inner);
    seen.push({ label: "outer after", at: runningScript() });
  }
}

const describeAt = (at: RunningScript | null) => (at ? { behaviour: at.behaviour?.constructor.name ?? null, hook: at.hook, system: at.system } : null);

describe("runningScript (ADR 0435)", () => {
  it("names the behaviour and hook a World is calling, a nested hook while it runs, and the outer one again after", async () => {
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    GameObject.create("Player").addBehavior(Outer);
    engine.step(1 / 60);
    expect(seen.map((s) => [s.label, describeAt(s.at)])).toEqual([
      ["outer", { behaviour: "Outer", hook: "update", system: null }],
      ["inner", { behaviour: "Inner", hook: "onEnable", system: null }],
      ["outer after", { behaviour: "Outer", hook: "update", system: null }],
    ]);
    expect(runningScript()).toBeNull();
  });

  it("names the defined system its scheduler is running, and nothing once it returns", async () => {
    defineSystem({ name: SYSTEM, phase: "update", run: () => void seen.push({ label: "system", at: runningScript() }) });
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    engine.step(1 / 60);
    expect(describeAt(seen[0]!.at)).toEqual({ behaviour: null, hook: null, system: SYSTEM });
    expect(runningScript()).toBeNull();
  });

  it("is restored when a hook throws", async () => {
    class Thrower extends GameBehavior {
      update(): void {
        throw new Error("boom");
      }
    }
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    const error = console.error;
    console.error = () => {};
    try {
      GameObject.create("Bad").addBehavior(Thrower);
      engine.step(1 / 60);
    } finally {
      console.error = error;
    }
    expect(runningScript()).toBeNull();
  });
});
