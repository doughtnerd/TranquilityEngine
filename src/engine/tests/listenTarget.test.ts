// ADR 0255: one listen target from the transport, the options and the host's overrides and defaults.
import { describe, expect, it } from "vitest";
import { listenTarget, parseListenAddress } from "../net/listenTarget";

describe("listen targets", () => {
  it("parses listen addresses", () => {
    expect(parseListenAddress(7777)).toEqual({ port: 7777, path: "/" });
    expect(parseListenAddress(":0")).toEqual({ port: 0, path: "/" });
    expect(parseListenAddress("7777/match/3")).toEqual({ port: 7777, path: "/match/3" });
    expect(parseListenAddress("ws://0.0.0.0:7777/game")).toEqual({ host: "0.0.0.0", port: 7777, path: "/game" });
    expect(parseListenAddress("localhost:9000")).toEqual({ host: "localhost", port: 9000, path: "/" });
    expect(() => parseListenAddress("wss://example.com:1")).toThrow(/only ws:\/\//);
  });

  it.each([
    ["a port", { port: 7777 }, {}, { port: 7777, path: "/", address: "7777" }],
    ["a port, host and path", { port: 7777, host: "127.0.0.1", path: "game" }, {}, { host: "127.0.0.1", port: 7777, path: "/game", address: "ws://127.0.0.1:7777/game" }],
    ["a path without a host (every interface)", { port: 7777, path: "/game" }, {}, { port: 7777, path: "/game", address: "7777/game" }],
    ["an IPv6 host", { port: 1, host: "::1" }, {}, { host: "::1", port: 1, path: "/", address: "ws://[::1]:1" }],
    ["an address, which wins over port, host and path", { address: "ws://10.0.0.1:9000/a", port: 1, host: "x", path: "/b" }, {}, { host: "10.0.0.1", port: 9000, path: "/a", address: "ws://10.0.0.1:9000/a" }],
    ["a client url's port and path", { url: "ws://example.com:9000/play" }, {}, { port: 9000, path: "/play", address: "9000/play" }],
    ["a port string with a path", { port: "7777/m" }, {}, { port: 7777, path: "/m", address: "7777/m" }],
    ["overrides, which win", { port: 7777, host: "10.0.0.1", path: "/game" }, { overrides: { port: 0, host: "127.0.0.1" } }, { host: "127.0.0.1", port: 0, path: "/game", address: "ws://127.0.0.1:0/game" }],
    ["overrides over an address", { address: "ws://10.0.0.1:9000/a" }, { overrides: { host: "127.0.0.1" } }, { host: "127.0.0.1", port: 9000, path: "/a", address: "ws://127.0.0.1:9000/a" }],
    ["defaults, which fill in", { path: "/match/1" }, { defaults: { port: 7777, host: "127.0.0.1" } }, { host: "127.0.0.1", port: 7777, path: "/match/1", address: "ws://127.0.0.1:7777/match/1" }],
    ["defaults under the options", { port: 9000, host: "0.0.0.0" }, { defaults: { port: 7777, host: "127.0.0.1" } }, { host: "0.0.0.0", port: 9000, path: "/", address: "ws://0.0.0.0:9000" }],
  ])("over websocket: %s", (_what, options, host, expected) => {
    expect(listenTarget("websocket", options, host)).toEqual({ transport: "websocket", ...expected });
  });

  it("has no target over a network transport without a port", () => {
    expect(listenTarget("websocket", { path: "/game", host: "127.0.0.1" })).toBeNull();
  });

  it("names loopback listens: an address or port as given, else made up per World, a path kept apart per Engine", () => {
    const host = { loopbackName: () => "engine-1/Server", loopbackPrefix: () => "engine-1", overrides: { port: 9 } };
    expect(listenTarget("loopback", { address: "arena" }, host)?.address).toBe("arena");
    expect(listenTarget("loopback", { port: "lobby", path: "m/2" }, host)?.address).toBe("lobby/m/2");
    expect(listenTarget("loopback", {}, host)?.address).toBe("engine-1/Server");
    expect(listenTarget("loopback", { path: "/match/3" }, host)?.address).toBe("engine-1/match/3");
  });

  it("throws for an address that isn't one", () => {
    expect(() => listenTarget("websocket", { address: "http://x:1" })).toThrow(/only ws:\/\//);
  });
});
