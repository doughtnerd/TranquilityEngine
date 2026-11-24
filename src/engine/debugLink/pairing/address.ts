// Address completion (ADR 0403 "Pairing code"): an address code holds only "the listener's private IPv4 address (its
// last two octets)" and its port offset. "The connecting side completes the address from its own private networks (a
// native endpoint's interfaces, an http page's own host) and tries each candidate; it can always type a full address
// instead." This module turns a code (or a typed address) into the WebSocket URLs to try, in order; trying them is the
// caller's (`connectFlow.ts`, the build's `--debug-link`).
//
// Rules:
// - Private ranges only (RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16): an interface or page host outside them
//   gives no prefix. (A private prefix plus any two octets stays private, so every completed address is private.)
// - Native: each private IPv4 interface address gives its first two octets as a prefix, in the interfaces' order;
//   duplicates are dropped. IPv6, loopback and link-local (169.254/16) interfaces give none.
// - Page: a page host that is a private IPv4 address gives its first two octets; a host that is a name (`localhost`, a
//   `.local` name, a domain) or a public address gives none, and the fallback below applies.
// - Fallback when no prefix was found: `192.168.<third>.<fourth>` (home networks' range), so a code still works on a
//   page opened from `localhost`; the person can type a full address otherwise.
// - A typed full address (`ws://host:port/path`, `host:port`, a bare port) passes through as `debugLinkAddress` reads
//   it, as the only candidate, whatever its range.
// - The port is `PAIR_BASE_PORT + portOffset`; the scheme `ws:`; the path the link's (`/myco-debug`), or the one given
//   (`/myco-rendezvous` for a room code's rendezvous).
import { DEBUG_LINK_PATH, debugLinkAddress } from "../config";
import { PAIR_BASE_PORT, type PairOctets } from "./code";

/** One network interface as a native shell lists it (Tauri's interface list, Node's `os.networkInterfaces()` flattened). */
export interface NetworkInterfaceAddress {
  /** The address as text: dotted IPv4 (`192.168.1.20`) or IPv6. */
  readonly address: string;
  /** `IPv4` or `IPv6`; when absent the address's form says. */
  readonly family?: "IPv4" | "IPv6";
  /** Whether the shell marks it internal (loopback). */
  readonly internal?: boolean;
}

/** What the connecting side knows of its own networks. */
export type AddressContext =
  /** A native endpoint: its interfaces. */
  | { readonly kind: "native"; readonly interfaces: readonly NetworkInterfaceAddress[] }
  /** A page: its own host (`location.hostname`). */
  | { readonly kind: "page"; readonly host: string };

/** What to complete: an address code's location, or a full address the person typed. */
export type AddressTarget =
  | { readonly octets: PairOctets; readonly portOffset: number }
  | { readonly address: string };

export interface AddressOptions {
  /** The URL path. Default `DEBUG_LINK_PATH` (`/myco-debug`). */
  readonly path?: string;
  /** The port instead of `PAIR_BASE_PORT + portOffset` (a room code's rendezvous port from `RENDEZVOUS_PORTS`). */
  readonly port?: number;
}

/** One address to try. */
export interface AddressCandidate {
  /** The completed host (`192.168.1.20`), or the typed address's host. */
  readonly host: string;
  readonly port: number;
  /** The WebSocket URL to connect to. */
  readonly url: string;
}

/**
 * The addresses to try for `target`, best first, per the rules above. Empty only for a typed address that
 * `debugLinkAddress` can't read.
 */
export function addressCandidates(target: AddressTarget, context: AddressContext, options?: AddressOptions): AddressCandidate[] {
  if ("address" in target) {
    const url = debugLinkAddress(target.address);
    if (url === null) return [];
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80;
    return [{ host: parsed.hostname, port, url }];
  }
  const port = options?.port ?? PAIR_BASE_PORT + target.portOffset;
  const path = options?.path ?? DEBUG_LINK_PATH;
  const [third, fourth] = target.octets;
  const prefixes = privatePrefixes(context);
  const hosts = prefixes.length > 0 ? prefixes.map((prefix) => `${prefix}.${third}.${fourth}`) : [`192.168.${third}.${fourth}`];
  return hosts.map((host) => ({ host, port, url: `ws://${host}:${port}${path}` }));
}

/** Whether `address` (dotted IPv4) is in a private range (10/8, 172.16/12, 192.168/16). False for anything else. */
export function isPrivateIpv4(address: string): boolean {
  const [a = -1, b = -1] = ipv4Octets(address);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The four octets of a dotted IPv4 address, or `[]` for anything else (IPv6, names, out-of-range or malformed text). */
function ipv4Octets(address: string): number[] {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) return [];
  const values = parts.map(Number);
  return values.every((value) => value <= 255) ? values : [];
}

/** The first two octets of each private IPv4 address the context offers, in order, without duplicates. */
function privatePrefixes(context: AddressContext): string[] {
  const addresses = context.kind === "page" ? [context.host] : context.interfaces.filter((i) => !i.internal).map((i) => i.address);
  const prefixes: string[] = [];
  for (const address of addresses) {
    if (!isPrivateIpv4(address)) continue;
    const [first = 0, second = 0] = ipv4Octets(address);
    const prefix = `${first}.${second}`;
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}
