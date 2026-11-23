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
