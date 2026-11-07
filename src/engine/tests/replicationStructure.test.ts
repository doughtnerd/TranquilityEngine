import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Replicated, type BootstrapConfig, type LinkConfig } from "../index";
import { World } from "../core/World";
import { createBitReader, createBitWriter } from "../net/codec";
import { netSession } from "../net/session";
import { serverReplication } from "../net/replication/server";
import { SNAPSHOT, StringTableIn, StringTableOut, MAX_TABLE_STRINGS } from "../net/replication/wire";

// ADR 0100: replicating node activity and reparenting, and the per-connection string table for
// spawns. Loopback on a fake clock that advances with `engine.step`, as in replication.test.ts.

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

function sequenceRandom(seed = 0.37): () => number {
  let x = seed;
  return () => (x = (x * 9301 + 0.49297) % 1);
}

const transformOf = (x: number, y = 0) => ({ type: "engine.Transform", data: { position: [x, y, 0] } });

Assets.addSource(
  Assets.fromObject({
    "prefabs/structure/crate.json": {
      format: "myco.scene@1",
      nodes: [{ id: "crate", name: "Crate", components: [{ type: "net.Replicated" }, transformOf(0)] }],
    },
    "prefabs/structure/a-much-longer-prefab-path-for-the-string-table/tank.json": {
      format: "myco.scene@1",
      nodes: [
        { id: "tank", name: "Tank", components: [{ type: "net.Replicated" }, transformOf(0)] },
        { id: "turret", name: "Turret", parent: "tank", components: [{ type: "net.Replicated" }, transformOf(0, 1)] },
        { id: "hand", name: "Hand", parent: "tank", components: [transformOf(0, -1)] },
      ],
    },
    "scenes/structure.scene.json": {
      format: "myco.scene@1",
      nodes: [
        { id: "floor", name: "Floor", components: [transformOf(0, -5)] },
        { id: "shelf", name: "Shelf", components: [transformOf(20, 0)] },
        { id: "lamp", name: "Lamp", components: [{ type: "net.Replicated" }, transformOf(-3, 0)] },
      ],
    },
  }),
);

const TANK = "prefabs/structure/a-much-longer-prefab-path-for-the-string-table/tank.json";
const CRATE = "prefabs/structure/crate.json";

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

function clientsAndServer(count: number, options: Record<string, unknown> = {}, scenes: string[] = ["scenes/structure.scene.json"]): BootstrapConfig {
  const names = Array.from({ length: count }, (_, i) => `P${i + 1}`);
  const links: LinkConfig[] = names.map((n, i) => ({ from: n, to: "Server", transport: "loopback", options: { now, random: sequenceRandom(0.11 + i * 0.2), ...options } }));
  return { worlds: [...names.map((name) => ({ name, tags: ["client"], scenes })), { name: "Server", tags: ["server"], scenes }], links };
}

const world = (engine: Engine, name: string) => engine._world(name)!;
const inWorld = <T>(w: World, fn: () => T): T => World._runIn(w, fn);

/** The client node of the server node `node`'s ghost, or null. */
function ghostIn(client: World, node: GameObject): GameObject | null {
  const id = node.getBehavior(Replicated)!.ghostId;
  for (const rep of client._componentsOfType(Replicated)) if (rep.isGhost && rep.ghostId === id && rep.node.isValid) return rep.node;
  return null;
}

describe("node activity (ADR 0100)", () => {
  it("replicates a ghost's own active flag both ways, for prefab and scene ghosts, under loss", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 30, jitterMs: 5, loss: 0.2 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const tank = inWorld(server, () => GameObject.instantiate(TANK, { position: [1, 0, 0] }));
    const lamp = server.activeScene!.find("Lamp")!;
    step(engine, 60);
    for (const name of ["P1", "P2"]) expect(ghostIn(world(engine, name), tank)!.active).toBe(true);

    inWorld(server, () => {
      tank.setActive(false);
      lamp.setActive(false);
    });
    step(engine, 60);
    for (const name of ["P1", "P2"]) {
      const client = world(engine, name);
      const t = ghostIn(client, tank)!;
      expect(t.active).toBe(false);
      expect(t.find("Turret")!.activeInHierarchy).toBe(false);
      expect(ghostIn(client, lamp)!.active).toBe(false);
    }

    inWorld(server, () => tank.setActive(true));
    step(engine, 60);
    for (const name of ["P1", "P2"]) {
      expect(ghostIn(world(engine, name), tank)!.active).toBe(true);
      expect(ghostIn(world(engine, name), lamp)!.active).toBe(false);
    }
  });

  it("spawns a ghost that's inactive on the server inactive, for a late joiner too", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const crate = inWorld(server, () => GameObject.instantiate(CRATE));
    inWorld(server, () => crate.setActive(false));
    step(engine, 40);
    expect(ghostIn(world(engine, "P1"), crate)!.active).toBe(false);
    const late = engine.createWorld({ name: "Late", tags: ["client"], scenes: ["scenes/structure.scene.json"] });
    late.connect(engine.findWorld("Server")!, "loopback", { now, latencyMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0)); // its scene loads
    step(engine, 60);
    expect(ghostIn(world(engine, "Late"), crate)!.active).toBe(false);
  });

  it("shows the change when the interpolation tick reaches it, not when it arrives", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20, interpolationMs: 200 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const crate = inWorld(server, () => GameObject.instantiate(CRATE));
    step(engine, 60);
    inWorld(server, () => crate.setActive(false));
    step(engine, 4); // arrived (20 ms), but 200 ms of interpolation buffer haven't passed
    const ghost = ghostIn(world(engine, "P1"), crate)!;
    expect(ghost.active).toBe(true);
    step(engine, 30);
    expect(ghost.active).toBe(false);
  });
});

