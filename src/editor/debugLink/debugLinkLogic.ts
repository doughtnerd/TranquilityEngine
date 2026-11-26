// The editor's debug link, the parts without state (ADR 0376): where it listens (this machine only, or the LAN when
// Preferences allow it), which connecting builds are local (accepted without asking) and which need the accept prompt,
// and how the connected-builds menu reads. Pure.
import { DEBUG_LINK_PATH, DEFAULT_DEBUG_LINK_PORT } from "../../engine/debugLink/config";

/** The editor's debug link preferences. */
export interface DebugLinkPreferences {
  /** Listen for builds at all (default on). */
  readonly listen: boolean;
  /** Listen on every interface, so builds on other machines can connect (default off). */
  readonly lan: boolean;
  /** The port (default 7790). */
  readonly port: number;
  /**
   * A rendezvous's WebSocket URL (`ws://` or `wss://`) for room codes when no machine on the network hosts one (default
   * empty). Optional in the type: a value written before it existed reads as empty.
   */
  readonly rendezvous?: string;
  /** STUN/TURN URLs (`stun:`, `turn:`, `turns:`) for networks beyond this one (default none). Optional, as `rendezvous`. */
  readonly iceServers?: readonly string[];
}

export const DEFAULT_DEBUG_LINK_PREFERENCES: DebugLinkPreferences = { listen: true, lan: false, port: DEFAULT_DEBUG_LINK_PORT, rendezvous: "", iceServers: [] };

/** A stored preferences value read leniently (anything bad falls back to the default). */
export function cleanPreferences(raw: unknown): DebugLinkPreferences {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    listen: typeof r.listen === "boolean" ? r.listen : DEFAULT_DEBUG_LINK_PREFERENCES.listen,
    lan: typeof r.lan === "boolean" ? r.lan : DEFAULT_DEBUG_LINK_PREFERENCES.lan,
    port: cleanPort(r.port),
    rendezvous: cleanRendezvous(r.rendezvous),
    iceServers: cleanIceServers(r.iceServers),
  };
}

/** A rendezvous URL from a field: empty, or a `ws://` or `wss://` URL with a host (trimmed); else empty. */
export function cleanRendezvous(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  try {
    const url = new URL(s);
    return (url.protocol === "ws:" || url.protocol === "wss:") && url.hostname ? s : "";
  } catch {
    return "";
  }
}

/** Whether a line is a STUN or TURN URL (`stun:`, `turn:` or `turns:`, then an address). */
export function isIceServerUrl(raw: string): boolean {
  return /^(stun|turns?):\S+$/i.test(raw.trim());
}

/** The ICE server URLs kept from a list (trimmed; blanks and anything that isn't a STUN or TURN URL are dropped). */
export function cleanIceServers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === "string" && isIceServerUrl(u)).map((u) => u.trim());
}

/** A port from a field: an integer 1024..65535, else the default. */
export function cleanPort(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_DEBUG_LINK_PORT;
}

/** The transport address the editor listens at: loopback only, or every interface with `lan`. */
export function listenAddress(p: DebugLinkPreferences): string {
  return `ws://${p.lan ? "0.0.0.0" : "127.0.0.1"}:${p.port}${DEBUG_LINK_PATH}`;
}

/** The address a build on this machine connects to (shown in Preferences, written by exports). */
export function connectAddress(p: DebugLinkPreferences): string {
  return `ws://localhost:${p.port}${DEBUG_LINK_PATH}`;
}

/** A transport's remote address without its port ("192.168.1.20:51234" → "192.168.1.20", "[::1]:5" → "::1"). */
export function remoteHost(remote: string): string {
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(remote);
  if (bracket) return bracket[1]!;
  // The server names a peer `address:port` (an IPv6 address unbracketed): the port is the last part.
  const port = /^(.+):\d+$/.exec(remote);
  return port && !port[1]!.endsWith(":") ? port[1]! : remote;
}

/** Whether a connection comes from this machine (loopback addresses, and in-process loopback links). */
export function isLocalRemote(remote: string): boolean {
  if (remote.startsWith("loopback-")) return true;
  const host = remoteHost(remote).toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(host);
}

/** A connected build as the menu lists it. */
export interface BuildEntry {
  readonly id: number;
  readonly name: string;
  readonly platform: string;
  readonly remote: string;
}

/** The menu's line for a build: its name, then where it runs when it isn't this machine. */
export function buildLabel(b: BuildEntry): string {
  // A build reached through a rendezvous room (ADR 0404) is named by the room's URL, which carries the room and its
  // token: show only where the rendezvous is.
  if (b.remote.includes("://")) {
    let host = "";
    try {
      host = new URL(b.remote).hostname.replace(/^\[|\]$/g, "");
    } catch {
      host = "";
    }
    const room = host === "" ? "a room" : isLocalRemote(host) ? "this machine, through a room" : `${host}, through a room`;
    return `${b.name} (${b.platform}, ${room})`;
  }
  const where = isLocalRemote(b.remote) ? "this machine" : remoteHost(b.remote);
  return `${b.name} (${b.platform}, ${where})`;
}

/** The status bar button's text. */
export function buildsButtonText(count: number, listening: boolean): string {
  if (count > 0) return count === 1 ? "1 build" : `${count} builds`;
  return listening ? "No builds" : "Debug link off";
}

/** The accept prompt's message for a build from another machine. */
export function acceptMessage(b: Pick<BuildEntry, "name" | "platform" | "remote">): string {
  return `"${b.name}" (${b.platform}) on ${remoteHost(b.remote)} wants to connect to this editor's debug link. A connected build can be inspected, and its live values changed, from this editor.`;
}
