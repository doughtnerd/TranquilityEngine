import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Assets,
  Connection,
  Engine,
  GameBehavior,
  GameObject,
  Replicated,
  Vector3,
  behavior,
  defineComponent,
  defineInput,
  defineSystem,
  f32,
  field,
  i32,
  replicate,
  type BootstrapConfig,
  type LinkConfig,
} from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";
import { configureReplication, serverReplication } from "../net/replication/server";
import { clientReplication } from "../net/replication/client";

// ADR 0033, T11: ghosts, snapshots, interpolation and per-World components, over the loopback
// transport on a fake clock that advances with `engine.step`, so everything is deterministic.

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

/** A deterministic 0..1 sequence. */
function sequenceRandom(seed = 0.37): () => number {
  let x = seed;
  return () => (x = (x * 9301 + 0.49297) % 1);
}

const Health = defineComponent("test.repl.Health", { current: f32, max: f32, team: i32 });
replicate(Health, { encoding: { current: { quantize: 0.5 } } });
const Secret = defineComponent("test.repl.Secret", { value: f32 }); // not replicated

/** Moves its node in a line, on the server only (a per-World component). */
@behavior("test.repl.Mover", { worlds: ["server"] })
class Mover extends GameBehavior {
  @field(Number) speed = 0.05;
  fixedUpdate() {
    const tick = this.time.network?.tick ?? 0;
    this.transform.position.x = tick * this.speed;
    this.transform.rotation2D = tick * 2;
  }
}

@behavior("test.repl.Stats")
class Stats extends GameBehavior {
  @field(Number, { replicate: true }) score = 0;
  @field(Number, { replicate: true, quantize: 0.01 }) speed = 0;
  @field(Boolean, { replicate: true }) alive = true;
  @field(Number) local = 7; // not replicated
}

/** Only on `prefabs/aimer.json`, so its warning is seen by the test that uses it. */
@behavior("test.repl.Aimer")
class Aimer extends GameBehavior {
  @field(Number, { replicate: true }) n = 0;
  @field(Vector3, { replicate: true }) aim = new Vector3(); // not a number: skipped, with a warning
}

@behavior("test.repl.ClientOnly", { worlds: ["client"] })
class ClientOnly extends GameBehavior {
  @field(Number) n = 0;
}

const transformOf = (x: number, y = 0) => ({ type: "engine.Transform", data: { position: [x, y, 0] } });

Assets.addSource(
  Assets.fromObject({
    "prefabs/ball.json": {
      format: "tranquility.scene@1",
      nodes: [{ id: "ball", name: "Ball", components: [{ type: "net.Replicated" }, { type: "test.repl.Mover" }] }],
    },
    "prefabs/aimer.json": {
      format: "tranquility.scene@1",
      nodes: [{ id: "aimer", name: "Aimer", components: [{ type: "net.Replicated" }, { type: "test.repl.Aimer" }] }],
    },
    "prefabs/crate.json": {
      format: "tranquility.scene@1",
      nodes: [{ id: "crate", name: "Crate", components: [{ type: "net.Replicated" }] }],
    },
    "prefabs/tank.json": {
      format: "tranquility.scene@1",
      nodes: [
        { id: "tank", name: "Tank", components: [{ type: "net.Replicated" }, { type: "test.repl.Stats" }, { type: "test.repl.Health", data: { current: 10, max: 10, team: 1 } }] },
        { id: "turret", name: "Turret", parent: "tank", components: [{ type: "net.Replicated" }, transformOf(0, 1)] },
        { id: "decal", name: "Decal", parent: "tank", components: [transformOf(0, -1)] },
      ],
    },
    "scenes/arena.scene.json": {
      format: "tranquility.scene@1",
      nodes: [
        { id: "floor", name: "Floor", components: [transformOf(0, -5)] },
        { id: "door", name: "Door", components: [{ type: "net.Replicated" }, transformOf(3, 0), { type: "test.repl.Health", data: { current: 5, max: 5 } }] },
        { id: "group", name: "Group" },
        { id: "lamp", name: "Lamp", parent: "group", components: [{ type: "net.Replicated" }, transformOf(-3, 0)] },
        { id: "cratePlaced", prefab: "prefabs/crate.json" },
      ],
    },
    "scenes/split.scene.json": {
      format: "tranquility.scene@1",
      nodes: [
        {
          id: "brain",
          name: "Brain",
          components: [
            { type: "test.repl.Mover" },
            { type: "test.repl.ClientOnly" },
            { type: "test.repl.Secret", data: { value: 1 }, worlds: ["server"] },
            { type: "test.repl.Stats", worlds: ["client"] },
          ],
        },
        {
          id: "inst",
          prefab: "prefabs/ball.json",
          overrides: [
            { component: "test.repl.Mover", field: "speed", value: 2 },
            { component: "test.repl.Mover", enabled: false },
          ],
        },
      ],
    },
  }),
);

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

