import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionEvents,
  Assets,
  Engine,
  GameObject,
  Input,
  InputContext,
  InputPlayers,
  button,
  defineActions,
  defineInputContext,
  defineSystem,
  defineTrigger,
  type ActionEvent,
  type AssetSource,
  type TriggerSpec,
} from "../index";

// ADR 0336, 0337: chords and combos in dependency order, repeat rate, custom triggers, and
// rebinding conflicts across every known context, through Input.inject and the public API.

// Dependent actions are declared before the actions they read, so set order alone would be late.
defineActions("test.inputEvaluation.Actions", {
  fire: button({ control: "<Keyboard>/f", triggers: [{ chord: { action: "mod" } }] }),
  special: button({ control: "<Keyboard>/9", triggers: [{ combo: { steps: [{ action: "one" }, { action: "two" }] } }] }),
  mod: button("<Keyboard>/shift"),
  one: button("<Keyboard>/1"),
  two: button("<Keyboard>/2"),
  jump: button("<Keyboard>/space"),
  bomb: button("<Keyboard>/b"),
  menuDown: button("<Keyboard>/arrowdown"),
  // A custom trigger defined after the set: bindings compile when used.
  charge: button({ control: "<Keyboard>/c", triggers: [{ "test.everyThird": {} } as TriggerSpec] }),
  aim: button({ control: "<Keyboard>/v", triggers: [{ "test.whileMod": {} } as TriggerSpec] }),
  honk: button(),
  cx: button(),
  cy: button(),
});

// Every third actuated frame triggers.
defineTrigger("test.everyThird", () => {
  let frames = 0;
  return {
    update(actuated) {
      frames = actuated ? frames + 1 : 0;
      return frames > 0 && frames % 3 === 0 ? 2 : actuated ? 1 : 0;
    },
  };
});
// Triggered while actuated and "mod" is triggered this frame: a custom trigger's reads are resolved first.
defineTrigger("test.whileMod", () => ({ reads: ["mod"], update: (actuated, _dt, others) => actuated && others.triggered("mod") }));

defineInputContext({ name: "test.inputEvaluation.car", mappings: [{ action: "honk", control: "<Keyboard>/k" }] });
defineInputContext({
  name: "test.inputEvaluation.cycle",
  mappings: [
    { action: "cx", control: "<Keyboard>/x", triggers: [{ chord: { action: "cy" } }] },
    { action: "cy", control: "<Keyboard>/y", triggers: [{ chord: { action: "cx" } }] },
  ],
});
defineInputContext({ name: "test.inputEvaluation.custom", mappings: [{ action: "honk", control: "<Keyboard>/h", triggers: [{ "test.everyThird": {} } as TriggerSpec] }] });
defineInputContext({ name: "test.inputEvaluation.unknown", mappings: [{ action: "honk", control: "<Keyboard>/u", triggers: [{ "test.missing": {} } as TriggerSpec] }] });

const DT = 1 / 60;
let engine: Engine;
const sources: AssetSource[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  engine.step(DT);
  Input.inject.releaseAll();
  engine.dispose();
  for (const s of sources.splice(0)) Assets.removeSource(s);
  vi.restoreAllMocks();
});

const p0 = () => InputPlayers.get(0)!;
const step = (frames = 1, dt = DT) => {
  for (let i = 0; i < frames; i++) engine.step(dt);
};
const performedLog = (action: string): number[] => {
  const frames: number[] = [];
  let frame = 0;
  defineSystem({
    name: `test.inputEvaluation.log.${action}.${Math.random()}`,
    phase: "update",
    run: () => {
      frame++;
      for (const e of ActionEvents.read()) if (e.action === action && e.phase === "performed") frames.push(frame);
    },
  });
  return frames;
};

describe("dependency order (ADR 0336)", () => {
  it("lets a chord see the action it needs in the same frame", () => {
    step();
    Input.inject.keyDown("shift");
    Input.inject.keyDown("f");
    step();
    expect(p0().performed("fire")).toBe(true);
    Input.inject.keyUp("shift");
    step();
    expect(p0().completed("fire")).toBe(true);
    expect(p0().triggered("fire")).toBe(false); // F is still held, but the chord is gone
  });

  it("completes a combo in the frame its last step performs", () => {
    step();
    Input.inject.keyDown("1");
    step();
    expect(p0().ongoing("special")).toBe(true);
    Input.inject.keyUp("1");
    Input.inject.keyDown("2");
    step();
    expect(p0().performed("two")).toBe(true);
    expect(p0().performed("special")).toBe(true);
  });

  it("reports actions that read each other in a cycle, and keeps evaluating", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = GameObject.create("Cycle");
    node.addBehavior(InputContext, { context: "test.inputEvaluation.cycle", priority: 5 });
    step();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("cycle (cx → cy → cx)"))).toBe(true);
    Input.inject.keyDown("space");
    step();
    expect(p0().performed("jump")).toBe(true);
  });
});

