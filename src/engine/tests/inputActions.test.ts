import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActionEvents,
  ControlledBy,
  DeviceEvents,
  Engine,
  GameBehavior,
  GameObject,
  GamepadState,
  Input,
  InputContext,
  InputDevice,
  InputPlayers,
  PlayerJoined,
  axis,
  axisOf,
  button,
  chordOf,
  defineActions,
  defineInputContext,
  defineSystem,
  dpad,
  vec2,
  type ActionEvent,
} from "../index";

// ADR 0335–0337: devices as entities, actions and contexts, players — driven through Input.inject,
// the input end real adapters use, and read through actions, players, pawns and behaviors.

const Player = defineActions("test.inputActions.Player", {
  move: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStick"),
  jump: button("<Keyboard>/space", "<Gamepad>/buttonSouth"),
  heavy: button({ control: "<Keyboard>/h", triggers: [{ hold: { min: 0.4 } }] }),
  dash: button(chordOf("<Keyboard>/shift", "<Keyboard>/b")),
  bomb: button("<Keyboard>/b"),
  steer: axis(axisOf("<Keyboard>/arrowleft", "<Keyboard>/arrowright")),
  look: vec2("<Pointer>/delta"),
  honk: button(),
});

defineInputContext({ name: "test.vehicle", mappings: [{ action: "honk", control: "<Keyboard>/space" }] });

const DT = 1 / 60;
let engine: Engine;
let padIds: number[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  for (const id of padIds) Input.inject.gamepadDisconnected(id);
  padIds = [];
  engine.step(DT);
  Input.inject.releaseAll();
  engine.dispose();
});

const p0 = () => InputPlayers.get(0)!;
const step = (frames = 1, dt = DT) => {
  for (let i = 0; i < frames; i++) engine.step(dt);
};
const pad = (id: number, family: "xbox" | "playstation" = "xbox") => {
  padIds.push(id);
  Input.inject.gamepadConnected({ id, name: `Pad ${id}`, family });
};

describe("devices as entities (ADR 0335)", () => {
  it("mirrors the keyboard, pointer and gamepads as device nodes, and this frame's presses as DeviceEvents", () => {
    const events: [string, string][] = [];
    defineSystem({ name: "test.inputActions.devices", phase: "update", run: () => { for (const e of DeviceEvents.read()) events.push([e.device.name, e.control]); } });
    Input.inject.keyDown("q");
    pad(7);
    step();
    const input = engine.world.root.find("Input")!;
    const names = input.children.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Keyboard", "Pointer", "Pad 7", "Player 0"]));
    const padNode = input.find("Pad 7")!;
    expect(padNode.getData(InputDevice)!.slot).toBe(0);
    expect(events.splice(0)).toEqual([["Keyboard", "<Keyboard>/q"]]);

    Input.inject.gamepadButton(7, 0, 1);
    Input.inject.gamepadAxis(7, 0, 0.75);
    step();
    const state = padNode.getData(GamepadState)!;
    expect(state.b0).toBe(1);
    expect(state.a0).toBeCloseTo(0.75);
    expect(state.down & 1).toBe(1);
    expect(events.splice(0)).toEqual([
      ["Pad 7", "<Gamepad>/buttonSouth"],
      ["Pad 7", "<Gamepad>/leftStickX"],
    ]);

    Input.inject.gamepadDisconnected(7);
    padIds = [];
    step();
    expect(padNode.getData(InputDevice)!.connected).toBe(0); // gone next frame
    step();
    expect(padNode.isValid).toBe(false);
  });

  it("gives a World that doesn't take input no devices and no actions", async () => {
    const other = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Quiet", input: false }] } });
    try {
      Input.inject.keyDown("space");
      other.step(DT);
      expect(other.world.root.find("Input/Keyboard")).toBeNull();
    } finally {
      other.dispose();
    }
  });
});

