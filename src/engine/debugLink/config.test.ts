// Where a build's debug link connects (ADR 0376): addresses in every accepted form, and `game.json`'s `debug` read
// leniently with a launch override.
import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_LINK, debugLinkAddress, readDebugManifest } from "./config";

describe("debug link addresses", () => {
  it("takes a WebSocket URL, host:port and a bare port", () => {
    expect(debugLinkAddress("ws://10.0.0.5:9000/x")).toBe("ws://10.0.0.5:9000/x");
    expect(debugLinkAddress("wss://example.com/myco-debug")).toBe("wss://example.com/myco-debug");
    expect(debugLinkAddress("192.168.1.4:7790")).toBe("ws://192.168.1.4:7790/myco-debug");
    expect(debugLinkAddress(" 7791 ")).toBe("ws://localhost:7791/myco-debug");
  });

  it("refuses what isn't one", () => {
    for (const bad of ["", "   ", "http://x:1", "99999", "ws://", "a b:c"]) expect(debugLinkAddress(bad)).toBeNull();
  });
});

describe("game.json's debug", () => {
  it("absent, null or false: no link", () => {
    for (const d of [undefined, null, false]) expect(readDebugManifest(d)).toEqual({ config: null, problems: [] });
  });

  it("reads the link and the webrtc option", () => {
    expect(readDebugManifest({ link: "ws://h:1/p" })).toEqual({ config: { link: "ws://h:1/p" }, problems: [] });
    expect(readDebugManifest({ link: "ws://h:1/p", webrtc: false }).config).toEqual({ link: "ws://h:1/p", webrtc: false });
    expect(readDebugManifest({ webrtc: { iceServers: [] } }).config).toEqual({ link: DEFAULT_DEBUG_LINK, webrtc: { iceServers: [] } });
  });

  it("falls back to the default with one problem per bad value", () => {
    expect(readDebugManifest(true)).toEqual({ config: { link: DEFAULT_DEBUG_LINK }, problems: [expect.stringContaining("should be an object")] });
    expect(readDebugManifest({ link: "nope://" })).toEqual({ config: { link: DEFAULT_DEBUG_LINK }, problems: [expect.stringContaining("isn't a WebSocket address")] });
    expect(readDebugManifest({ link: 4 }).problems).toEqual([expect.stringContaining("should be a WebSocket address")]);
    expect(readDebugManifest({ webrtc: "yes" })).toEqual({ config: { link: DEFAULT_DEBUG_LINK }, problems: [expect.stringContaining("webrtc")] });
  });

  it("a launch override wins over the manifest's link; a bad one keeps it", () => {
    expect(readDebugManifest({ link: "ws://a:1/" }, "b:2").config?.link).toBe("ws://b:2/myco-debug");
    expect(readDebugManifest({ link: "ws://a:1/" }, "")).toEqual({ config: { link: "ws://a:1/" }, problems: [] });
    expect(readDebugManifest({ link: "ws://a:1/" }, "http://x")).toEqual({ config: { link: "ws://a:1/" }, problems: [expect.stringContaining("launch")] });
    expect(readDebugManifest(undefined, "b:2").config).toBeNull(); // no debug, no link, whatever the launch says
  });
});

