// ADR 0311: the network session answers a World's net questions: which connection owns a node,
// which tick predicted systems simulate, and whether a ghost is relevant to a connection. Input
// streams, Interest, Replicated and the scheduler ask it.
//
// This file imports the modules it tests one by one (no "myco" index, no Engine) and makes its
// Worlds directly, so it also shows that none of them relies on another being loaded first.
import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, i32 } from "../core/data";
import { defineSystem } from "../core/systems";
import { World } from "../core/World";
import { defineInput } from "../net/input";
import { Interest } from "../net/interest";
import { isResimulating, predictedTick } from "../net/prediction";
import { Replicated } from "../net/Replicated";
import { connectWorlds, netSession } from "../net/session";
import { GameObject } from "../scene/GameObject";

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const worlds: World[] = [];

afterEach(() => {
  for (const w of worlds.splice(0)) netSession(w)?.close();
});

function make(name: string, tag: string): World {
  const world = new World("runtime", {}, { name, tags: [tag] });
  worlds.push(world);
  return world;
}

function step(frames: number, ...list: World[]): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    for (const w of list) w.step(DT);
  }
}

const Aim = defineInput("test.session.Aim", { x: i32 });
const Mover = defineComponent("test.session.Mover", { x: i32 });

async function connected(tag: string): Promise<{ client: World; server: World; id: number }> {
  const client = make(`${tag}Client`, `${tag}-client`);
  const server = make(`${tag}Server`, `${tag}-server`);
  await connectWorlds(client, server, "loopback", { now, latencyMs: 20 });
  step(60, client, server);
  const peer = netSession(client)!.serverPeer!;
  expect(peer.state).toBe("open");
  return { client, server, id: peer.id };
}

describe("the network session answers net questions (ADR 0311)", () => {
  it("says which connection owns a node, for input streams and Replicated on both ends", async () => {
    const { client, server, id } = await connected("own");
    const serverSession = netSession(server)!;
    const connection = serverSession.openPeer(id)!;
    expect(serverSession.ownerPeer(id)).toBe(connection);
    expect(serverSession.ownerPeer(0)).toBeNull();
    expect(serverSession.ownsLocally(0)).toBe(true);
    expect(serverSession.ownsLocally(id)).toBe(false);
    expect(netSession(client)!.ownsLocally(id)).toBe(true);
    expect(netSession(client)!.ownsLocally(id + 1)).toBe(false);

    // A node the client owns: the server reads that client's input through it, and so does the client.
    const make = (w: World, ownerId: number) =>
      World._runIn(w, () => {
        const node = GameObject.create("Player");
        node.addBehavior(Replicated).ownerId = ownerId;
        return node;
      });
    const onServer = make(server, id);
    const onClient = make(client, id);
    const unowned = make(server, 0);
    World._runIn(client, () => Aim.write({ x: 7 }));
    step(10, client, server);
    expect(World._runIn(server, () => Aim.of(onServer))).toEqual({ x: 7 });
    expect(World._runIn(server, () => Aim.of(unowned))).toBeNull();
    expect(World._runIn(client, () => Aim.of(onClient))).toEqual({ x: 7 });
    expect(World._runIn(server, () => onServer.getBehavior(Replicated)!.isOwnedLocally)).toBe(false);
    expect(World._runIn(client, () => onClient.getBehavior(Replicated)!.isOwnedLocally)).toBe(true);
  });

  it("says which tick is simulated while prediction replays one, and input streams return that tick's input", async () => {
    const { client } = await connected("tick");
    const session = netSession(client)!;
    const node = session.serverPeer!.node!;
    const written = new Map<number, number>();
    defineSystem({
      name: "test.session.tick.write",
      phase: "fixedUpdate",
      worlds: ["tick-client"],
      run: (_rows, { world }) => {
        const tick = world.time.network!.serverTick;
        written.set(tick, tick % 5);
        Aim.write({ x: tick % 5 });
      },
    });
    step(20, client);
    const serverTick = client.time.network!.serverTick;
    expect(predictedTick(client)).toBe(serverTick);
    expect(session.simulatedTick).toBe(serverTick);
    const past = serverTick - 6;
    const seen = session.replay(past, () => ({ tick: predictedTick(client), input: World._runIn(client, () => Aim.of(node)?.x), resim: isResimulating(client) }));
    expect(written.get(past)).toBeTypeOf("number");
    expect(seen).toEqual({ tick: past, input: written.get(past), resim: false });
    expect(session.replayTick).toBeNull();
    expect(predictedTick(client)).toBe(serverTick);
  });

  it("keeps a connection's interest on the connection, and answers relevance only for ghosts it was sent", async () => {
    const { server, id } = await connected("interest");
    const connection = netSession(server)!.openPeer(id)!.node!;
    Interest.join(connection, "red");
    expect(Interest.groups(connection)).toEqual(["red"]);
    expect(Interest.inGroup(connection, "red")).toBe(true);
    const node = World._runIn(server, () => GameObject.create("NotAGhost"));
    expect(Interest.isRelevant(connection, node)).toBe(false);
    expect(() => Interest.join(server.root, "red")).toThrow(/isn't an open connection node/);
  });

  it("runs a client's predicted systems on the ghosts it predicts only, and a server's like any other", async () => {
    const { client, server } = await connected("pass");
    for (const w of [client, server]) World._runIn(w, () => GameObject.create("Mover").addData(Mover));
    const rows: Record<string, number> = {};
    defineSystem({
      name: "test.session.pass",
      phase: "fixedUpdate",
      predicted: true,
      query: [Mover],
      worlds: ["pass-client", "pass-server"],
      run: (found, ctx) => {
        rows[ctx.world.name] = (rows[ctx.world.name] ?? 0) + found.count;
      },
    });
    step(5, client, server);
    // The Mover node isn't a ghost the client predicts, so the client's passes have no rows.
    expect(rows[server.name]).toBe(5);
    expect(rows[client.name] ?? 0).toBe(0);
  });
});
