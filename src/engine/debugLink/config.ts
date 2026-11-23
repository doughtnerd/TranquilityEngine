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
  const url = /^wss?:\/\//i.test(s) ? s : `ws://${s}${DEBUG_LINK_PATH}`;
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
  return { config: webrtc === undefined ? { link } : { link, webrtc }, problems };
}
