import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Assets,
  Engine,
  GameBehavior,
  GameObject,
  Interest,
  Replicated,
  behavior,
  defineComponent,
  f32,
  field,
  replicate,
  type BootstrapConfig,
  type LinkConfig,
} from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";
import { serverReplication } from "../net/replication/server";

// ADR 0121: interest management (relevancy by distance and group), components' enabled state,
// sibling order and components added or removed after a ghost was first seen. Loopback on a fake
// clock that advances with `engine.step`, as in replicationStructure.test.ts.

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

@behavior("test.interest.Glow")
class Glow extends GameBehavior {
  @field(Number, { replicate: true }) power = 1;
}

@behavior("test.interest.Tag")
class Tag extends GameBehavior {
  @field(String, { replicate: true }) label = "";
}

const Armor = defineComponent("test.interest.Armor", { value: f32 });
replicate(Armor);

const transformOf = (x: number, y = 0) => ({ type: "engine.Transform", data: { position: [x, y, 0] } });

Assets.addSource(
  Assets.fromObject({
    "prefabs/interest/crate.json": {
      format: "myco.scene@1",
      nodes: [{ id: "crate", name: "Crate", components: [{ type: "net.Replicated" }, transformOf(0)] }],
    },
    "prefabs/interest/lantern.json": {
      format: "myco.scene@1",
      nodes: [{ id: "lantern", name: "Lantern", components: [{ type: "net.Replicated" }, { type: "test.interest.Glow" }, { type: "test.interest.Tag", data: { label: "hi" } }, transformOf(0)] }],
    },
    "prefabs/interest/tank.json": {
      format: "myco.scene@1",
      nodes: [
        { id: "tank", name: "Tank", components: [{ type: "net.Replicated" }, transformOf(0)] },
        { id: "turret", name: "Turret", parent: "tank", components: [{ type: "net.Replicated" }, transformOf(0, 1)] },
      ],
    },
    "scenes/interest.scene.json": {
      format: "myco.scene@1",
      nodes: [
        { id: "shelf", name: "Shelf", components: [transformOf(20, 0)] },
        { id: "lamp", name: "Lamp", components: [{ type: "net.Replicated", data: { relevantDistance: 10 } }, transformOf(-3, 0)] },
      ],
    },
  }),
);

const CRATE = "prefabs/interest/crate.json";
const LANTERN = "prefabs/interest/lantern.json";
const TANK = "prefabs/interest/tank.json";

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

function clientsAndServer(count: number, options: Record<string, unknown> = {}): BootstrapConfig {
  const scenes = ["scenes/interest.scene.json"];
  const names = Array.from({ length: count }, (_, i) => `P${i + 1}`);
  const links: LinkConfig[] = names.map((n, i) => ({ from: n, to: "Server", transport: "loopback", options: { now, random: sequenceRandom(0.11 + i * 0.2), ...options } }));
  return { worlds: [...names.map((name) => ({ name, tags: ["client"], scenes })), { name: "Server", tags: ["server"], scenes }], links };
}

const world = (engine: Engine, name: string) => engine._world(name)!;
const inWorld = <T>(w: World, fn: () => T): T => World._runIn(w, fn);

/** The server's `index`-th open connection node. */
function connectionOf(engine: Engine, index: number): GameObject {
  const peers = netSession(world(engine, "Server"))!.openPeers();
  return peers[index].node!;
}

const connectionId = (engine: Engine, index: number) => netSession(world(engine, "Server"))!.openPeers()[index].id;

/** Ghosts a client World shows (valid, active nodes). */
const shownGhosts = (client: World) => client._componentsOfType(Replicated).filter((r) => r.isGhost && r.node.isValid && r.node.activeInHierarchy).length;

/** The client node of the server node `node`'s ghost, or null. */
function ghostIn(client: World, node: GameObject): GameObject | null {
  const id = node.getBehavior(Replicated)!.ghostId;
  for (const rep of client._componentsOfType(Replicated)) if (rep.isGhost && rep.ghostId === id && rep.node.isValid) return rep.node;
  return null;
}

function spawn(server: World, path: string, x: number, setup?: (rep: Replicated) => void): GameObject {
  return inWorld(server, () => {
    const node = GameObject.instantiate(path, { position: [x, 0, 0] });
    setup?.(node.getBehavior(Replicated)!);
    return node;
  });
}

function moveTo(server: World, node: GameObject, x: number): void {
  inWorld(server, () => {
    node.transform!.position.x = x;
  });
}