describe("actions and the default context (ADR 0336)", () => {
  it("presses, holds and releases a button, with phases and ActionEvents", () => {
    const phases: string[] = [];
    defineSystem({ name: "test.inputActions.events", phase: "update", run: () => { for (const e of ActionEvents.read()) if (e.action === "jump") phases.push(e.phase); } });
    step();
    Input.inject.keyDown("space");
    step();
    expect(p0().performed("jump")).toBe(true);
    expect(p0().pressed("jump")).toBe(true);
    expect(p0().held("jump")).toBe(true);
    expect(phases.splice(0)).toEqual(["started", "performed"]);
    step();
    expect(p0().performed("jump")).toBe(false);
    expect(p0().triggered("jump")).toBe(true);
    expect(p0().elapsed("jump")).toBeCloseTo(2 * DT);
    Input.inject.keyUp("space");
    step();
    expect(p0().released("jump")).toBe(true);
    expect(p0().completed("jump")).toBe(true);
    expect(p0().held("jump")).toBe(false);
    expect(phases).toEqual(["completed"]);
  });

  it("reads WASD as a vector, a stick with its dead zone and +Y up, and pointer delta", () => {
    Input.inject.keyDown("w");
    Input.inject.keyDown("d");
    step();
    expect(p0().vector2("move").toArray()).toEqual([1, 1]);
    Input.inject.keyUp("w");
    Input.inject.keyUp("d");
    pad(3);
    Input.inject.gamepadAxis(3, 1, 0.1); // inside the stick's dead zone
    step();
    expect(p0().vector2("move").toArray()).toEqual([0, 0]);
    Input.inject.gamepadAxis(3, 1, -1); // stick fully up (the wire's -Y)
    step();
    expect(p0().vector2("move").y).toBeCloseTo(1);
    Input.inject.move(10, 4);
    step();
    expect(p0().vector2("look").toArray()).toEqual([10, -4]);
  });

  it("composes an axis from two keys", () => {
    Input.inject.keyDown("arrowleft");
    step();
    expect(p0().value("steer")).toBe(-1);
  });

  it("triggers a hold after its time, reporting progress", () => {
    Input.inject.keyDown("h");
    step();
    expect(p0().ongoing("heavy")).toBe(true);
    expect(p0().performed("heavy")).toBe(false);
    step(22); // 23 frames: 0.383 s
    expect(p0().performed("heavy")).toBe(false);
    step(); // 24 frames: 0.4 s
    expect(p0().performed("heavy")).toBe(true);
    expect(p0().elapsed("heavy")).toBeCloseTo(24 * DT);
  });

  it("lets a chord shadow its main key within a context (Shift+B is not B)", () => {
    Input.inject.keyDown("shift");
    Input.inject.keyDown("b");
    step();
    expect(p0().performed("dash")).toBe(true);
    expect(p0().held("bomb")).toBe(false);
    Input.inject.keyUp("shift");
    Input.inject.keyUp("b");
    step();
    Input.inject.keyDown("b");
    step();
    expect(p0().performed("bomb")).toBe(true);
  });

  it("gives a fixed step a press that happened in a frame without one, exactly once", () => {
    const seen: boolean[] = [];
    defineSystem({ name: "test.inputActions.tick", phase: "fixedUpdate", query: [Player], run: (rows) => { for (const r of rows) seen.push((r as unknown as { player: { performed(a: string): boolean } }).player.performed("jump")); } });
    step(1, DT / 4); // no fixed step
    Input.inject.keyDown("space");
    step(1, DT / 4); // the press, still no fixed step
    Input.inject.keyUp("space");
    step(1, DT / 4);
    expect(seen).toEqual([]);
    step(1, DT); // a fixed step: it sees the press
    step(1, DT);
    expect(seen.filter(Boolean).length).toBe(1);
  });
});

describe("contexts on nodes (ADR 0336)", () => {
  it("takes a control for a higher-priority context while its node is active", () => {
    const car = GameObject.create("Car");
    car.addBehavior(InputContext, { context: "test.vehicle", priority: 10 });
    step();
    Input.inject.keyDown("space");
    step();
    expect(p0().performed("honk")).toBe(true);
    expect(p0().held("jump")).toBe(false); // consumed by the vehicle context
    Input.inject.keyUp("space");
    car.setActive(false);
    step();
    Input.inject.keyDown("space");
    step();
    expect(p0().performed("jump")).toBe(true);
    expect(p0().held("honk")).toBe(false);
  });
});