describe("reparenting (ADR 0100)", () => {
  it("moves a ghost under another ghost, a node inside one, a scene node and the root, keeping world positions", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 30, jitterMs: 5, loss: 0.15 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const tank = inWorld(server, () => GameObject.instantiate(TANK, { position: [10, 0, 0] }));
    const crate = inWorld(server, () => GameObject.instantiate(CRATE, { position: [1, 2, 0] }));
    step(engine, 60);

    const check = (parentName: string) => {
      server._propagateTransforms();
      for (const name of ["P1", "P2"]) {
        const client = world(engine, name);
        client._propagateTransforms();
        const g = ghostIn(client, crate)!;
        expect(g.parent!.name).toBe(parentName);
        expect(g.transform!.worldPosition.x).toBeCloseTo(crate.transform!.worldPosition.x, 2);
        expect(g.transform!.worldPosition.y).toBeCloseTo(crate.transform!.worldPosition.y, 2);
      }
    };
    const shelf = server.activeScene!.find("Shelf")!;
    const steps: [GameObject, string][] = [
      [tank, "Tank"],
      [tank.find("Hand")!, "Hand"], // a plain node inside a ghost's instance
      [tank.find("Turret")!, "Turret"],
      [shelf, "Shelf"], // a scene-placed node that isn't a ghost
      [server.root, "Root"],
    ];
    for (const [parent, name] of steps) {
      inWorld(server, () => crate.setParent(parent));
      step(engine, 60);
      check(parent === server.root ? world(engine, "P1").root.name : name);
    }

    // A scene ghost moves too, and back.
    const lamp = server.activeScene!.find("Lamp")!;
    inWorld(server, () => lamp.setParent(tank));
    step(engine, 60);
    for (const name of ["P1", "P2"]) expect(ghostIn(world(engine, name), lamp)!.parent!.name).toBe("Tank");
    inWorld(server, () => lamp.setParent(server.activeScene!));
    step(engine, 60);
    for (const name of ["P1", "P2"]) expect(ghostIn(world(engine, name), lamp)!.parent).toBe(world(engine, name).activeScene);
  });

  it("doesn't interpolate across a move: the world position never jumps", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const tank = inWorld(server, () => GameObject.instantiate(TANK, { position: [10, 0, 0] }));
    const crate = inWorld(server, () => GameObject.instantiate(CRATE, { position: [1, 0, 0] }));
    step(engine, 60);
    const client = world(engine, "P1");
    const ghost = ghostIn(client, crate)!;
    inWorld(server, () => crate.setParent(tank)); // local x becomes -9
    for (let i = 0; i < 40; i++) {
      step(engine);
      client._propagateTransforms();
      expect(ghost.transform!.worldPosition.x).toBeCloseTo(1, 2);
    }
    expect(ghost.parent!.name).toBe("Tank");
    expect(ghost.transform!.position.x).toBeCloseTo(-9, 2);
  });

  it("spawns a late joiner's ghost under its current parent, even when its first parent is gone", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const first = inWorld(server, () => GameObject.instantiate(TANK, { position: [5, 0, 0] }));
    const second = inWorld(server, () => GameObject.instantiate(TANK, { position: [-5, 0, 0] }));
    const crate = inWorld(server, () => GameObject.instantiate(CRATE, { parent: first, position: [0, 3, 0] }));
    step(engine, 30);
    inWorld(server, () => {
      crate.setParent(second.find("Hand")!);
      GameObject.destroy(first);
    });
    step(engine, 30);
    const late = engine.createWorld({ name: "Late", tags: ["client"], scenes: ["scenes/structure.scene.json"] });
    late.connect(engine.findWorld("Server")!, "loopback", { now, latencyMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0)); // its scene loads
    step(engine, 60);
    const g = ghostIn(world(engine, "Late"), crate)!;
    expect(g.parent!.name).toBe("Hand");
    expect(g.parent!.parent).toBe(ghostIn(world(engine, "Late"), second));
  });

  it("warns once when a ghost moves under a node clients can't find, and puts it under their active scene", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const crate = inWorld(server, () => GameObject.instantiate(CRATE));
    step(engine, 30);
    const made = inWorld(server, () => GameObject.create("Made"));
    inWorld(server, () => crate.setParent(made));
    step(engine, 30);
    const moves = warn.mock.calls.filter((c) => /was moved under .*which clients can't find/.test(String(c[0])));
    expect(moves).toHaveLength(1);
    expect(ghostIn(world(engine, "P1"), crate)!.parent).toBe(world(engine, "P1").activeScene);
  });
});