describe("repeat rate (accessibility, ADR 0337)", () => {
  it("performs a held button again after the delay, then every interval", () => {
    const frames = performedLog("menuDown");
    const bombs = performedLog("bomb");
    step();
    p0().accessibility = { repeat: { delay: 0.5, interval: 0.1, actions: ["menuDown"] } };
    Input.inject.keyDown("arrowdown");
    Input.inject.keyDown("b");
    step(15, 0.05); // pressed at frame 2; 0.5 s later (frame 12), then every 0.1 s (14, 16)
    expect(frames).toEqual([2, 12, 14, 16]);
    expect(bombs).toEqual([2]); // not listed: no repeat
    Input.inject.keyUp("arrowdown");
    step(4, 0.05);
    expect(frames.length).toBe(4);
  });

  it("repeats every button action when no actions are listed, and refuses a bad interval", () => {
    const frames = performedLog("jump");
    step();
    expect(() => (p0().accessibility = { repeat: { delay: 0.1, interval: 0 } })).toThrow(/repeat\.interval/);
    p0().accessibility = { repeat: { delay: 0.1, interval: 0.1 } };
    Input.inject.keyDown("space");
    step(5, 0.05);
    expect(frames).toEqual([2, 4, 6]);
  });
});

describe("custom triggers (defineTrigger)", () => {
  it("runs a trigger defined by the game, from an inline mapping and from a context", () => {
    const charges = performedLog("charge");
    const honks = performedLog("honk");
    const node = GameObject.create("Custom");
    node.addBehavior(InputContext, { context: "test.inputEvaluation.custom", priority: 5 });
    Input.inject.keyDown("c");
    Input.inject.keyDown("h");
    step(7);
    expect(charges).toEqual([3, 6]);
    expect(honks).toEqual([3, 6]);
  });

  it("resolves the actions a custom trigger reads first", () => {
    step();
    Input.inject.keyDown("shift");
    Input.inject.keyDown("v");
    step();
    expect(p0().performed("aim")).toBe(true);
  });

  it("validates names and explains an unknown trigger", () => {
    expect(() => defineTrigger("doubleHold", () => ({ update: () => 0 }))).toThrow(/namespaced/);
    expect(() => defineTrigger("game.bad", null as never)).toThrow(/function/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = GameObject.create("Unknown");
    node.addBehavior(InputContext, { context: "test.inputEvaluation.unknown", priority: 5 });
    step();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Unknown trigger "test.missing"') && m.includes("defineTrigger"))).toBe(true);
  });
});

describe("rebinding conflicts (ADR 0337)", () => {
  it("reports conflicts in every context the player could have, active or not", async () => {
    const boat = Assets.fromObject({ "test/boat.input.json": { name: "boat", mappings: [{ action: "bomb", control: "<Keyboard>/k" }] } });
    Assets.addSource(boat);
    sources.push(boat);
    const dock = GameObject.create("Dock");
    dock.addBehavior(InputContext, { context: "test/boat.input.json", priority: 5 });
    dock.setActive(false);
    step();
    const result = p0().rebind("jump", { device: "keyboard" });
    Input.inject.keyDown("k");
    step();
    const r = await result;
    expect(r.control).toBe("<Keyboard>/k");
    // Neither the registered car context nor the boat asset is active now.
    expect(r.conflicts).toEqual(expect.arrayContaining(["test.inputEvaluation.car: honk", "boat: bomb"]));
    expect(r.conflicts.some((c) => c.endsWith(": jump"))).toBe(false);
  });
});

it("tags local events with the player's node and index", () => {
  const seen: ActionEvent[] = [];
  defineSystem({ name: "test.inputEvaluation.events", phase: "update", run: () => { for (const e of ActionEvents.read()) if (e.action === "jump") seen.push(e); } });
  step();
  Input.inject.keyDown("space");
  step();
  expect(seen[0].node).toBe(p0().player);
  expect(seen[0].player).toBe(p0().player);
  expect(seen[0].index).toBe(0);
});
