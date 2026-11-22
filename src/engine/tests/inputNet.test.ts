import { afterEach, describe, expect, it } from "vitest";
import {
  ActionEvents,
  ConnectionPlayer,
  Engine,
  GameBehavior,
  GameObject,
  Input,
  InputPlayers,
  Replicated,
  button,
  defineActions,
  defineInput,
  defineSystem,
  f32,
  vec2,
  type ActionEvent,
  type BootstrapConfig,
} from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";

// ADR 0337: a networked action set is an input stream; the server reads each client's resolved
// actions in the same component on the pawn that client owns. Loopback on a fake clock.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Input.inject.releaseAll();
});

const Net = defineActions(
  "test.inputNet.Actions",
  { move: vec2("<Gamepad>/leftStick"), fire: button("<Keyboard>/space") },
  { networked: true, encoding: { move: { quantize: 1 / 100 } } },
);

it("carries a client's actions to its pawn on the server, quantized at the source", async () => {
  const bootstrap: BootstrapConfig = {
    worlds: [
      { name: "Client", tags: ["client", "inet-client"], input: true },
      { name: "Server", tags: ["server", "inet-server"], input: false },
    ],
    links: [{ from: "Client", to: "Server", transport: "loopback", options: { now } }],
  };
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  const fired: number[] = [];
  const moves: number[] = [];
  defineSystem({
    name: "test.inputNet.server",
    phase: "fixedUpdate",
    worlds: ["inet-server"],
    query: [Net],
    run(rows, ctx) {
      for (const r of rows) {
        const actions = (r as unknown as { actions: { performed(a: string): boolean; vector2(a: string): { x: number } } }).actions;
        if (actions.performed("fire")) fired.push(ctx.time.network!.serverTick ?? 0);
        moves.push(actions.vector2("move").x);
      }
    },
  });
  const step = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      clock += DT * 1000;
      engine.step(DT);
    }
  };
  step(30); // connect
  const server = engine._world("Server")!;
  const session = netSession(server)!;
  expect(session.openPeers().length).toBe(1);
  // The pawn the client owns, on the server, with the set's component.
  World._runIn(server, () => {
    const pawn = GameObject.create("Pawn");
    pawn.addBehavior(Replicated, { ownerId: session.openPeers()[0].id });
    pawn.addData(Net);
  });

  Input.inject.gamepadConnected({ id: 21, name: "Pad", family: "xbox" });
  Input.inject.gamepadAxis(21, 0, 0.5555);
  Input.inject.keyDown("space");
  step(2);
  Input.inject.keyUp("space");
  step(20);
  expect(fired.length).toBe(1);
  const last = moves[moves.length - 1];
  // Dead zone 0.15 rescales 0.5555 → 0.4771; quantized to 1/100 on the client before sending.
  expect(last).toBeCloseTo(0.48, 5);
  Input.inject.gamepadDisconnected(21);
  step(1);
});