describe("game.json's debug listen, lan, port, rendezvous and iceServers", () => {
  const base = { link: "ws://h:1/p" };

  it("listen and lan: true or false are read; omitted keys stay absent", () => {
    expect(readDebugManifest({ ...base, listen: true, lan: false })).toEqual({ config: { link: "ws://h:1/p", listen: true, lan: false }, problems: [] });
    const omitted = readDebugManifest(base).config;
    expect(omitted).not.toHaveProperty("listen");
    expect(omitted).not.toHaveProperty("lan");
  });

  it("listen and lan: anything but a boolean is ignored with one problem line each", () => {
    for (const key of ["listen", "lan"] as const) {
      for (const bad of ["yes", 1, null]) {
        const r = readDebugManifest({ ...base, [key]: bad });
        expect(r.config).toEqual({ link: "ws://h:1/p" });
        expect(r.problems).toEqual([expect.stringContaining(`debug.${key} should be true or false`)]);
      }
    }
  });

  it("port: a whole number from 1 to 65526 is read at both ends; omitted stays absent", () => {
    expect(readDebugManifest({ ...base, port: 1 })).toEqual({ config: { link: "ws://h:1/p", port: 1 }, problems: [] });
    expect(readDebugManifest({ ...base, port: 65526 }).config).toEqual({ link: "ws://h:1/p", port: 65526 });
    expect(readDebugManifest(base).config).not.toHaveProperty("port");
  });

  it("port: out of range, fractional, or not a number is ignored with one problem line", () => {
    for (const bad of [0, 65527, 7790.5, "7790", NaN, -1]) {
      const r = readDebugManifest({ ...base, port: bad });
      expect(r.config).toEqual({ link: "ws://h:1/p" });
      expect(r.problems).toEqual([expect.stringContaining("debug.port should be a whole number from 1 to 65526")]);
    }
  });

  it("rendezvous: a ws:// or wss:// URL string is read; omitted stays absent", () => {
    expect(readDebugManifest({ ...base, rendezvous: "wss://rv.example.com/myco-rendezvous" })).toEqual({
      config: { link: "ws://h:1/p", rendezvous: "wss://rv.example.com/myco-rendezvous" },
      problems: [],
    });
    expect(readDebugManifest({ ...base, rendezvous: "ws://10.0.0.2:7000/myco-rendezvous" }).config?.rendezvous).toBe("ws://10.0.0.2:7000/myco-rendezvous");
    expect(readDebugManifest(base).config).not.toHaveProperty("rendezvous");
  });

  it("rendezvous: a non-string, a non-URL or another scheme is ignored with one problem line", () => {
    for (const bad of [4, "", "https://rv.example.com", "rv.example.com", "ws://", true]) {
      const r = readDebugManifest({ ...base, rendezvous: bad });
      expect(r.config).toEqual({ link: "ws://h:1/p" });
      expect(r.problems).toEqual([expect.stringContaining("debug.rendezvous should be a ws:// or wss:// URL")]);
    }
  });

  it("iceServers: valid entries are read as given, with optional username and credential; omitted stays absent", () => {
    const servers = [
      { urls: "stun:stun.example.com:3478" },
      { urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"], username: "u", credential: "c" },
    ];
    expect(readDebugManifest({ ...base, iceServers: servers })).toEqual({ config: { link: "ws://h:1/p", iceServers: servers }, problems: [] });
    expect(readDebugManifest({ ...base, iceServers: [] })).toEqual({ config: { link: "ws://h:1/p", iceServers: [] }, problems: [] });
    expect(readDebugManifest(base).config).not.toHaveProperty("iceServers");
  });

  it("iceServers: a value that isn't an array is ignored with one problem line", () => {
    const r = readDebugManifest({ ...base, iceServers: { urls: "stun:a:1" } });
    expect(r.config).toEqual({ link: "ws://h:1/p" });
    expect(r.problems).toEqual([expect.stringContaining("debug.iceServers should be an array")]);
  });

  it("iceServers: each bad entry is dropped with one problem line, the good ones kept", () => {
    const good = { urls: "stun:stun.example.com:3478" };
    const badEntries = [
      null,
      "stun:a:1",
      {},
      { urls: "http://x:1" },
      { urls: [] },
      { urls: ["stun:a:1", "https://x"] },
      { urls: "stun:a:1", username: 5 },
      { urls: "turn:a:1", credential: true },
    ];
    const r = readDebugManifest({ ...base, iceServers: [good, ...badEntries] });
    expect(r.config).toEqual({ link: "ws://h:1/p", iceServers: [good] });
    expect(r.problems).toHaveLength(badEntries.length);
    for (const p of r.problems) expect(p).toEqual(expect.stringContaining("debug.iceServers has an entry that isn't a STUN or TURN server"));
  });
});
