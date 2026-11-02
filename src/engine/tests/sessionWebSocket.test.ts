import { afterEach, describe, expect, it } from "vitest";
import "../../server/websocketServer"; // registers the Node "websocket" transport, which can listen
import { Connection, ConnectionState, Engine, defineRpc, defineSystem, i32, type BootstrapConfig } from "../index";
import { World } from "../core/World";
import { connectWorld, listenWorld, netSession } from "../net/session";

// ADR 0033, 0035, T10: server Worlds listening over a real WebSocket in Node, on port 0.

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

/** Step the Engines on real time until `done` holds. */
async function stepUntil(list: Engine[], done: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const e of list) e.step(1 / 60);
  }
}

function states(w: World): number[] {
  const out: number[] = [];
  for (const row of w._query([Connection])) out.push((row.connection as { state: number }).state);
  return out;
}

const Hello = defineRpc("test.sessionWs.Hello", { n: i32 });

describe("network sessions over WebSocket in Node (T10)", () => {
  it("links a client World to a server World listening on a port, and RPCs flow", async () => {
    const engine = await create({
      worlds: [
        { name: "Client", tags: ["client"] },
        { name: "Server", tags: ["server", "ws-server"] },
      ],
      links: [{ from: "Client", to: "Server", transport: "websocket", options: { port: 0 } }],
    });
    const got: number[] = [];
    defineSystem({ name: "test.sessionWs.read", phase: "update", worlds: ["ws-server"], run: () => got.push(...[...Hello.read()].map((m) => m.n)) });
    const client = engine._world("Client")!;
    const server = engine._world("Server")!;
    await stepUntil([engine], () => states(client)[0] === ConnectionState.open && states(server).length === 1);
    World._runIn(client, () => Hello.send({ n: 42 }));
    await stepUntil([engine], () => got.length > 0);
    expect(got).toEqual([42]);
    expect(netSession(client)!.estimatedServerTick).toBeGreaterThan(0);
  });

  it("runs a dedicated server Engine and a client Engine that connects by URL; the client sees the server go", async () => {
    const host = await create({ worlds: [{ name: "Server", tags: ["server"] }] });
    const url = await listenWorld(host.world, "websocket", { address: "ws://127.0.0.1:0/game" });
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/game$/);
    const game = await create({ worlds: [{ name: "Client", tags: ["client"] }] });
    connectWorld(game.world, "websocket", { url });
    await stepUntil([host, game], () => states(game.world)[0] === ConnectionState.open && states(host.world).length === 1);

    const warn = console.warn;
    console.warn = () => {};
    try {
      host.dispose();
      engines.splice(engines.indexOf(host), 1);
      await stepUntil([game], () => states(game.world).length === 0);
    } finally {
      console.warn = warn;
    }
  });
});
