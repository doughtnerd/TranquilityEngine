import { afterEach, expect, it } from "vitest";
import { Engine, GameObject, Input, Replicated, button, defineActions, defineSystem, vec2, type BootstrapConfig } from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";

// ADR 0335: a networked action set is an input stream; the server reads each client's resolved
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
