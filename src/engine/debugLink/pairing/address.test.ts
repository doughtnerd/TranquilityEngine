// Address completion (ADR 0380; plan task L4): candidates from a native interface list or a page's own host, private
// ranges only, a typed full address passed through. Skipped until L4 fills `address.ts`.
import { describe, it } from "vitest";
import "./address";

describe("address completion", () => {
  it.skip("completes an address code from each private IPv4 interface's first two octets, in order, without duplicates", () => {});
  it.skip("uses 10/8, 172.16/12 and 192.168/16 interfaces; skips public, loopback, link-local and IPv6 ones", () => {});
  it.skip("completes from a page's own host when it is a private IPv4 address", () => {});
  it.skip("falls back to 192.168.<third>.<fourth> when no private prefix is known (a page on localhost or a name)", () => {});
  it.skip("puts the port at 7790 + the port offset, the ws: scheme and the link's path", () => {});
  it.skip("takes another path and port when given (a room code's rendezvous on /myco-rendezvous)", () => {});
  it.skip("passes a typed full address through as the only candidate, as debugLinkAddress reads it", () => {});
  it.skip("gives no candidate for a typed address debugLinkAddress can't read", () => {});
  it.skip("isPrivateIpv4: true for the three private ranges' edges, false outside them and for non-addresses", () => {});
});
