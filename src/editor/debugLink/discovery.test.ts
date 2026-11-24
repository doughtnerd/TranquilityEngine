// The Connect dialog's discovery model: browsing starts on open and stops on close, the list follows the browse, and a
// page (no browse) is "unavailable". `browseBuilds` is the native boundary, so it is replaced by a fake here.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../engine/debugLink/tauriDiscovery", () => ({ browseBuilds: vi.fn(async () => null), advertiseBuild: vi.fn(async () => null) }));

import { buildLabel, chosenAddress, createDiscovery, hostOf, sortBuilds, type DiscoveredBuild } from "./discovery";

const pc: DiscoveredBuild = { id: "a", name: "Racer", platform: "desktop", address: "ws://192.168.1.20:7790/myco-debug" };
const phone: DiscoveredBuild = { id: "b", name: "Racer", platform: "android", address: "ws://192.168.1.31:7790/myco-debug" };
const editor: DiscoveredBuild = { id: "c", name: "Myco Editor", platform: "editor", address: "ws://192.168.1.5:7790/myco-debug" };

/** A fake `browseBuilds` that records its listener and stops. */
function fakeBrowse(result: "native" | "page" | "error" = "native") {
  const stops = vi.fn();
  let listener: ((b: readonly DiscoveredBuild[]) => void) | null = null;
  const browse = vi.fn(async (on: (b: readonly DiscoveredBuild[]) => void) => {
    listener = on;
    if (result === "error") throw new Error("no native side");
    return result === "native" ? stops : null;
  });
  return { browse, stops, emit: (b: readonly DiscoveredBuild[]) => listener?.(b) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("pure helpers", () => {
  it("labels a build with its name, platform and host", () => {
    expect(buildLabel(pc)).toBe("Racer — desktop, 192.168.1.20");
    expect(hostOf("ws://10.0.0.3:7790/myco-debug")).toBe("10.0.0.3");
    expect(hostOf("not a url")).toBe("not a url");
  });
  it("sorts by name, then platform, without changing the input", () => {
    const input = [pc, editor, phone];
    expect(sortBuilds(input).map((b) => b.id)).toEqual(["c", "b", "a"]);
    expect(input.map((b) => b.id)).toEqual(["a", "c", "b"]);
  });
  it("fills in the build's address when chosen", () => {
    expect(chosenAddress(phone)).toBe(phone.address);
  });
});

describe("createDiscovery", () => {
  it("starts browsing on start, lists sorted builds, and updates as they come and go", async () => {
    const f = fakeBrowse();
    const d = createDiscovery(f.browse);
    expect(f.browse).not.toHaveBeenCalled();
    expect(d.available.value).toBeNull();
    d.start();
    await settle();
    expect(f.browse).toHaveBeenCalledTimes(1);
    expect(d.available.value).toBe(true);
    expect(d.builds.value).toEqual([]);
    f.emit([pc, editor]);
    expect(d.builds.value.map((b) => b.id)).toEqual(["c", "a"]);
    f.emit([phone]);
    expect(d.builds.value.map((b) => b.id)).toEqual(["b"]);
  });

  it("doesn't browse twice when started twice", async () => {
    const f = fakeBrowse();
    const d = createDiscovery(f.browse);
    d.start();
    d.start();
    await settle();
    expect(f.browse).toHaveBeenCalledTimes(1);
  });

  it("stops browsing and clears the list on stop", async () => {
    const f = fakeBrowse();
    const d = createDiscovery(f.browse);
    d.start();
    await settle();
    f.emit([pc]);
    d.stop();
    expect(f.stops).toHaveBeenCalledTimes(1);
    expect(d.builds.value).toEqual([]);
    expect(d.available.value).toBeNull();
    f.emit([phone]); // a late event after close is ignored
    expect(d.builds.value).toEqual([]);
    d.stop();
    expect(f.stops).toHaveBeenCalledTimes(1);
  });

  it("stops browsing that began after the dialog already closed", async () => {
    const f = fakeBrowse();
    const d = createDiscovery(f.browse);
    d.start();
    d.stop();
    await settle();
    expect(f.stops).toHaveBeenCalledTimes(1);
    expect(d.available.value).toBeNull();
  });

  it("can start again after a stop", async () => {
    const f = fakeBrowse();
    const d = createDiscovery(f.browse);
    d.start();
    await settle();
    d.stop();
    d.start();
    await settle();
    expect(f.browse).toHaveBeenCalledTimes(2);
    expect(d.available.value).toBe(true);
  });

  it("is unavailable in a page, where browsing resolves to null", async () => {
    const f = fakeBrowse("page");
    const d = createDiscovery(f.browse);
    d.start();
    await settle();
    expect(d.available.value).toBe(false);
    expect(d.builds.value).toEqual([]);
    d.stop(); // nothing to stop, and no throw
  });

  it("is unavailable when browsing throws", async () => {
    const d = createDiscovery(fakeBrowse("error").browse);
    d.start();
    await settle();
    expect(d.available.value).toBe(false);
  });

  it("browses through the native module by default, and a page's null makes it unavailable", async () => {
    const d = createDiscovery();
    d.start();
    await settle();
    expect(d.available.value).toBe(false);
  });
});
