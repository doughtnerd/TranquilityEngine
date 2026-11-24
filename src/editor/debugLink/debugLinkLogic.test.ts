// The editor's debug link without state (ADR 0376): preferences read leniently, where it listens per LAN setting,
// which remotes are this machine, and the menu's and prompt's text.
import { describe, expect, it } from "vitest";
import { acceptMessage, buildLabel, buildsButtonText, cleanIceServers, cleanPort, cleanPreferences, cleanRendezvous, connectAddress, isLocalRemote, listenAddress, remoteHost } from "./debugLinkLogic";

describe("debug link preferences", () => {
  it("read leniently, defaults on for listening, off for the LAN", () => {
    expect(cleanPreferences(undefined)).toEqual({ listen: true, lan: false, port: 7790, rendezvous: "", iceServers: [] });
    expect(cleanPreferences({ listen: false, lan: true, port: 8000 })).toEqual({ listen: false, lan: true, port: 8000, rendezvous: "", iceServers: [] });
    expect(cleanPreferences({ listen: "yes", lan: 1, port: 80 })).toEqual({ listen: true, lan: false, port: 7790, rendezvous: "", iceServers: [] });
  });

  it("a rendezvous: a ws:// or wss:// URL with a host is kept (trimmed); anything else is dropped to empty", () => {
    expect(cleanRendezvous("ws://rv.example:7800/myco-rendezvous")).toBe("ws://rv.example:7800/myco-rendezvous");
    expect(cleanRendezvous("  wss://rv.example/myco-rendezvous ")).toBe("wss://rv.example/myco-rendezvous");
    expect(cleanRendezvous("")).toBe("");
    expect(cleanRendezvous("http://rv.example")).toBe("");
    expect(cleanRendezvous("ws://")).toBe("");
    expect(cleanRendezvous("rv.example:7800")).toBe("");
    expect(cleanRendezvous(42)).toBe("");
    expect(cleanPreferences({ rendezvous: "https://rv.example" }).rendezvous).toBe("");
    expect(cleanPreferences({ rendezvous: "ws://rv.example:7800" }).rendezvous).toBe("ws://rv.example:7800");
  });

  it("ICE servers: only stun:, turn: and turns: URLs are kept, blanks and others dropped", () => {
    expect(cleanIceServers(["stun:stun.example.org:3478", "turn:turn.example.org:3478", "turns:turn.example.org:5349"])).toEqual([
      "stun:stun.example.org:3478",
      "turn:turn.example.org:3478",
      "turns:turn.example.org:5349",
    ]);
    expect(cleanIceServers(["  stun:stun.example.org  ", "", "https://x.example", "stun:", "STUN:a.example:1"])).toEqual(["stun:stun.example.org", "STUN:a.example:1"]);
    expect(cleanIceServers("stun:stun.example.org")).toEqual([]);
    expect(cleanIceServers(undefined)).toEqual([]);
    expect(cleanPreferences({ iceServers: ["https://x.example", "turn:t.example:3478"] }).iceServers).toEqual(["turn:t.example:3478"]);
  });

  it("ports: integers 1024..65535 only", () => {
    expect(cleanPort("9001")).toBe(9001);
    expect(cleanPort(1023)).toBe(7790);
    expect(cleanPort(65536)).toBe(7790);
    expect(cleanPort("12.5")).toBe(7790);
  });

  it("listens on loopback only, or on every interface with the LAN on", () => {
    expect(listenAddress({ listen: true, lan: false, port: 7790 })).toBe("ws://127.0.0.1:7790/myco-debug");
    expect(listenAddress({ listen: true, lan: true, port: 7791 })).toBe("ws://0.0.0.0:7791/myco-debug");
    expect(connectAddress({ listen: true, lan: true, port: 7791 })).toBe("ws://localhost:7791/myco-debug");
  });
});

describe("remotes", () => {
  it("drop the port the server adds", () => {
    expect(remoteHost("192.168.1.20:51234")).toBe("192.168.1.20");
    expect(remoteHost("::1:51234")).toBe("::1");
    expect(remoteHost("::ffff:127.0.0.1:5000")).toBe("::ffff:127.0.0.1");
    expect(remoteHost("[fe80::1]:5")).toBe("fe80::1");
    expect(remoteHost("::1")).toBe("::1");
  });

  it("this machine: loopback addresses and in-process loopback links", () => {
    for (const local of ["127.0.0.1:4000", "::1:4000", "::ffff:127.0.0.1:4000", "localhost:1", "loopback-3#1"]) expect(isLocalRemote(local), local).toBe(true);
    for (const other of ["192.168.1.20:4000", "10.0.0.2:1", "fe80::1:4000"]) expect(isLocalRemote(other), other).toBe(false);
  });
});

describe("the menu's and prompt's text", () => {
  it("names the build and where it runs", () => {
    expect(buildLabel({ id: 1, name: "Flappy", platform: "web", remote: "127.0.0.1:5" })).toBe("Flappy (web, this machine)");
    expect(buildLabel({ id: 1, name: "Flappy", platform: "desktop", remote: "192.168.1.9:5" })).toBe("Flappy (desktop, 192.168.1.9)");
    // Through a rendezvous room (ADR 0404): the room's URL carries its token, which the menu never shows.
    expect(buildLabel({ id: 1, name: "Flappy", platform: "web", remote: "ws://127.0.0.1:7790/myco-rendezvous#room=174&token=136029" })).toBe("Flappy (web, this machine, through a room)");
    expect(buildLabel({ id: 1, name: "Flappy", platform: "web", remote: "ws://192.168.1.20:3000/myco-rendezvous#room=9&token=5" })).toBe("Flappy (web, 192.168.1.20, through a room)");
    expect(acceptMessage({ name: "Flappy", platform: "desktop", remote: "192.168.1.9:5" })).toMatch(/^"Flappy" \(desktop\) on 192\.168\.1\.9 wants to connect/);
  });

  it("the button counts builds, else says whether it listens", () => {
    expect(buildsButtonText(0, true)).toBe("No builds");
    expect(buildsButtonText(0, false)).toBe("Debug link off");
    expect(buildsButtonText(1, true)).toBe("1 build");
    expect(buildsButtonText(3, true)).toBe("3 builds");
  });
});