describe("the per-connection string table (ADR 0100)", () => {
  it("sends a string inline until a snapshot defining it is acked, then by index", () => {
    const out = new StringTableOut();
    const into = new StringTableIn();
    const roundTrip = (strings: string[]) => {
      const defined: number[] = [];
      const write = out.writer(defined);
      const w = createBitWriter();
      for (const s of strings) write(w, s);
      const bytes = w.finish();
      const r = createBitReader(bytes);
      return { read: strings.map(() => into.read(r)), defined, bytes: bytes.byteLength };
    };
    const first = roundTrip(["prefabs/a.json", "prefabs/a.json", "x"]);
    expect(first.read).toEqual(["prefabs/a.json", "prefabs/a.json", "x"]);
    expect(first.defined).toEqual([0, 0, 1]);
    const unacked = roundTrip(["prefabs/a.json"]);
    expect(unacked.bytes).toBeGreaterThan(14);
    out.acked(first.defined);
    const acked = roundTrip(["prefabs/a.json", "x"]);
    expect(acked.read).toEqual(["prefabs/a.json", "x"]);
    expect(acked.defined).toEqual([]);
    expect(acked.bytes).toBe(2);
    expect(out.size).toEqual({ entries: 2, acked: 2 });
    // An index the client never saw is an error, not a wrong string.
    const w = createBitWriter();
    w.writeVarUint(2 * 7 + 2);
    expect(() => new StringTableIn().read(createBitReader(w.finish()))).toThrow(/never defined/);
  });

  it("sends strings inline without an index once the table is full", () => {
    const out = new StringTableOut();
    const defined: number[] = [];
    const write = out.writer(defined);
    const w = createBitWriter();
    for (let i = 0; i <= MAX_TABLE_STRINGS; i++) write(w, `s${i}`);
    expect(out.size.entries).toBe(MAX_TABLE_STRINGS);
    const into = new StringTableIn();
    const r = createBitReader(w.finish());
    for (let i = 0; i <= MAX_TABLE_STRINGS; i++) expect(into.read(r)).toBe(`s${i}`);
  });

  it("makes a second spawn of the same prefab smaller once the first was acked, under loss", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20, loss: 0.2 }, []));
    const server = world(engine, "Server");
    step(engine, 10);
    const session = netSession(server)!;
    const sizes: number[] = [];
    const send = session.send.bind(session);
    vi.spyOn(session, "send").mockImplementation((kind, to, channel, body, tick) => {
      if (kind === SNAPSHOT && body instanceof Uint8Array) sizes.push(body.byteLength);
      send(kind, to, channel, body, tick);
    });
    inWorld(server, () => GameObject.instantiate(TANK));
    step(engine, 1);
    const firstSpawn = sizes[sizes.length - 1];
    step(engine, 60);
    const steady = sizes[sizes.length - 1];
    inWorld(server, () => GameObject.instantiate(TANK));
    step(engine, 1);
    const secondSpawn = sizes[sizes.length - 1];
    // The tank's prefab path alone is over 60 bytes; by index it's one.
    expect(firstSpawn - steady).toBeGreaterThan(secondSpawn - steady + 60);
    step(engine, 60);
    expect(world(engine, "P1")._componentsOfType(Replicated).filter((r) => r.isGhost)).toHaveLength(4);
    const peer = session.openPeers()[0];
    expect(serverReplication(server)!.peerState(peer)!.table.size.acked).toBeGreaterThan(0);
  });
});