/** Client Worlds `P1`, `P2`… linked to `Server` over loopback with `options`. */
function clientsAndServer(count: number, options: Record<string, unknown> = {}, scenes?: string[]): BootstrapConfig {
  const names = Array.from({ length: count }, (_, i) => `P${i + 1}`);
  const links: LinkConfig[] = names.map((n, i) => ({ from: n, to: "Server", transport: "loopback", options: { now, random: sequenceRandom(0.11 + i * 0.2), ...options } }));
  return {
    worlds: [...names.map((name) => ({ name, tags: ["client"], scenes })), { name: "Server", tags: ["server"], scenes }],
    links,
  };
}

function world(engine: Engine, name: string): World {
  return engine._world(name)!;
}

function inWorld<T>(w: World, fn: () => T): T {
  return World._runIn(w, fn);
}

/** A World's ghosts (client) or replicated nodes (server), by ghost id. */
function ghosts(w: World): Map<number, GameObject> {
  const out = new Map<number, GameObject>();
  for (const rep of w._componentsOfType(Replicated)) if (rep.ghostId && rep.node.isValid && (rep.isGhost || netSession(w)?.isServer)) out.set(rep.ghostId, rep.node);
  return out;
}

describe("replication (T11)", () => {
  it("a server-moved replicated node appears smoothly on two clients under latency, jitter and loss", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 100, jitterMs: 20, loss: 0.1 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const ball = inWorld(server, () => GameObject.instantiate("prefabs/ball.json"));
    step(engine, 120);

    for (const name of ["P1", "P2"]) {
      const client = world(engine, name);
      const [ghost, ...others] = ghosts(client).values();
      expect(others).toEqual([]);
      expect(ghost.name).toBe("Ball");
      expect(ghost.getBehavior(Mover)).toBeNull(); // server-only
      expect(ghost.getBehavior(Replicated)!.ghostId).toBe(ball.getBehavior(Replicated)!.ghostId);
    }

    const last = new Map<string, number>();
    let worst = 0;
    for (let frame = 0; frame < 240; frame++) {
      step(engine, 1);
      for (const name of ["P1", "P2"]) {
        const client = world(engine, name);
        const ghost = [...ghosts(client).values()][0];
        const net = client.time.network!;
        const x = ghost.transform!.position.x;
        const expected = (net.interpolationTick + net.interpolationFraction) * 0.05;
        worst = Math.max(worst, Math.abs(x - expected));
        expect(x).toBeGreaterThanOrEqual(last.get(name) ?? -Infinity); // never steps back
        last.set(name, x);
        // The rotation follows too (2° per tick), within a degree.
        const angle = ((ghost.transform!.rotation2D % 360) + 360) % 360;
        const expectedAngle = (((net.interpolationTick + net.interpolationFraction) * 2) % 360 + 360) % 360;
        expect(Math.min(Math.abs(angle - expectedAngle), 360 - Math.abs(angle - expectedAngle))).toBeLessThan(1);
      }
    }
    if (process.env.T11_SIZES) process.stderr.write(`[T11] worst interpolation error ${worst}\n`);
    expect(worst).toBeLessThan(0.01); // a fifth of a tick's movement
  });

  it("extrapolates a late ghost for at most 250 ms, then holds it", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    inWorld(server, () => GameObject.instantiate("prefabs/ball.json"));
    step(engine, 60);
    const client = world(engine, "P1");
    const ghost = [...ghosts(client).values()][0];
    engine.findWorld("Server")!.pause(); // no more snapshots
    step(engine, 60);
    const newest = clientReplication(client)!.ghosts.get(ghost.getBehavior(Replicated)!.ghostId)!.states.at(-1)!;
    const held = ghost.transform!.position.x;
    expect(held).toBeCloseTo((newest.tick + 0.25 * 60) * 0.05, 3); // 15 ticks past the newest state
    step(engine, 30);
    expect(ghost.transform!.position.x).toBe(held);
  });

  it("spawns prefabs and their replicated descendants, and despawns them, on every client; a late joiner gets every ghost", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 40, jitterMs: 10, loss: 0.1 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const tanks = inWorld(server, () => [0, 1, 2].map((i) => GameObject.instantiate("prefabs/tank.json", { position: [i * 2, 0, 0] })));
    step(engine, 60);

    for (const name of ["P1", "P2"]) {
      const client = world(engine, name);
      const g = ghosts(client);
      expect(g.size).toBe(6); // three tanks and their turrets
      const roots = [...g.values()].filter((n) => n.name === "Tank");
      expect(roots.map((n) => n.transform!.position.x).sort()).toEqual([0, 2, 4]);
      for (const root of roots) {
        // One instance per tank: the turret ghost is the instance's own child, not a second copy.
        expect(root.children.map((c) => c.name)).toEqual(["Turret", "Decal"]);
        expect(root.find("Turret")!.getBehavior(Replicated)!.isGhost).toBe(true);
      }
    }

    inWorld(server, () => GameObject.destroy(tanks[1]));
    step(engine, 60);
    for (const name of ["P1", "P2"]) {
      const g = ghosts(world(engine, name));
      expect(g.size).toBe(4);
      expect([...g.values()].filter((n) => n.name === "Tank").map((n) => n.transform!.position.x).sort()).toEqual([0, 4]);
    }

    // A late joiner.
    const late = engine.createWorld({ name: "P3", tags: ["client"] });
    late.connect(engine.findWorld("Server")!, "loopback", { now, latencyMs: 40 });
    step(engine, 60);
    const g3 = ghosts(world(engine, "P3"));
    expect([...g3.keys()].sort()).toEqual([...ghosts(server).keys()].sort());
  });

  it("matches scene-placed replicated nodes by id instead of spawning them, without duplicates", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 30 }, ["scenes/arena.scene.json"]));
    const server = world(engine, "Server");
    step(engine, 30);
    const door = server.activeScene!.find("Door")!;
    inWorld(server, () => {
      door.transform!.position.y = 4;
      door.getData(Health)!.current = 2.4; // quantized to 0.5
    });
    step(engine, 40);

    expect(ghosts(server).size).toBe(3); // door, lamp, placed crate
    for (const name of ["P1", "P2"]) {
      const client = world(engine, name);
      const scene = client.activeScene!;
      expect(scene.children.map((c) => c.name)).toEqual(["Floor", "Door", "Group", "Crate"]);
      const g = ghosts(client);
      expect(g.size).toBe(3);
      const clientDoor = scene.find("Door")!;
      expect(clientDoor.getBehavior(Replicated)!.ghostId).toBe(door.getBehavior(Replicated)!.ghostId);
      expect(clientDoor.transform!.position.y).toBeCloseTo(4, 5);
      expect(clientDoor.getData(Health)!.current).toBe(2.5);
      expect(scene.find("Group/Lamp")!.getBehavior(Replicated)!.isGhost).toBe(true);
      expect(scene.find("Floor")!.getBehavior(Replicated)).toBeNull();
    }
  });

  it("sends replicated data-component and behavior fields; leaves the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const tank = inWorld(server, () => GameObject.instantiate("prefabs/tank.json"));
    const aimer = inWorld(server, () => GameObject.instantiate("prefabs/aimer.json"));
    inWorld(server, () => {
      const stats = tank.getBehavior(Stats)!;
      stats.score = 42;
      stats.speed = 1.234;
      stats.alive = false;
      stats.local = 99;
      const a = aimer.getBehavior(Aimer)!;
      a.n = 5;
      a.aim.set(1, 2, 3);
      const health = tank.getData(Health)!;
      health.current = 7;
      health.team = -3;
      tank.addData(Secret, { value: 5 });
    });
    step(engine, 40);
    const ghost = [...ghosts(world(engine, "P1")).values()].find((n) => n.name === "Tank")!;
    const stats = ghost.getBehavior(Stats)!;
    expect(stats.score).toBe(42);
    expect(stats.speed).toBeCloseTo(1.23, 5);
    expect(stats.alive).toBe(false);
    expect(stats.local).toBe(7);
    const a = [...ghosts(world(engine, "P1")).values()].find((n) => n.name === "Aimer")!.getBehavior(Aimer)!;
    expect(a.n).toBe(5);
    expect([a.aim.x, a.aim.y, a.aim.z]).toEqual([0, 0, 0]);
    expect(ghost.getData(Health)).toMatchObject({ current: 7, max: 10, team: -3 });
    expect(ghost.hasData(Secret)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/test\.repl\.Aimer\.aim is declared with replicate, but only Number and Boolean fields replicate/));

    // Later changes keep arriving.
    inWorld(server, () => (tank.getBehavior(Stats)!.score = 43));
    step(engine, 30);
    expect(stats.score).toBe(43);
  });

  it("costs about a byte per unchanged ghost, and acks advance Connection.lastAckedTick", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 30 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const replication = serverReplication(server)!;
    const peer = netSession(server)!.openPeers()[0];
    step(engine, 5);
    const empty = replication.peerState(peer)!.lastBytes;
    inWorld(server, () => {
      for (let i = 0; i < 200; i++) GameObject.instantiate("prefabs/crate.json", { position: [i, i % 7, 0] });
    });
    step(engine, 2);
    const withSpawns = replication.peerState(peer)!.lastBytes;
    step(engine, 60);
    const steady = replication.peerState(peer)!.lastBytes;
    const perGhost = (steady - empty) / 200;
    expect(withSpawns).toBeGreaterThan(200 * 10);
    expect(perGhost).toBeLessThanOrEqual(1.5);
    if (process.env.T11_SIZES) process.stderr.write(`[T11] snapshot bytes: empty ${empty}, with 200 spawns ${withSpawns}, 200 unchanged ghosts ${steady} (${perGhost.toFixed(2)} per ghost)\n`);

    // The server's connection node shows the client's newest ack: about an RTT behind its tick.
    const acked = [...server._query([Connection])].map((r) => (r.connection as { lastAckedTick: number }).lastAckedTick)[0];
    const tick = server.time.network!.tick;
    expect(acked).toBe(peer.lastAckedTick);
    expect(tick - acked).toBeGreaterThanOrEqual(2);
    expect(tick - acked).toBeLessThanOrEqual(8);
    step(engine, 10);
    expect(peer.lastAckedTick).toBeGreaterThan(acked);
  });

  it("fits snapshots to the budget, sending the rest in later ones", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 10 }));
    const server = world(engine, "Server");
    step(engine, 5);
    configureReplication(server, { maxSnapshotBytes: 300 });
    inWorld(server, () => {
      for (let i = 0; i < 100; i++) GameObject.instantiate("prefabs/crate.json", { position: [i, 0, 0] });
    });
    step(engine, 2);
    const peer = netSession(server)!.openPeers()[0];
    expect(serverReplication(server)!.peerState(peer)!.lastBytes).toBeLessThanOrEqual(300);
    expect(ghosts(world(engine, "P1")).size).toBeLessThan(100);
    step(engine, 120);
    expect(ghosts(world(engine, "P1")).size).toBe(100);
    expect([...ghosts(world(engine, "P1")).values()].map((n) => n.transform!.position.x).sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("tells each client which ghosts it owns", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const p1Id = clientReplication(world(engine, "P1"))!.session.serverPeer!.id;
    const crate = inWorld(server, () => GameObject.instantiate("prefabs/crate.json"));
    inWorld(server, () => {
      const rep = crate.getBehavior(Replicated)!;
      rep.ownerId = p1Id;
      rep.mode = "predicted";
    });
    step(engine, 30);
    expect(Replicated.isOwnedLocally(crate)).toBe(false); // the server doesn't own it any more
    const mine = [...ghosts(world(engine, "P1")).values()][0].getBehavior(Replicated)!;
    const theirs = [...ghosts(world(engine, "P2")).values()][0].getBehavior(Replicated)!;
    expect(mine).toMatchObject({ ownerId: p1Id, mode: "predicted", isOwnedLocally: true, isPredictedLocally: true });
    expect(theirs).toMatchObject({ ownerId: p1Id, isOwnedLocally: false, isPredictedLocally: false });
  });

  it("forgets ghosts when the connection goes: instantiated ones are destroyed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientsAndServer(1, { latencyMs: 10 }, ["scenes/arena.scene.json"]));
    const server = world(engine, "Server");
    step(engine, 10);
    inWorld(server, () => GameObject.instantiate("prefabs/crate.json"));
    step(engine, 20);
    const client = world(engine, "P1");
    expect(ghosts(client).size).toBe(4);
    engine.findWorld("Server")!.destroy();
    step(engine, 20);
    expect(ghosts(client).size).toBe(0);
    expect(client.activeScene!.children.map((c) => c.name)).toEqual(["Floor", "Door", "Group", "Crate"]); // the scene's own nodes stay
  });
});

