import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, ConnectionState, Engine, type BootstrapConfig } from "../index";
import { validateBootstrap } from "../core/settings";
import type { World } from "../core/World";
import { serverReplication } from "../net/replication/server";
import { SNAPSHOT } from "../net/replication/wire";
import { netSession } from "../net/session";
import { createTransport, registerTransport, transportCanListen } from "../net/Transport";

// ADR 0101 (replication settings on a World config) and ADR 0102 (a link between two Worlds of
// one page over a transport that can't listen there connects them over loopback). Loopback on a
// fake clock, as in session.test.ts.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

function step(engine: Engine, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    engine.step(DT);
  }
}

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

const states = (w: World | null) => (w ? [...w._query([Connection])].map((r) => (r.connection as { state: number }).state) : []);

describe("replication settings (ADR 0101)", () => {
  it("validates a World config's replication settings", () => {
    const ok: BootstrapConfig = { worlds: [{ name: "S", tags: ["server"], replication: { sendRate: 20, maxSnapshotBytes: 1200 } }] };
    expect(validateBootstrap(ok)).toEqual([]);
    const bad = { worlds: [{ name: "S", replication: { sendRate: 0, maxSnapshotBytes: 10.5, rate: 3 } }], templates: { T: { replication: "fast" } } } as unknown as BootstrapConfig;
    const problems = validateBootstrap(bad).join("\n");
    expect(problems).toMatch(/replication: unknown key "rate"/);
    expect(problems).toMatch(/replication: sendRate must be a positive number/);
    expect(problems).toMatch(/replication: maxSnapshotBytes must be a whole number of bytes, 256 or more/);
    expect(problems).toMatch(/templates.*replication must be an object/);
  });

  it("applies sendRate and maxSnapshotBytes to the server World's replication, for start-up Worlds and templates", async () => {
    const engine = await create({
      worlds: [
        { name: "Client", tags: ["client"] },
        { name: "Server", tags: ["server"], renders: false, replication: { sendRate: 20, maxSnapshotBytes: 1000 } },
      ],
      templates: { Other: { tags: ["server"], renders: false, replication: { sendRate: 30 } } },
      links: [{ from: "Client", to: "Server", transport: "loopback", options: { now } }],
    });
    step(engine, 3);
    const r = serverReplication(engine._world("Server")!)!;
    expect(r.sendRate).toBe(20);
    expect(r.maxSnapshotBytes).toBe(1000);
    engine.createWorld("Other");
    const other = engine._world("Other")!;
    await engine.findWorld("Other")!.listen("loopback");
    const o = serverReplication(other)!;
    expect(o.sendRate).toBe(30);
    expect(o.maxSnapshotBytes).toBe(64 * 1024);
  });

  it("sends a snapshot every round(tickRate / sendRate) ticks", async () => {
    const engine = await create({
      worlds: [
        { name: "Client", tags: ["client"] },
        { name: "Server", tags: ["server"], renders: false, replication: { sendRate: 20 } },
      ],
      links: [{ from: "Client", to: "Server", transport: "loopback", options: { now } }],
    });
    step(engine, 10);
    const session = netSession(engine._world("Server")!)!;
    const before = session.allPeers()[0];
    expect(before.link.state).toBe("open");
    const sent = vi.spyOn(session, "send");
    step(engine, 60);
    const snapshots = sent.mock.calls.filter((c) => c[0] === SNAPSHOT);
    // 60 ticks at 60 Hz with a snapshot every 3rd tick: 20.
    expect(snapshots.length).toBeGreaterThanOrEqual(19);
    expect(snapshots.length).toBeLessThanOrEqual(21);
  });
});

describe("links over a transport that can't listen in the page (ADR 0102)", () => {
  it("connects two Worlds of one Engine over loopback, saying so once per link", async () => {
    expect(transportCanListen("websocket")).toBe(false); // the browser WebSocket transport
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const engine = await create({
      worlds: [
        { name: "Client", tags: ["client"] },
        { name: "Server", tags: ["server"], renders: false },
      ],
      links: [{ from: "Client", to: "Server", transport: "websocket", options: { port: 7777, url: "ws://localhost:7777", now, interpolationMs: 50 } }],
    });
    step(engine, 5);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
    expect(states(engine._world("Server"))).toEqual([ConnectionState.open]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/"Client" → "Server": "websocket" can't listen here .* over "loopback" instead/);
    const transports = netSession(engine._world("Server")!)!.transportList();
    expect(transports).toHaveLength(1);
    // The made-up loopback address, not the WebSocket port.
    expect(engine.findWorld("Server")!.addresses()[0]).toMatch(/^engine-\d+\/Server$/);
  });

  it("works for WorldHandle.connect between two Worlds of one Engine too", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const engine = await create({ worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"], renders: false }] });
    engine.findWorld("Client")!.connect(engine.findWorld("Server")!, "websocket", { now });
    step(engine, 5);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
  });

  it("transports registered without capabilities can listen", () => {
    registerTransport("test-listener", (o) => createTransport("loopback", o));
    expect(transportCanListen("test-listener")).toBe(true);
    expect(transportCanListen("no-such-transport")).toBe(true);
  });
});
