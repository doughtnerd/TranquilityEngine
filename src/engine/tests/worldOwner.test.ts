// ADR 0281: the network session, replication and lobbies reach a World's owner through the typed
// World-owner seam, so a fake owner stands in for a whole Engine here.
import { afterEach, describe, expect, it } from "vitest";
import "../../server/websocketServer"; // the Node "websocket" transport, which can listen
import { World } from "../core/World";
import type { ListenDefaults, WorldOwner } from "../core/worldOwner";
import type { WorldConfig } from "../core/worlds";
import { lobbyFromConfig, lobbyServerOf } from "../net/lobby/server";
import { serverReplication } from "../net/replication/server";
import { listenWorld, netSession } from "../net/session";

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) netSession(w)?.close();
});

/** An owner that knows one World's config and listen defaults; anything else is a mistake in the test. */
function fakeOwner(prefix: string, config: WorldConfig | null = null, defaults: Record<string, ListenDefaults> = {}): WorldOwner {
  const unused = (): never => {
    throw new Error("not used by this test");
  };
  return {
    createWorld: unused,
    _createFromTemplate: unused,
    _declaredBootstrap: null,
    findWorld: unused,
    worlds: unused,
    _world: unused,
    _handleOf: () => null,
    _worldConfig: (name) => (config?.name === name ? config : null),
    _destroyWorld: unused,
    _linkedServer: () => null,
    _listenDefaults: (transport) => defaults[transport],
    _setListenDefaults: unused,
    _loopbackPrefix: prefix,
    _viewStates: () => [],
    _handView: unused,
  };
}

function owned(name: string, owner: WorldOwner): World {
  const world = new World("server", {}, { name, tags: ["server"] });
  world._owner = owner;
  worlds.push(world);
  return world;
}

describe("the World-owner seam (ADR 0281)", () => {
  it("names a loopback listen under the owner's prefix", async () => {
    const world = owned("Arena", fakeOwner("owner-7"));
    await expect(listenWorld(world, "loopback")).resolves.toBe("owner-7/Arena");
  });

  it("fills a listen that gives no port from the owner's listen defaults", async () => {
    const without = owned("Bare", fakeOwner("owner-8"));
    expect(() => listenWorld(without, "websocket")).toThrow(/without an address/);
    const world = owned("Match", fakeOwner("owner-9", null, { websocket: { port: 0, host: "127.0.0.1" } }));
    await expect(listenWorld(world, "websocket", { path: "/match/1" })).resolves.toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/match\/1$/);
  });

  it("applies the replication settings of the config the owner created the World from", async () => {
    const world = owned("Server", fakeOwner("owner-10", { name: "Server", tags: ["server"], replication: { sendRate: 15 } }));
    await listenWorld(world, "loopback");
    expect(serverReplication(world)?.sendRate).toBe(15);
  });

  it("hosts the lobby the owner's config turns on, and none without one", () => {
    const lobby = owned("Lobby", fakeOwner("owner-11", { name: "Lobby", tags: ["server"], lobby: { matchTemplate: "Match" } }));
    expect(lobbyFromConfig(lobby)).not.toBeNull();
    expect(lobbyServerOf(lobby)).not.toBeNull();
    const plain = owned("Plain", fakeOwner("owner-12"));
    expect(lobbyFromConfig(plain)).toBeNull();
  });
});
