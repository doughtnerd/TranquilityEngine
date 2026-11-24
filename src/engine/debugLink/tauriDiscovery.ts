// Network discovery for the debug link (ADR 0380 "Discovery", pairing plan D1): a listening native build advertises
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
// D1 fills the bodies below; this file is the contract D2 (the dialog's list) is written against.

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

/** Advertises a listening build on the LAN. Resolves to the stop, or null outside Tauri or when the native side can't advertise. */
export async function advertiseBuild(build: AdvertisedBuild): Promise<(() => void) | null> {
  void build; // D1
  return null;
}

/**
 * Browses for advertised builds; `onChange` gets the whole current list after each change (found or lost). Resolves to
 * the stop, or null outside Tauri or when the native side can't browse.
 */
export async function browseBuilds(onChange: (builds: readonly DiscoveredBuild[]) => void): Promise<(() => void) | null> {
  void onChange; // D1
  return null;
}
