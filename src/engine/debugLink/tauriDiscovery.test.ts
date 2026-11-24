// The discovery commands (`tauriDiscovery.ts`) against a stand-in for Tauri's IPC: the native side's JSON events
// drive the list, the stops reach the native commands, and outside Tauri nothing is called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advertiseBuild, browseBuilds, type DiscoveredBuild } from "./tauriDiscovery";

const tauri = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  emit: null as null | ((event: unknown) => void),
  fail: null as null | string,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    tauri.calls.push({ cmd, args });
    if (tauri.fail) throw tauri.fail;
    if (cmd === "myco_debuglink_browse") tauri.emit = (args.events as { onmessage: (m: unknown) => void }).onmessage;
    return cmd === "myco_debuglink_advertise" ? 5 : cmd === "myco_debuglink_browse" ? 9 : undefined;
  },
}));

const flappy: DiscoveredBuild = { id: "Flappy-1._myco-debug._tcp.local.", name: "Flappy", platform: "desktop", address: "ws://192.168.1.20:7791/myco-debug" };
const studio: DiscoveredBuild = { id: "Studio-2._myco-debug._tcp.local.", name: "Audio Studio", platform: "studio", address: "ws://192.168.1.21:7790/myco-debug" };

beforeEach(() => {
  tauri.calls = [];
  tauri.emit = null;
  tauri.fail = null;
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("browseBuilds", () => {
  it("found and lost events update the whole list the callback gets", async () => {
    const lists: (readonly DiscoveredBuild[])[] = [];
    const stop = await browseBuilds((builds) => lists.push(builds));
    expect(stop).not.toBeNull();
    tauri.emit!({ kind: "found", build: flappy });
    tauri.emit!({ kind: "found", build: studio });
    tauri.emit!({ kind: "found", build: { ...flappy, address: "ws://192.168.1.22:7791/myco-debug" } }); // the same build at a new address
    tauri.emit!({ kind: "lost", id: flappy.id });
    tauri.emit!({ kind: "lost", id: "never-seen" }); // no change, no call
    expect(lists.map((l) => l.map((b) => b.name))).toEqual([["Flappy"], ["Flappy", "Audio Studio"], ["Flappy", "Audio Studio"], ["Audio Studio"]]);
    expect(lists[2]![0]!.address).toBe("ws://192.168.1.22:7791/myco-debug");
  });

  it("the stop calls the stop command with the browse id, once, and ends the events", async () => {
    const onChange = vi.fn();
    const stop = (await browseBuilds(onChange))!;
    stop();
    stop();
    expect(tauri.calls.filter((c) => c.cmd === "myco_debuglink_browse_stop")).toEqual([{ cmd: "myco_debuglink_browse_stop", args: { id: 9 } }]);
    tauri.emit!({ kind: "found", build: flappy });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is null outside Tauri and calls nothing", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await browseBuilds(() => undefined)).toBeNull();
    expect(tauri.calls).toEqual([]);
  });

  it("is null with a warning when the command is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tauri.fail = "couldn't start mDNS";
    expect(await browseBuilds(() => undefined)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't start mDNS"));
  });
});

describe("advertiseBuild", () => {
  const build = { name: "Flappy", platform: "desktop", port: 7791, path: "/myco-debug" };

  it("advertises with the build's fields and the stop unadvertises its id once", async () => {
    const stop = (await advertiseBuild(build))!;
    expect(tauri.calls).toEqual([{ cmd: "myco_debuglink_advertise", args: build }]);
    stop();
    stop();
    expect(tauri.calls.slice(1)).toEqual([{ cmd: "myco_debuglink_unadvertise", args: { id: 5 } }]);
  });

  it("is null outside Tauri and calls nothing", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await advertiseBuild(build)).toBeNull();
    expect(tauri.calls).toEqual([]);
  });

  it("is null with a warning when the command is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tauri.fail = "couldn't advertise";
    expect(await advertiseBuild(build)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't advertise"));
  });
});
