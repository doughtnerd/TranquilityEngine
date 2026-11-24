// The Studio's debug link: it starts as "Audio Studio" on its own preferences, listens, and `studioBuild` follows the
// build the link has active. It runs as the app runs it: `startStudioDebugLink()` with no options. The listening
// "websocket" transport is the loopback here (registered under that name, as the desktop app registers its native one),
// and the desktop case mocks the platform check and the native listener module.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransport, registerTransport } from "../../engine/net/Transport";
import "../../engine/net/transport/loopback";
import { DebugLinkSession } from "../../engine/debugLink/session";
import { listenAddress, type DebugLinkPreferences } from "../../editor/debugLink/debugLinkLogic";
import { startStudioDebugLink, studioBuild, studioDebugLinkPreferences, studioLink } from "./studioLink";

const platform = vi.hoisted(() => ({ tauri: false, registered: 0, hosted: 0 }));
vi.mock("../../engine/platform/FileSystem", async (original) => ({ ...(await original<object>()), isTauri: () => platform.tauri }));
vi.mock("../../engine/debugLink/tauriListener", () => ({ registerTauriWebSocketTransport: () => void platform.registered++, hostRendezvous: () => (platform.hosted++, null) }));

registerTransport("websocket", (options) => createTransport("loopback", options), { listen: true });

let port = 9300;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  platform.tauri = false;
  platform.registered = 0;
  platform.hosted = 0;
});

async function start() {
  const prefs: DebugLinkPreferences = { listen: true, lan: false, port: port++ };
  studioDebugLinkPreferences.value = prefs;
  stops.push(startStudioDebugLink());
  await vi.waitFor(() => expect(studioLink.value?.state.value.kind).toBe("listening"));
  return { prefs, link: studioLink.value! };
}

describe("the Studio's debug link", () => {
  it("in the desktop app, registers the native transport first, then listens on this machine", async () => {
    platform.tauri = true;
    const { link, prefs } = await start();
    expect(platform.registered).toBe(1);
    expect(platform.hosted).toBe(1); // the listening transport also hosts the rendezvous (ADR 0403)
    expect(link.state.value).toEqual({ kind: "listening", address: expect.stringContaining(String(prefs.port)) });
  });

  it("in a browser page, registers nothing native", async () => {
    await start();
    expect(platform.registered).toBe(0);
  });

  it("follows a preference change", async () => {
    const { link } = await start();
    studioDebugLinkPreferences.value = { listen: false, lan: false, port: port++ };
    await vi.waitFor(() => expect(link.state.value.kind).toBe("off"));
  });

  it("studioBuild follows the active build", async () => {
    const { link, prefs } = await start();
    expect(studioBuild.value).toBeNull();
    const t = createTransport("loopback");
    stops.push(() => t.close());
    const session = new DebugLinkSession({ transport: t, connection: t.connect(listenAddress(prefs)), hello: { name: "Racer", platform: "web", topics: [] }, topics: new Map() });
    session.frameStart();
    link.poll();
    session.frameStart();
    expect(studioBuild.value?.name).toBe("Racer");
    link.choose(null);
    expect(studioBuild.value).toBeNull();
  });

  it("stops: the signal clears", async () => {
    await start();
    stops.pop()!();
    expect(studioLink.value).toBeNull();
    expect(studioBuild.value).toBeNull();
  });
});