describe("per-World components (T11)", () => {
  it("aren't created in Worlds whose tags they exclude, at scene load, from prefabs or with addBehavior", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const engine = await create({
      worlds: [
        { name: "Client", tags: ["client"], scenes: ["scenes/split.scene.json"] },
        { name: "Server", tags: ["server"], scenes: ["scenes/split.scene.json"] },
        { name: "Solo", scenes: ["scenes/split.scene.json"] },
      ],
    });
    const has = (w: string, node: string) => {
      const n = world(engine, w).activeScene!.find(node)!;
      return {
        mover: !!n.getBehavior(Mover),
        clientOnly: !!n.getBehavior(ClientOnly),
        stats: !!n.getBehavior(Stats),
        secret: n.hasData(Secret),
      };
    };
    expect(has("Server", "Brain")).toEqual({ mover: true, clientOnly: false, stats: false, secret: true });
    expect(has("Client", "Brain")).toEqual({ mover: false, clientOnly: true, stats: true, secret: false });
    expect(has("Solo", "Brain")).toEqual({ mover: false, clientOnly: false, stats: false, secret: false });
    // Overrides aimed at a skipped component are skipped too, not errors.
    expect(world(engine, "Server").activeScene!.find("Ball")!.getBehavior(Mover)).toMatchObject({ speed: 2, enabled: false });
    expect(world(engine, "Client").activeScene!.find("Ball")!.getBehavior(Mover)).toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/"test\.repl\.Mover" isn't created in World "Client": it's for Worlds tagged "server"/));

    // addBehavior hands back a detached instance that never runs.
    const client = world(engine, "Client");
    const node = inWorld(client, () => GameObject.create("Runtime"));
    const mover = node.addBehavior(Mover, { speed: 3 });
    expect(mover.speed).toBe(3);
    expect(mover.node).toBe(node);
    expect(node.getBehavior(Mover)).toBeNull();
    step(engine, 3);
    expect(node.transform!.position.x).toBe(0);
    // Built-ins and unrestricted components work everywhere.
    expect(world(engine, "Solo").activeScene!.find("Ball")!.getBehavior(Replicated)).not.toBeNull();
  });
});