describe("players and pawns (ADR 0337)", () => {
  it("copies a player's actions onto its pawns for systems and behaviors", () => {
    const log: string[] = [];
    class Jumper extends GameBehavior {
      onEnable() {
        this.input.on("jump", "performed", (e: ActionEvent) => log.push(`${e.action}:${e.phase}`));
      }
      update() {
        if (this.input.performed("jump")) log.push("polled");
      }
    }
    const pawn = GameObject.create("Hero");
    pawn.addData(ControlledBy, { player: 0 });
    const child = GameObject.create("Body", { parent: pawn });
    const jumper = child.addBehavior(Jumper);
    step();
    Input.inject.keyDown("space");
    step();
    expect((pawn.getData(Player) as unknown as { performed(a: string): boolean }).performed("jump")).toBe(true);
    expect(log).toEqual(["jump:performed", "polled"]);
    jumper.enabled = false;
    jumper.enabled = true; // re-subscribes in onEnable; the old subscription was dropped
    Input.inject.keyUp("space");
    step();
    Input.inject.keyDown("space");
    step();
    expect(log.filter((l) => l === "jump:performed").length).toBe(2);
  });

  it("joins one player per device with onePerDevice, each reading its own pad", async () => {
    engine.dispose();
    engine = await Engine.create({ headless: true, project: { input: { join: "onePerDevice", maxPlayers: 4 } } });
    const joined: number[] = [];
    defineSystem({ name: "test.inputActions.joined", phase: "update", run: () => { for (const j of PlayerJoined.read()) joined.push(j.index); } });
    pad(10);
    pad(11);
    step();
    expect(InputPlayers.all().map((p) => p.index)).toEqual([0, 1]);
    expect(joined).toEqual([0, 1]);
    Input.inject.gamepadButton(11, 0, 1);
    step();
    expect(InputPlayers.get(1)!.performed("jump")).toBe(true);
    expect(InputPlayers.get(0)!.held("jump")).toBe(false);
  });

  it("rebinds an action to the next press, and names prompts for the device last used", async () => {
    step();
    expect(p0().prompt("jump", "keyboard")!.label).toBe("Space");
    expect(p0().prompt("jump", "playstation")!.label).toBe("Cross");
    expect(p0().prompt("move", "keyboard")!.label).toBe("W/S/A/D");
    expect(p0().prompt("dash", "keyboard")!.label).toBe("Shift+B");
    const result = p0().rebind("jump", { device: "keyboard" });
    Input.inject.keyDown("k");
    step();
    const r = await result;
    expect(r.control).toBe("<Keyboard>/k");
    expect(r.canceled).toBe(false);
    Input.inject.keyUp("k");
    step();
    Input.inject.keyDown("space");
    step();
    expect(p0().held("jump")).toBe(false);
    Input.inject.keyUp("space");
    Input.inject.keyDown("k");
    step();
    expect(p0().performed("jump")).toBe(true);
    expect(p0().prompt("jump", "keyboard")!.label).toBe("K");
    Input.inject.keyUp("k");
    step();
    pad(4, "playstation");
    Input.inject.gamepadButton(4, 0, 1);
    step();
    expect(p0().lastFamily).toBe("playstation");
    expect(p0().prompt("jump")!.label).toBe("Cross");
    p0().resetBindings();
    step();
    expect(p0().prompt("jump", "keyboard")!.label).toBe("Space");
  });

  it("applies accessibility: hold-to-toggle and inverted look", () => {
    step();
    p0().accessibility = { holdToToggle: ["jump"], invertY: ["look"] };
    Input.inject.keyDown("space");
    step();
    Input.inject.keyUp("space");
    step();
    expect(p0().held("jump")).toBe(true); // latched
    Input.inject.keyDown("space");
    step();
    expect(p0().held("jump")).toBe(false);
    Input.inject.move(0, 5);
    step();
    expect(p0().vector2("look").y).toBe(5);
  });
});
