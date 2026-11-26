// Where a build's debug link connects (ADR 0376): `game.json`'s `debug: { link: "ws://host:port" }`, written by an
// export with debugging on (`npm run export -- --debug-link`, the editor's Export), and a launch override (a desktop
// build's `--debug-link <address>` flag, a web build's `?debug-link=` query). Read leniently: a bad value falls back to the
// default address with one problem line, never a throw (0306). No other module of the link is imported here, so the
// exporter can validate an address without loading the link.

/** The port the editor listens on by default. */
export const DEFAULT_DEBUG_LINK_PORT = 7790;
/** The path on that port (other listeners may share it, ADR 0067). */
export const DEBUG_LINK_PATH = "/myco-debug";
/** Where a build connects when nothing says otherwise: the editor on the same machine. */
export const DEFAULT_DEBUG_LINK = `ws://localhost:${DEFAULT_DEBUG_LINK_PORT}${DEBUG_LINK_PATH}`;

/** `game.json`'s `debug` section. */
export interface DebugManifest {
  /** The tool's WebSocket address. */
  readonly link: string;
  /**
   * The WebSocket transport's `webrtc` option (ADR 0333), for a device the socket alone reaches poorly: the link's
   * unreliable samples then travel over a data channel set up through the same signalling the game uses. Omitted: the
   * transport's default.
   */
  readonly webrtc?: false | Readonly<Record<string, unknown>>;
  /**
   * `debug.listen` (ADR 0403 "Roles"): the build listens for tools as well as (or instead of) connecting out, on a native
   * build only (a page can't listen). Written by an export with `--debug-listen`. Omitted: false (connect out only).
   */
  readonly listen?: boolean;
  /**
   * `debug.lan` (ADR 0403, 0376 "Security"): a listening build accepts connections from other machines on its network
   * (binds `0.0.0.0`), each paired by code; without it, it binds loopback and only same-machine tools connect. Written by
   * `--debug-lan` (the export dialog's Debugging section, off by default). Omitted: false.
   */
  readonly lan?: boolean;
  /**
   * `debug.port`: the first port a listening build tries; when it's taken it tries the next nine (7790..7799 by default,
   * so the editor, the Studio and a game share a machine). A whole number 1..65526. Omitted: `DEFAULT_DEBUG_LINK_PORT`.
   */
  readonly port?: number;
  /**
   * `debug.rendezvous`: the hosted rendezvous's WebSocket URL (`ws://` or `wss://`, path `/myco-rendezvous`), which a
   * room code without a LAN rendezvous falls back to (ADR 0403 "Rendezvous" 3; plan O7). Omitted: none configured (no
   * public rendezvous exists, plan O3).
   */
  readonly rendezvous?: string;
  /**
   * `debug.iceServers`: STUN/TURN servers for the `webrtc` transport beyond one network (ADR 0403 "Transports": host
   * candidates only on one network, ICE servers a setting for later). Omitted: none.
   */
  readonly iceServers?: readonly DebugIceServer[];
}

