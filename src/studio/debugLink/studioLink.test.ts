// The Studio's debug link: it starts as "Audio Studio" on its own preferences, listens over loopback, and `studioBuild`
// follows the build the link has active.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "../../engine/net/Transport";
import "../../engine/net/transport/loopback";
import { DebugLinkSession } from "../../engine/debugLink/session";
import { listenAddress, type DebugLinkPreferences } from "../../editor/debugLink/debugLinkLogic";
import { startStudioDebugLink, studioBuild, studioDebugLinkPreferences, studioLink } from "./studioLink";

let port = 9300;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function start() {
  const prefs: DebugLinkPreferences = { listen: true, lan: false, port: port++ };
  studioDebugLinkPreferences.value = prefs;
  const registered = vi.fn(async () => {});
  stops.push(startStudioDebugLink({ registerNative: registered, transport: () => createTransport("loopback"), autoPoll: false }));
  await vi.waitFor(() => expect(studioLink.value?.state.value.kind).toBe("listening"));
  return { prefs, registered, link: studioLink.value! };
}

describe("the Studio's debug link", () => {
  it("registers the native transport first, then listens on this machine", async () => {
    const { registered, link, prefs } = await start();
    expect(registered).toHaveBeenCalledOnce();
    expect(link.state.value).toEqual({ kind: "listening", address: expect.stringContaining(String(prefs.port)) });
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