describe("relevancy by group (ADR 0121)", () => {
  it("sends a grouped ghost only to connections in its group, and takes it away when they leave", async () => {
    const errors = vi.spyOn(console, "error");
    const engine = await create(clientsAndServer(2, { latencyMs: 30, jitterMs: 5, loss: 0.15 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const marker = spawn(server, CRATE, 1, (r) => (r.group = "red"));
    const open = spawn(server, CRATE, 2);
    inWorld(server, () => Interest.join(connectionOf(engine, 0), "red"));
    step(engine, 60);
    const p1 = world(engine, "P1"), p2 = world(engine, "P2");
    expect(ghostIn(p1, marker)).not.toBeNull();
    expect(ghostIn(p2, marker)).toBeNull();
    expect(ghostIn(p2, open)).not.toBeNull();
    expect(Interest.isRelevant(connectionOf(engine, 0), marker)).toBe(true);
    expect(Interest.isRelevant(connectionOf(engine, 1), marker)).toBe(false);
    expect(Interest.groups(connectionOf(engine, 0))).toEqual(["red"]);

    inWorld(server, () => {
      Interest.join(connectionOf(engine, 1), "red");
      Interest.leave(connectionOf(engine, 0), "red");
    });
    step(engine, 60);
    expect(ghostIn(p1, marker)).toBeNull();
    expect(shownGhosts(p1)).toBe(1); // only `open` is left
    expect(ghostIn(p2, marker)).not.toBeNull();

    // Back again: spawned afresh, at its current position.
    moveTo(server, marker, 7);
    inWorld(server, () => Interest.join(connectionOf(engine, 0), "red"));
    step(engine, 60);
    expect(ghostIn(p1, marker)!.transform!.position.x).toBeCloseTo(7, 2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("always sends a ghost to its owner, and a group-per-player ghost only to that player", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const id1 = connectionId(engine, 0);
    const mine = spawn(server, CRATE, 0, (r) => {
      r.ownerId = id1;
      r.group = "nobody";
    });
    const privateNote = spawn(server, CRATE, 0, (r) => (r.group = `player:${id1}`));
    inWorld(server, () => Interest.join(connectionOf(engine, 0), `player:${id1}`));
    step(engine, 60);
    expect(ghostIn(world(engine, "P1"), mine)).not.toBeNull();
    expect(ghostIn(world(engine, "P1"), privateNote)).not.toBeNull();
    expect(ghostIn(world(engine, "P2"), mine)).toBeNull();
    expect(ghostIn(world(engine, "P2"), privateNote)).toBeNull();
  });

  it("checks its arguments", async () => {
    const engine = await create(clientsAndServer(1));
    step(engine, 10);
    const client = world(engine, "P1");
    const clientConnection = netSession(client)!.serverPeer!.node!;
    expect(() => Interest.join(clientConnection, "red")).toThrow(/isn't a network server/);
    expect(() => Interest.join(connectionOf(engine, 0), "")).toThrow(/empty/);
  });
});

describe("relevancy by distance (ADR 0121)", () => {
  it("sends a distance-limited ghost to connections whose owned ghosts are near, with hysteresis on leaving", async () => {
    const engine = await create(clientsAndServer(2, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const [id1, id2] = [connectionId(engine, 0), connectionId(engine, 1)];
    spawn(server, CRATE, 5, (r) => (r.ownerId = id1));
    const player2 = spawn(server, CRATE, 50, (r) => (r.ownerId = id2));
    const coin = spawn(server, CRATE, 0, (r) => (r.relevantDistance = 10));
    step(engine, 40);
    const p1 = world(engine, "P1"), p2 = world(engine, "P2");
    expect(ghostIn(p1, coin)).not.toBeNull();
    expect(ghostIn(p2, coin)).toBeNull();
    expect(ghostIn(p2, player2)).not.toBeNull(); // its own

    moveTo(server, player2, 9);
    step(engine, 30);
    expect(ghostIn(p2, coin)).not.toBeNull();
    moveTo(server, player2, 10.5); // beyond 10 but within the 10% hysteresis
    step(engine, 30);
    expect(ghostIn(p2, coin)).not.toBeNull();
    moveTo(server, player2, 12);
    step(engine, 30);
    expect(ghostIn(p2, coin)).toBeNull();
    moveTo(server, player2, 10.5); // entering needs the distance itself
    step(engine, 30);
    expect(ghostIn(p2, coin)).toBeNull();
  });

  it("measures from the viewer set with Interest.setViewer; a connection with no viewpoint sees only unlimited ghosts", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const coin = spawn(server, CRATE, 100, (r) => (r.relevantDistance = 5));
    step(engine, 30);
    const p1 = world(engine, "P1");
    expect(ghostIn(p1, coin)).toBeNull(); // no owned ghost, no viewer
    const camera = inWorld(server, () => {
      const c = GameObject.create("Camera");
      c.transform!.position.x = 98;
      return c;
    });
    inWorld(server, () => Interest.setViewer(connectionOf(engine, 0), camera));
    step(engine, 30);
    expect(ghostIn(p1, coin)).not.toBeNull();
    expect(Interest.viewer(connectionOf(engine, 0))).toBe(camera);
    inWorld(server, () => Interest.setViewer(connectionOf(engine, 0), null));
    step(engine, 30);
    expect(ghostIn(p1, coin)).toBeNull();
  });

  it("deactivates a scene ghost that leaves, brings it back up to date, and destroys it if it's destroyed meanwhile", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const id1 = connectionId(engine, 0);
    const player = spawn(server, CRATE, 0, (r) => (r.ownerId = id1));
    const lamp = server.activeScene!.find("Lamp")!; // relevantDistance 10, at x = -3
    step(engine, 40);
    const p1 = world(engine, "P1");
    const clientLamp = p1.activeScene!.find("Lamp")!;
    expect(clientLamp.getBehavior(Replicated)!.isGhost).toBe(true);
    expect(clientLamp.active).toBe(true);

    moveTo(server, player, 30);
    step(engine, 40);
    expect(clientLamp.isValid).toBe(true);
    expect(clientLamp.active).toBe(false);

    moveTo(server, lamp, 25);
    step(engine, 40);
    expect(clientLamp.active).toBe(true);
    expect(clientLamp.transform!.position.x).toBeCloseTo(25, 2);

    moveTo(server, player, -50);
    step(engine, 40);
    expect(clientLamp.active).toBe(false);
    inWorld(server, () => GameObject.destroy(lamp));
    step(engine, 40);
    expect(clientLamp.isValid).toBe(false);
  });

  it("takes a ghost's child ghosts with it, and matches them again when it comes back", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20, loss: 0.1 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const id1 = connectionId(engine, 0);
    const player = spawn(server, CRATE, 0, (r) => (r.ownerId = id1));
    const tank = spawn(server, TANK, 3, (r) => (r.relevantDistance = 8));
    const turret = tank.find("Turret")!;
    // A crate parented under the turret follows the tank, though it has no limit of its own.
    const rider = spawn(server, CRATE, 0);
    inWorld(server, () => rider.setParent(turret));
    step(engine, 60);
    const p1 = world(engine, "P1");
    expect(ghostIn(p1, tank)).not.toBeNull();
    expect(ghostIn(p1, turret)).not.toBeNull();
    expect(ghostIn(p1, rider)!.parent!.name).toBe("Turret");

    moveTo(server, player, 40);
    step(engine, 60);
    expect(ghostIn(p1, tank)).toBeNull();
    expect(ghostIn(p1, turret)).toBeNull();
    expect(ghostIn(p1, rider)).toBeNull();
    expect(shownGhosts(p1)).toBe(1); // the player (the scene's lamp left too, deactivated)

    moveTo(server, player, 0);
    step(engine, 60);
    expect(ghostIn(p1, tank)).not.toBeNull();
    expect(ghostIn(p1, turret)!.parent).toBe(ghostIn(p1, tank));
    expect(ghostIn(p1, rider)!.parent!.name).toBe("Turret");
  });

  it("resends a ghost's string fields when it comes back", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const lantern = spawn(server, LANTERN, 0, (r) => (r.group = "g"));
    inWorld(server, () => Interest.join(connectionOf(engine, 0), "g"));
    step(engine, 40);
    const p1 = world(engine, "P1");
    expect(ghostIn(p1, lantern)!.getBehavior(Tag)!.label).toBe("hi");
    inWorld(server, () => Interest.leave(connectionOf(engine, 0), "g"));
    step(engine, 40);
    expect(ghostIn(p1, lantern)).toBeNull();
    inWorld(server, () => {
      Interest.join(connectionOf(engine, 0), "g");
    });
    step(engine, 40);
    expect(ghostIn(p1, lantern)!.getBehavior(Tag)!.label).toBe("hi");
  });

  it("filters before the byte budget: irrelevant ghosts cost nothing", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    for (let i = 0; i < 50; i++) spawn(server, CRATE, i, (r) => (r.group = "far"));
    step(engine, 40);
    const peer = netSession(server)!.openPeers()[0];
    const ps = serverReplication(server)!.peerState(peer)!;
    expect(ps.known.size).toBe(0); // the scene's lamp is distance-limited and the connection has no viewpoint
    expect(ps.lastBytes).toBeLessThan(12);
  });
});

describe("components' enabled state (ADR 0121)", () => {
  it("replicates enabling and disabling a behavior with replicated fields, for a late joiner too", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 30, loss: 0.2 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const lantern = spawn(server, LANTERN, 0);
    step(engine, 60);
    const p1 = world(engine, "P1");
    expect(ghostIn(p1, lantern)!.getBehavior(Glow)!.enabled).toBe(true);
    inWorld(server, () => (lantern.getBehavior(Glow)!.enabled = false));
    step(engine, 60);
    expect(ghostIn(p1, lantern)!.getBehavior(Glow)!.enabled).toBe(false);

    const late = engine.createWorld({ name: "Late", tags: ["client"], scenes: ["scenes/interest.scene.json"] });
    late.connect(engine.findWorld("Server")!, "loopback", { now, latencyMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    step(engine, 60);
    expect(ghostIn(world(engine, "Late"), lantern)!.getBehavior(Glow)!.enabled).toBe(false);

    inWorld(server, () => (lantern.getBehavior(Glow)!.enabled = true));
    step(engine, 60);
    expect(ghostIn(p1, lantern)!.getBehavior(Glow)!.enabled).toBe(true);
    expect(ghostIn(world(engine, "Late"), lantern)!.getBehavior(Glow)!.enabled).toBe(true);
  });
});

describe("sibling order (ADR 0121)", () => {
  it("orders ghosts among their sibling ghosts as on the server", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20, loss: 0.15 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const shelf = server.activeScene!.find("Shelf")!;
    const crates = [0, 1, 2].map((i) => spawn(server, CRATE, i));
    inWorld(server, () => crates.forEach((c) => c.setParent(shelf)));
    step(engine, 60);
    const p1 = world(engine, "P1");
    const order = () => p1.activeScene!.find("Shelf")!.children.map((c) => c.getBehavior(Replicated)?.ghostId);
    const ids = crates.map((c) => c.getBehavior(Replicated)!.ghostId);
    expect(order()).toEqual(ids);

    inWorld(server, () => server._setSiblingIndex(crates[2].entity, 0));
    step(engine, 60);
    expect(order()).toEqual([ids[2], ids[0], ids[1]]);
    inWorld(server, () => server._setSiblingIndex(crates[0].entity, 2));
    step(engine, 60);
    expect(order()).toEqual([ids[2], ids[1], ids[0]]);
  });
});

describe("components added or removed after spawn (ADR 0121)", () => {
  it("sends data components and behaviors added later, and removes ones taken off", async () => {
    const errors = vi.spyOn(console, "error");
    const engine = await create(clientsAndServer(1, { latencyMs: 30, jitterMs: 5, loss: 0.2 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const crate = spawn(server, CRATE, 0);
    step(engine, 60);
    const p1 = world(engine, "P1");
    expect(ghostIn(p1, crate)!.getData(Armor)).toBeNull();

    inWorld(server, () => {
      crate.addData(Armor, { value: 12 });
      crate.addBehavior(Glow).power = 3;
    });
    step(engine, 60);
    const ghost = ghostIn(p1, crate)!;
    expect(ghost.getData(Armor)!.value).toBe(12);
    expect(ghost.getBehavior(Glow)!.power).toBe(3);

    inWorld(server, () => {
      crate.getData(Armor)!.value = 20;
      crate.getBehavior(Glow)!.power = 5;
    });
    step(engine, 60);
    expect(ghost.getData(Armor)!.value).toBe(20);
    expect(ghost.getBehavior(Glow)!.power).toBe(5);

    inWorld(server, () => {
      crate.removeData(Armor);
      crate.removeBehavior(crate.getBehavior(Glow)!);
    });
    step(engine, 60);
    expect(ghost.getData(Armor)).toBeNull();
    expect(ghost.getBehavior(Glow)).toBeNull();
    // Still replicating.
    moveTo(server, crate, 4);
    step(engine, 60);
    expect(ghost.transform!.position.x).toBeCloseTo(4, 2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("gives a late joiner the components as they are now: added ones added, removed ones removed", async () => {
    const engine = await create(clientsAndServer(1, { latencyMs: 20 }));
    const server = world(engine, "Server");
    step(engine, 10);
    const lantern = spawn(server, LANTERN, 0);
    const crate = spawn(server, CRATE, 1);
    inWorld(server, () => {
      lantern.removeBehavior(lantern.getBehavior(Glow)!);
      crate.addBehavior(Glow).power = 9;
    });
    step(engine, 30);
    const late = engine.createWorld({ name: "Late", tags: ["client"], scenes: ["scenes/interest.scene.json"] });
    late.connect(engine.findWorld("Server")!, "loopback", { now, latencyMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    step(engine, 60);
    const lateWorld = world(engine, "Late");
    expect(ghostIn(lateWorld, lantern)!.getBehavior(Glow)).toBeNull();
    expect(ghostIn(lateWorld, lantern)!.getBehavior(Tag)).not.toBeNull(); // no replicated numbers: left alone
    expect(ghostIn(lateWorld, crate)!.getBehavior(Glow)!.power).toBe(9);
  });
});