// Fixes from the wave 3 review.
Assets.addSource(
  Assets.fromObject({
    "scenes/yard.scene.json": {
      format: "tranquility.scene@1",
      nodes: [{ id: "projectiles", name: "Projectiles", components: [transformOf(10, 0)] }],
    },
  }),
);

describe("wave 3 review fixes", () => {
  it("keeps a predicted ghost's state history bounded", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const p1Id = clientReplication(world(engine, "P1"))!.session.serverPeer!.id;
    const crate = inWorld(server, () => GameObject.instantiate("prefabs/crate.json"));
    inWorld(server, () => Object.assign(crate.getBehavior(Replicated)!, { ownerId: p1Id, mode: "predicted" }));
    step(engine, 1200); // 20 s: one state a tick if never pruned
    const [g] = clientReplication(world(engine, "P1"))!.ghosts.values();
    expect(g.states.length).toBeLessThan(20);
  });

  it("spawns a prefab under a plain scene parent in the same place on clients", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }, ["scenes/yard.scene.json"]));
    const server = world(engine, "Server");
    step(engine, 10);
    const container = server.sceneNodes[0].children.find((c) => c.name === "Projectiles")!;
    const crate = inWorld(server, () => GameObject.instantiate("prefabs/crate.json", { parent: container, position: [1, 0, 0] }));
    step(engine, 60);
    expect(crate.transform!.worldPosition.x).toBeCloseTo(11);
    const [ghost] = ghosts(world(engine, "P1")).values();
    expect(ghost.parent!.name).toBe("Projectiles");
    world(engine, "P1")._propagateTransforms();
    expect(ghost.transform!.worldPosition.x).toBeCloseTo(11, 2);
  });

  it("reads Move.of(playerNode) through the player's ownerId", async () => {
    const Steer = defineInput("test.review.Steer", { x: f32 });
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const p1Id = clientReplication(world(engine, "P1"))!.session.serverPeer!.id;
    const player = inWorld(server, () => GameObject.instantiate("prefabs/crate.json"));
    inWorld(server, () => (player.getBehavior(Replicated)!.ownerId = p1Id));
    defineSystem({ name: "test.review.steer", phase: "fixedUpdate", worlds: ["client"], run: () => Steer.write({ x: 0.5 }) });
    step(engine, 60);
    expect(inWorld(server, () => Steer.of(player))?.x).toBe(0.5);
  });

  it("decodes a ghost whose components this end doesn't know, and ignores them", async () => {
    const { layoutOf } = await import("../net/replication/layout");
    const { createBitReader, createBitWriter } = await import("../net/codec");
    const layout = layoutOf({
      transform: false,
      data: [{ id: "test.review.Unknown", fields: [{ kind: "f32", quantize: 0 }, { kind: "i32", quantize: 0 }] }],
      behaviors: [{ id: "test.review.UnknownBehavior", index: 0, fields: [{ kind: "u8", quantize: 0 }] }],
    });
    expect(layout.size).toBe(2 + 2 + 1); // ownerId, mode, then the unknown parts' fields
    const w = createBitWriter();
    layout.codec.write(w, { 0: 3, 1: 0, 2: 1.5, 3: -4, 4: 1 } as Record<string, number>);
    expect(layout.codec.read(createBitReader(w.finish()))).toEqual({ 0: 3, 1: 0, 2: 1.5, 3: -4, 4: 1 });
  });

  it("starts a reconnecting client's timeline afresh, so a restarted server gets its inputs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const Push = defineInput("test.review.Push", { x: f32 });
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    step(engine, 1200); // the client's timeline is ~1200 ticks on
    expect(world(engine, "P1").time.network!.serverTick).toBeGreaterThan(1000);
    engine.findWorld("Server")!.destroy();
    step(engine, 5);
    const restarted = engine.createWorld({ name: "Server2", tags: ["server"] });
    engine.findWorld("P1")!.connect(restarted, "loopback", { now, latencyMs: 20 });
    defineSystem({ name: "test.review.push", phase: "fixedUpdate", worlds: ["client"], run: () => Push.write({ x: 1 }) });
    step(engine, 60);
    const net = world(engine, "P1").time.network!;
    expect(net.serverTick).toBeLessThan(100);
    const server2 = world(engine, "Server2");
    const conn = netSession(server2)!.openPeers()[0].node!;
    expect(inWorld(server2, () => Push.of(conn))?.x).toBe(1);
  });

  it("times out a connection that never finishes its handshake, and one that goes quiet", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientsAndServer(1, { latencyMs: 20, address: "review:timeouts" }));
    step(engine, 10);
    // Someone opens a connection and never says hello.
    const { createTransport } = await import("../net/Transport");
    const raw = createTransport("loopback", { now });
    const link = raw.connect("review:timeouts");
    step(engine, 6 * 60);
    const events = raw.poll();
    expect(events.find((e) => e.kind === "close")).toMatchObject({ reason: expect.stringMatching(/handshake didn't finish/) });
    expect(link.state).toBe("closed");
    raw.close();
    // The server stops answering (paused): the client gives up after the idle timeout.
    engine.findWorld("Server")!.pause();
    step(engine, 16 * 60);
    expect(netSession(world(engine, "P1"))!.closed.at(-1)?.reason).toMatch(/Nothing arrived/);
  });

  it("refuses connections past maxConnections", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientsAndServer(2, { latencyMs: 10, maxConnections: 1 }));
    step(engine, 30);
    const reasons = ["P1", "P2"].map((n) => netSession(world(engine, n))!.closed.at(-1)?.reason ?? "open");
    expect(reasons.filter((r) => /is full/.test(r))).toHaveLength(1);
    expect(netSession(world(engine, "Server"))!.openPeers()).toHaveLength(1);
  });

  it("removeBehavior on a component kept out of the World does nothing", async () => {
    const engine = await create(clientsAndServer(1));
    const p1 = world(engine, "P1");
    const node = inWorld(p1, () => GameObject.create("n"));
    const mover = node.addBehavior(Mover); // server-only: a detached stand-in here
    expect(() => node.removeBehavior(mover)).not.toThrow();
    step(engine, 2);
    expect(node.getBehavior(Mover)).toBeNull();
  });
});
