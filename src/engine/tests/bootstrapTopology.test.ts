// ADR 0256: one classification of a declarative bootstrap's network roles, read by the dedicated
// server, play mode and the Worlds panel.
import { describe, expect, it } from "vitest";
import { bootstrapTopology } from "../core/bootstrapTopology";
import type { BootstrapConfig } from "../core/worlds";

const names = (worlds: readonly { name: string }[]) => worlds.map((w) => w.name);

describe("bootstrap topology", () => {
  it("has none for no bootstrap, a code bootstrap or a value that isn't one", () => {
    expect(bootstrapTopology(undefined)).toBeNull();
    expect(bootstrapTopology("scripts/Bootstrap.ts")).toBeNull();
    expect(bootstrapTopology({} as BootstrapConfig)).toBeNull();
  });

  it("starts the start-up servers, with where each listens and which templates listen when created", () => {
    const t = bootstrapTopology({
      worlds: [{ name: "Game", tags: ["client"] }, { name: "Lobby", tags: ["server"] }, { name: "Menu" }],
      templates: { Arena: { name: "Arena 1", tags: ["server"] }, Bot: { tags: ["client"] } },
      links: [
        { from: "Game", to: "Lobby", transport: "websocket", options: { port: 7777 } },
        { from: "Lobby", to: "Arena 1", transport: "loopback" },
        { from: "Menu", to: "Arena 1", transport: "websocket", options: { port: 7778 } },
        { from: "Bot", to: "Arena 1", transport: "loopback" },
      ],
    })!;
    expect(names(t.serverStart)).toEqual(["Lobby"]);
    expect(t.skipped).toEqual(["Game", "Menu"]);
    expect(t.hostTemplate).toBeNull();
    expect(t.serverLinks.map((l) => `${l.from}>${l.to}`)).toEqual(["Lobby>Arena 1"]);
    expect(t.listenLinks.map((l) => `${l.from}>${l.to}`)).toEqual(["Game>Lobby"]);
    expect(t.spawnLinks.map((l) => `${l.from}>${l.to}`)).toEqual(["Menu>Arena 1", "Bot>Arena 1"]);
    expect(names(t.linkedClients)).toEqual(["Game"]);
    expect(t.copiedClient?.name).toBe("Game");
  });

  it("with no start-up server, starts the lobbies; without lobbies, the Host template only", () => {
    const lobby = bootstrapTopology({
      worlds: [{ name: "Menu" }],
      templates: { Match: { tags: ["server", "match"] }, Lobby: { tags: ["server"], lobby: { matchTemplate: "Match" } } },
    })!;
    expect(names(lobby.serverStart)).toEqual(["Lobby"]);
    expect(lobby.hostTemplate).toBeNull();

    // Two server templates: the first is the Host template, which play creates and the server starts;
    // the second stays Spawnable for game code, and a link to it says where it listens once created.
    const host = bootstrapTopology({
      worlds: [{ name: "Title" }, { name: "Client", tags: ["client"] }],
      templates: { Coop: { name: "Co-op", tags: ["server"] }, Versus: { tags: ["server"] } },
      links: [{ from: "Client", to: "Versus", transport: "websocket", options: { port: 7778 } }],
    })!;
    expect(host.hostTemplate?.key).toBe("Coop");
    expect(host.hostTemplate?.world.name).toBe("Co-op");
    expect(host.hostClient?.name).toBe("Client");
    expect(names(host.serverStart)).toEqual(["Co-op"]);
    expect(host.spawnLinks.map((l) => l.to)).toEqual(["Versus"]);
    expect(host.startUpLinked).toBe(false);
  });

  it("finds play's linked clients: start-up Worlds that connect to another and aren't connected to", () => {
    const t = bootstrapTopology({
      worlds: [{ name: "Host" }, { name: "Relay" }, { name: "P1" }, { name: "P2", tags: ["client"] }],
      links: [
        { from: "P1", to: "Relay", transport: "loopback" },
        { from: "P2", to: "Relay", transport: "loopback" },
        { from: "Relay", to: "Host", transport: "loopback" },
      ],
    })!;
    expect(names(t.linkedClients)).toEqual(["P1", "P2"]);
    expect(t.copiedClient?.name).toBe("P2");
    expect(t.startUpLinked).toBe(true);
    expect(t.serverStart).toEqual([]);
  });
});

// ADR 0281: the lobby is the one the dedicated server starts; Lobby.connect("local") runs the same.
describe("bootstrap topology: the lobby (ADR 0281)", () => {
  const lobby = { matchTemplate: "Match" };

  it("is the first World the server starts with a lobby config", () => {
    const fromTemplate = bootstrapTopology({ worlds: [{ name: "Menu" }], templates: { Match: { tags: ["server"] }, Lobby: { tags: ["server"], lobby } } })!;
    expect(fromTemplate.serverLobby?.name).toBe("Lobby");
    expect(fromTemplate.lobbyProblems).toEqual([]);
    const startUp = bootstrapTopology({ worlds: [{ name: "Menu" }, { name: "Hub", tags: ["server"], lobby }], templates: { Match: { tags: ["server"] } } })!;
    expect(startUp.serverLobby?.name).toBe("Hub");
    expect(bootstrapTopology({ worlds: [{ name: "Menu" }], templates: { Arena: { tags: ["server"] } } })!.serverLobby).toBeNull();
  });

  it("reports a lobby config no dedicated server would run: untagged, or on a template it doesn't start", () => {
    const untagged = bootstrapTopology({ worlds: [{ name: "Menu", lobby }], templates: { Lobby: { tags: ["lobby"], lobby } } })!;
    expect(untagged.serverLobby).toBeNull();
    expect(untagged.lobbyProblems).toEqual([
      expect.stringMatching(/^bootstrap\.worlds\[0\] \("Menu"\): a World with a "lobby" config must be tagged "server"/),
      expect.stringMatching(/^bootstrap\.templates\["Lobby"\]: a World with a "lobby" config must be tagged "server"/),
    ]);
    const unstarted = bootstrapTopology({ worlds: [{ name: "Game", tags: ["server"] }], templates: { Lobby: { tags: ["server"], lobby } } })!;
    expect(unstarted.serverLobby).toBeNull();
    expect(unstarted.lobbyProblems).toEqual([expect.stringMatching(/^bootstrap\.templates\["Lobby"\]: a dedicated server never starts this lobby.*"Game"/)]);
    // The dedicated server's own bootstrap: the lobby template started as a World of the same name.
    const serverOwn = bootstrapTopology({ worlds: [{ name: "Lobby", tags: ["server"], lobby }], templates: { Lobby: { tags: ["server"], lobby } } })!;
    expect(serverOwn.lobbyProblems).toEqual([]);
    expect(serverOwn.serverLobby?.name).toBe("Lobby");
  });
});