/** One `debug.iceServers` entry: `RTCIceServer`'s fields, declared here so the exporter needs no DOM types. */
export interface DebugIceServer {
  /** `stun:`, `turn:` or `turns:` URLs. */
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/**
 * An address as a WebSocket URL: a full `ws://` or `wss://` URL as it is; `host:port` and a bare port gain the scheme and
 * the default path. Null when it can't be one.
 */
export function debugLinkAddress(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{1,5}$/.test(s)) {
    const port = Number(s);
    return port > 0 && port < 65536 ? `ws://localhost:${port}${DEBUG_LINK_PATH}` : null;
  }
  const hostPort = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(s);
  if (!/^wss?:\/\//i.test(s) && !(hostPort && Number(hostPort[2]) > 0 && Number(hostPort[2]) < 65536)) return null;
  const url = hostPort ? `ws://${s}${DEBUG_LINK_PATH}` : s;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * The link a build makes, from `game.json`'s `debug` and a launch override; null when the build has no debugging
 * (`debug` absent: such a build holds no link code anyway). `problems` lists what fell back.
 */
export function readDebugManifest(debug: unknown, override?: string | null): { config: DebugManifest | null; problems: string[] } {
  const problems: string[] = [];
  if (debug === undefined || debug === null || debug === false) return { config: null, problems };
  const d = (typeof debug === "object" ? debug : {}) as Record<string, unknown>;
  if (typeof debug !== "object") problems.push(`game.json's debug should be an object like { "link": "${DEFAULT_DEBUG_LINK}" }; using the default link.`);
  let link = DEFAULT_DEBUG_LINK;
  if (typeof d.link === "string") {
    const a = debugLinkAddress(d.link);
    if (a) link = a;
    else problems.push(`game.json's debug.link "${d.link}" isn't a WebSocket address; using ${DEFAULT_DEBUG_LINK}.`);
  } else if (d.link !== undefined) problems.push(`game.json's debug.link should be a WebSocket address; using ${DEFAULT_DEBUG_LINK}.`);
  if (typeof override === "string" && override.trim()) {
    const a = debugLinkAddress(override);
    if (a) link = a;
    else problems.push(`The launch's debug link address "${override}" isn't a WebSocket address; using ${link}.`);
  }
  let webrtc: DebugManifest["webrtc"];
  if (d.webrtc === false) webrtc = false;
  else if (d.webrtc && typeof d.webrtc === "object" && !Array.isArray(d.webrtc)) webrtc = d.webrtc as Record<string, unknown>;
  else if (d.webrtc !== undefined) problems.push("game.json's debug.webrtc should be false or the WebSocket transport's webrtc options; ignored.");
  const config: { link: string; webrtc?: DebugManifest["webrtc"]; listen?: boolean; lan?: boolean; port?: number; rendezvous?: string; iceServers?: readonly DebugIceServer[] } = { link };
  if (webrtc !== undefined) config.webrtc = webrtc;
  const listen = readBoolean(d, "listen", problems);
  if (listen !== undefined) config.listen = listen;
  const lan = readBoolean(d, "lan", problems);
  if (lan !== undefined) config.lan = lan;
  const port = readPort(d, problems);
  if (port !== undefined) config.port = port;
  const rendezvous = readRendezvous(d, problems);
  if (rendezvous !== undefined) config.rendezvous = rendezvous;
  const iceServers = readIceServers(d, problems);
  if (iceServers !== undefined) config.iceServers = iceServers;
  return { config, problems };
}

/** A `true` or `false` key; anything else is ignored with a problem line. Omitted: undefined. */
function readBoolean(d: Record<string, unknown>, key: "listen" | "lan", problems: string[]): boolean | undefined {
  const v = d[key];
  if (v === undefined || typeof v === "boolean") return v;
  problems.push(`game.json's debug.${key} should be true or false; ignored.`);
  return undefined;
}

/** A whole number from 1 to 65526; anything else is ignored with a problem line. Omitted: undefined. */
function readPort(d: Record<string, unknown>, problems: string[]): number | undefined {
  const v = d.port;
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65526) return v;
  problems.push("game.json's debug.port should be a whole number from 1 to 65526; ignored.");
  return undefined;
}

/** A `ws://` or `wss://` URL string; anything else is ignored with a problem line. Omitted: undefined. */
function readRendezvous(d: Record<string, unknown>, problems: string[]): string | undefined {
  const v = d.rendezvous;
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    const url = v.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return url;
    } catch {
      // not a URL: reported below
    }
  }
  problems.push("game.json's debug.rendezvous should be a ws:// or wss:// URL; ignored.");
  return undefined;
}

/** `stun:`, `turn:` or `turns:` followed by a host and optional port, no spaces. */
const ICE_URL = /^(stun|turns?):\S+$/i;

/**
 * `debug.iceServers`: an array of entries. An entry that isn't a valid server (bad `urls`, a non-string `username` or
 * `credential`) is dropped with a problem line each. A value that isn't an array is ignored with one problem line.
 */
function readIceServers(d: Record<string, unknown>, problems: string[]): DebugIceServer[] | undefined {
  const v = d.iceServers;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    problems.push("game.json's debug.iceServers should be an array of { urls, username?, credential? } entries; ignored.");
    return undefined;
  }
  const servers: DebugIceServer[] = [];
  for (const entry of v) {
    const server = readIceServer(entry);
    if (server) servers.push(server);
    else problems.push("game.json's debug.iceServers has an entry that isn't a STUN or TURN server (urls of stun:, turn: or turns: addresses, optional username and credential as text); dropped.");
  }
  return servers;
}

function readIceServer(entry: unknown): DebugIceServer | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const list = typeof e.urls === "string" ? [e.urls] : Array.isArray(e.urls) ? e.urls : null;
  if (!list || list.length === 0 || !list.every((u) => typeof u === "string" && ICE_URL.test(u))) return null;
  if (e.username !== undefined && typeof e.username !== "string") return null;
  if (e.credential !== undefined && typeof e.credential !== "string") return null;
  const server: { urls: string | string[]; username?: string; credential?: string } = {
    urls: typeof e.urls === "string" ? e.urls : [...(list as string[])],
  };
  if (typeof e.username === "string") server.username = e.username;
  if (typeof e.credential === "string") server.credential = e.credential;
  return server;
}
