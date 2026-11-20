/**
 * Listen targets (ADR 0255): where a server World listens, worked out once from the transport, a
 * link's or `listen()`'s options and the host's overrides and defaults. The session, the dedicated
 * server's runner and the Node WebSocket transport all read the same normalised target, so a
 * link's `host` and `path` (ADR 0067) mean the same everywhere.
 *
 * Precedence, field by field: the host's `overrides` (the dedicated server's `--host` and, for its
 * first server World, `--port`), then the options' `address` (all of it), then the options'
 * `port`, `host` and `path`, then the port and path of the options' `url` (a client's address,
 * which also says where its server is), then the host's `defaults` (the dedicated server's shared
 * port for Worlds created at runtime). Browser-safe: no Node imports.
 */

/** Where a World listens over one transport. */
export interface ListenTarget {
  readonly transport: string;
  /** The interface to bind; undefined for every interface. Network transports only. */
  readonly host?: string;
  /** The port (a name for loopback, which has no ports); undefined only for loopback names made up per World. */
  readonly port?: number | string;
  /** The path, starting with "/" ("/" for none). */
  readonly path: string;
  /** The address the transport listens at: "7777", "7777/game", "ws://127.0.0.1:7777/game", or a loopback name. */
  readonly address: string;
}

/** A host's say over listen targets: `overrides` win over the options, `defaults` fill in what they leave out. */
export interface ListenHostOptions {
  readonly overrides?: { readonly host?: string; readonly port?: number };
  readonly defaults?: { readonly host?: string; readonly port?: number };
  /** Loopback only: the made-up name to use when the options give no port or address (unique per World). */
  readonly loopbackName?: () => string;
  /** Loopback only: a made-up prefix to put before a path when the options give no port (unique per Engine). */
  readonly loopbackPrefix?: () => string;
}

/**
 * Parse a network listen address: "ws://0.0.0.0:7777/game", "localhost:7777", "7777", ":7777",
 * "7777/match/3" or a port number. No host means every interface; a path other than "/" limits
 * upgrades to that path.
 */
export function parseListenAddress(address: string | number): { host?: string; port: number; path: string } {
  if (typeof address === "number") return { port: address, path: "/" };
  const trimmed = address.trim();
  const bare = /^:?(\d+)(\/.*)?$/.exec(trimmed);
  if (bare) return { port: Number(bare[1]), path: bare[2] || "/" };
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `ws://${trimmed}`);
  } catch {
    throw new Error(`Can't listen on "${address}": expected a port or a URL like "ws://0.0.0.0:7777".`);
  }
  if (url.protocol !== "ws:") throw new Error(`Can't listen on "${address}": only ws:// is supported (put TLS in a reverse proxy).`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host: host || undefined, port: url.port ? Number(url.port) : 80, path: decodeURIComponent(url.pathname || "/") };
}

/** A `path` option normalised to start with "/"; undefined if none. */
function pathOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value === "/") return undefined;
  return value.startsWith("/") ? value : `/${value}`;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const portOption = (value: unknown) => (typeof value === "number" || (typeof value === "string" && value !== "") ? value : undefined);

/** The network address for a host, port and path: a bare port (every interface) when there's no host. */
function networkAddress(host: string | undefined, port: number | string, path: string): string {
  if (host) return `ws://${host.includes(":") ? `[${host}]` : host}:${port}${path === "/" ? "" : path}`;
  return `${port}${path === "/" ? "" : path}`;
}

/**
 * The listen target for `transport` and `options`, or null when a network transport has no port
 * from anywhere. Throws for an `address` or `url` that isn't one.
 */
export function listenTarget(transport: string, options: Record<string, unknown>, host: ListenHostOptions = {}): ListenTarget | null {
  const address = text(options.address);
  if (transport === "loopback") {
    // Loopback addresses are names: host and port mean nothing, a path keeps names apart (ADR 0067).
    if (address) return { transport, port: address, path: "/", address };
    const path = pathOf(options.path);
    const port = portOption(options.port);
    if (port !== undefined) return { transport, port, path: path ?? "/", address: `${port}${path ?? ""}` };
    const name = path ? `${host.loopbackPrefix?.() ?? "loopback"}${path}` : (host.loopbackName?.() ?? "loopback");
    return { transport, path: path ?? "/", address: name };
  }
  let parsed: { host?: string; port?: number | string; path?: string };
  if (address) parsed = parseListenAddress(address);
  else {
    const option = portOption(options.port);
    // A port option may be a string ("7777", "7777/game"); without one, a client `url` says where its server is.
    const from = option !== undefined ? parseListenAddress(option) : text(options.url) ? parseListenAddress(options.url as string) : undefined;
    parsed = { host: text(options.host), port: from?.port, path: pathOf(options.path) ?? pathOf(from?.path) };
  }
  const port = host.overrides?.port ?? parsed.port ?? host.defaults?.port;
  if (port === undefined) return null;
  const bind = host.overrides?.host ?? parsed.host ?? host.defaults?.host;
  const path = pathOf(parsed.path) ?? "/";
  return { transport, ...(bind ? { host: bind } : {}), port, path, address: networkAddress(bind, port, path) };
}
