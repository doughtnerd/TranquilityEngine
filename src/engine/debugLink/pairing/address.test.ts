// Address completion (ADR 0403; plan task L4): candidates from a native interface list or a page's own host, private
// ranges only, a typed full address passed through.
import { describe, expect, it } from "vitest";
import { addressCandidates, isPrivateIpv4 } from "./address";

const native = (...addresses: string[]) => ({
  kind: "native" as const,
  interfaces: addresses.map((address) => ({ address })),
});

describe("address completion", () => {
  it("completes an address code from each private IPv4 interface's first two octets, in order, without duplicates", () => {
    const hosts = addressCandidates(
      { octets: [9, 9], portOffset: 0 },
      native("192.168.1.20", "10.0.0.7", "192.168.5.5", "10.0.0.8"),
    ).map((c) => c.host);
    expect(hosts).toEqual(["192.168.9.9", "10.0.9.9"]);
  });

  it("uses 10/8, 172.16/12 and 192.168/16 interfaces; skips public, loopback, link-local and IPv6 ones", () => {
    const hosts = addressCandidates(
      { octets: [4, 2], portOffset: 0 },
      {
        kind: "native",
        interfaces: [
          { address: "8.8.8.8" },
          { address: "127.0.0.1", internal: true },
          { address: "169.254.3.4" },
          { address: "fe80::1", family: "IPv6" },
          { address: "172.15.1.1" },
          { address: "172.16.5.5" },
          { address: "172.31.9.9" },
          { address: "10.1.2.3" },
          { address: "192.168.7.7" },
        ],
      },
    ).map((c) => c.host);
    expect(hosts).toEqual(["172.16.4.2", "172.31.4.2", "10.1.4.2", "192.168.4.2"]);
  });

  it("completes from a page's own host when it is a private IPv4 address", () => {
    const hosts = addressCandidates({ octets: [4, 4], portOffset: 0 }, { kind: "page", host: "10.0.0.5" }).map((c) => c.host);
    expect(hosts).toEqual(["10.0.4.4"]);
  });

  it("falls back to 192.168.<third>.<fourth> when no private prefix is known (a page on localhost or a name)", () => {
    const target = { octets: [3, 4], portOffset: 0 } as const;
    for (const context of [
      { kind: "page" as const, host: "localhost" },
      { kind: "page" as const, host: "game.example.com" },
      { kind: "page" as const, host: "203.0.113.5" },
      native("8.8.8.8", "127.0.0.1"),
    ]) {
      expect(addressCandidates(target, context).map((c) => c.host)).toEqual(["192.168.3.4"]);
    }
  });

  it("puts the port at 7790 + the port offset, the ws: scheme and the link's path", () => {
    const [candidate] = addressCandidates({ octets: [1, 20], portOffset: 3 }, native("192.168.1.2"));
    expect(candidate).toEqual({ host: "192.168.1.20", port: 7793, url: "ws://192.168.1.20:7793/myco-debug" });
  });

  it("takes another path and port when given (a room code's rendezvous on /myco-rendezvous)", () => {
    const [candidate] = addressCandidates(
      { octets: [1, 20], portOffset: 0 },
      native("192.168.1.2"),
      { path: "/myco-rendezvous", port: 8080 },
    );
    expect(candidate).toEqual({ host: "192.168.1.20", port: 8080, url: "ws://192.168.1.20:8080/myco-rendezvous" });
  });

  it("passes a typed full address through as the only candidate, as debugLinkAddress reads it", () => {
    const context = native("192.168.1.2", "10.0.0.1");
    expect(addressCandidates({ address: "ws://10.9.8.7:7795/myco-debug" }, context)).toEqual([
      { host: "10.9.8.7", port: 7795, url: "ws://10.9.8.7:7795/myco-debug" },
    ]);
    expect(addressCandidates({ address: "192.168.1.9:7791" }, context)).toEqual([
      { host: "192.168.1.9", port: 7791, url: "ws://192.168.1.9:7791/myco-debug" },
    ]);
    expect(addressCandidates({ address: "7792" }, context)).toEqual([
      { host: "localhost", port: 7792, url: "ws://localhost:7792/myco-debug" },
    ]);
  });

  it("gives no candidate for a typed address debugLinkAddress can't read", () => {
    expect(addressCandidates({ address: "not an address" }, native("192.168.1.2"))).toEqual([]);
    expect(addressCandidates({ address: "" }, native("192.168.1.2"))).toEqual([]);
  });

  it("isPrivateIpv4: true for the three private ranges' edges, false outside them and for non-addresses", () => {
    for (const address of ["10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255"]) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
    for (const address of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "8.8.8.8", "169.254.1.1", "127.0.0.1"]) {
      expect(isPrivateIpv4(address), address).toBe(false);
    }
    for (const address of ["", "localhost", "192.168.1", "192.168.1.256", "192.168.1.1.1", "::1", "fe80::1", "example.local"]) {
      expect(isPrivateIpv4(address), address).toBe(false);
    }
  });
});
