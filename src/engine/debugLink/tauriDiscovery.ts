// Network discovery for the debug link (ADR 0403 "Discovery", pairing plan D1): a listening native build advertises
// itself on the LAN by mDNS (`_myco-debug._tcp.local.`), and a native tool (the Tauri editor and Studio) browses for
// them, so the Connect dialog lists nearby builds without a typed address. Pages can't use mDNS: outside Tauri both
// calls resolve to null and nothing is advertised or listed.
//
// The native side is `native/debug-discovery` (over `mdns-sd`) behind the commands in `native/debug-link-tauri`:
// - `myco_debuglink_advertise` { name, platform, port, path } -> id: registers this machine's service. The TXT record
//   holds `name`, `platform`, `path` and the protocol version `v`; never a token (the pairing code's token is still
//   typed: being listed is not being trusted).
// - `myco_debuglink_unadvertise` { id }.
// - `myco_debuglink_browse` { events: Channel } -> id: streams JSON events `{ kind: "found", build: DiscoveredBuild }` and
//   `{ kind: "lost", id }` on the channel.
// - `myco_debuglink_browse_stop` { id }.
//
import { Channel, invoke } from "@tauri-apps/api/core";

/** A build found on the LAN. */
export interface DiscoveredBuild {
  /** Stable while the build stays advertised (the mDNS instance's full name). */
  readonly id: string;
  /** The build's display name (its `game.json` name, or "Myco Editor" / "Audio Studio"). */
  readonly name: string;
  /** "desktop", "android", "editor", "studio"… as the build reports it. */
  readonly platform: string;
  /** The address to connect to: `ws://<ipv4>:<port><path>`. */
  readonly address: string;
}

/** What a listening build advertises. */
export interface AdvertisedBuild {
  readonly name: string;
  readonly platform: string;
  /** The port its listener bound. */
  readonly port: number;
  /** Its listen path ("/myco-debug"). */
  readonly path: string;
}

const inTauri = (): boolean => "__TAURI_INTERNALS__" in globalThis;

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Advertises a listening build on the LAN. Resolves to the stop, or null outside Tauri or when the native side can't advertise. */
export async function advertiseBuild(build: AdvertisedBuild): Promise<(() => void) | null> {
  if (!inTauri()) return null;
  let id: number;
  try {
    id = await invoke<number>("myco_debuglink_advertise", { name: build.name, platform: build.platform, port: build.port, path: build.path });
  } catch (err) {
    console.warn(`[myco] The debug link can't advertise this build: ${reason(err)}`);
    return null;
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    invoke("myco_debuglink_unadvertise", { id }).catch(() => undefined);
  };
}

type BrowseEvent = { kind: "found"; build: DiscoveredBuild } | { kind: "lost"; id: string };

/**
 * Browses for advertised builds; `onChange` gets the whole current list after each change (found or lost). Resolves to
 * the stop, or null outside Tauri or when the native side can't browse.
 */
export async function browseBuilds(onChange: (builds: readonly DiscoveredBuild[]) => void): Promise<(() => void) | null> {
  if (!inTauri()) return null;
  const builds = new Map<string, DiscoveredBuild>();
  let stopped = false;
  const events = new Channel<BrowseEvent>((event) => {
    if (stopped) return;
    if (event.kind === "found") builds.set(event.build.id, event.build);
    else if (!builds.delete(event.id)) return;
    onChange([...builds.values()]);
  });
  let id: number;
  try {
    id = await invoke<number>("myco_debuglink_browse", { events });
  } catch (err) {
    console.warn(`[myco] The debug link can't browse for builds: ${reason(err)}`);
    return null;
  }
  return () => {
    if (stopped) return;
    stopped = true;
    invoke("myco_debuglink_browse_stop", { id }).catch(() => undefined);
  };
}