describe("server pawns and several local players per connection (ADR 0337)", () => {
  const start = async (project?: { input: { join: "onePerDevice"; maxPlayers: number } }) => {
    const bootstrap: BootstrapConfig = {
      worlds: [
        { name: "Client", tags: ["client", "inet-client"], input: true },
        { name: "Server", tags: ["server", "inet-server"], input: false },
      ],
      links: [{ from: "Client", to: "Server", transport: "loopback", options: { now } }],
    };
    const engine = await Engine.create({ headless: true, bootstrap, project });
    engines.push(engine);
    const step = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        clock += DT * 1000;
        engine.step(DT);
      }
    };
    step(30); // connect
    const server = engine._world("Server")!;
    const session = netSession(server)!;
    expect(session.openPeers().length).toBe(1);
    const peer = session.openPeers()[0];
    const pawn = (name: string, localPlayer?: number) =>
      World._runIn(server, () => {
        const node = GameObject.create(name);
        node.addBehavior(Replicated, { ownerId: peer.id });
        node.addData(Net);
        if (localPlayer !== undefined) node.addData(ConnectionPlayer, { index: localPlayer });
        return node;
      });
    return { engine, step, server, peer, pawn };
  };

  it("fires on() for a server pawn from the tick's phase flags, once per edge", async () => {
    const { step, server, peer, pawn } = await start();
    const log: ActionEvent[] = [];
    class Gun extends GameBehavior {
      onEnable() {
        this.input.on("fire", "performed", (e) => log.push(e));
      }
    }
    const hero = pawn("Hero");
    World._runIn(server, () => hero.addBehavior(Gun));
    const events: string[] = [];
    defineSystem({
      name: "test.inputNet.events",
      phase: "fixedUpdate",
      worlds: ["inet-server"],
      after: ["engine.InputNetApply"],
      run: () => {
        for (const e of ActionEvents.read()) if (e.action === "fire") events.push(e.phase);
      },
    });
    step(2);
    Input.inject.keyDown("space");
    step(3);
    Input.inject.keyUp("space");
    step(10);
    expect(log.length).toBe(1);
    expect(log[0].node).toBe(hero);
    expect(log[0].player).toBe(peer.node);
    expect(log[0].index).toBe(0);
    expect(events).toEqual(["started", "performed", "completed"]);
  });

  it("sends every local player's actions; the server drives each pawn by its ConnectionPlayer", async () => {
    const { engine, step, pawn } = await start({ input: { join: "onePerDevice", maxPlayers: 2 } });
    Input.inject.keyDown("q"); // the keyboard joins first: player 0
    step(1);
    Input.inject.keyUp("q");
    Input.inject.gamepadConnected({ id: 31, name: "Pad", family: "xbox" });
    step(2);
    expect(World._runIn(engine._world("Client")!, () => InputPlayers.all().map((p) => p.index))).toEqual([0, 1]);
    const first = pawn("First"); // no ConnectionPlayer: player 0
    const second = pawn("Second", 1);
    const read = (node: GameObject) => node.getData(Net) as unknown as { vector2(a: string): { x: number }; held(a: string): boolean };
    Input.inject.gamepadAxis(31, 0, 1); // player 1's stick
    Input.inject.keyDown("space"); // player 0's keyboard
    step(10);
    expect(read(second).vector2("move").x).toBeCloseTo(1, 2);
    expect(read(second).held("fire")).toBe(false);
    expect(read(first).vector2("move").x).toBe(0);
    expect(read(first).held("fire")).toBe(true);
    Input.inject.gamepadDisconnected(31);
    step(1);
  });
});

it("keeps a defineInput stream per local player, and refuses a bad player index", async () => {
  const Lane = defineInput("test.inputNet.Lane", { x: f32 });
  const bootstrap: BootstrapConfig = {
    worlds: [
      { name: "Client", tags: ["client"], input: false },
      { name: "Server", tags: ["server"], input: false },
    ],
    links: [{ from: "Client", to: "Server", transport: "loopback", options: { now } }],
  };
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  const client = engine._world("Client")!;
  const server = engine._world("Server")!;
  defineSystem({
    name: "test.inputNet.lane",
    phase: "fixedUpdate",
    worlds: ["client"],
    run: () => {
      Lane.write({ x: 1 });
      Lane.write({ x: 2 }, 3);
    },
  });
  for (let i = 0; i < 40; i++) {
    clock += DT * 1000;
    engine.step(DT);
  }
  const connection = netSession(server)!.openPeers()[0].node!;
  World._runIn(server, () => {
    expect(Lane.of(connection)?.x).toBe(1);
    expect(Lane.of(connection, 3)?.x).toBe(2);
    expect(Lane.of(connection, 1)).toBeNull();
    expect(Lane.stats(connection, 3)!.received).toBeGreaterThan(0);
  });
  World._runIn(client, () => expect(() => Lane.write({ x: 0 }, -1)).toThrow(/local player index/));
});
