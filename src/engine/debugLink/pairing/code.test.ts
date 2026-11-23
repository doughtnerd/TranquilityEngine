// The pairing code (ADR 0380; plan task L2): Crockford base32, two groups, the first character's range says the kind,
// address codes and room codes round-trip, bad text is refused. Skipped until L2 fills `code.ts`.
import { describe, it } from "vitest";
import "./code";

describe("the pairing code", () => {
  it.skip("writes 10 Crockford base32 characters in two groups of 5 (`3F9QK-7KD2X`)", () => {});
  it.skip("reads forgivingly: lower case, O as 0, I and L as 1, hyphens and spaces anywhere", () => {});
  it.skip("says the kind in the first character: 0..K an address code, M..Z a room code", () => {});
  it.skip("round-trips an address code: both octets 0..255, every port offset 0..9, tokens 0 and 2^30-1", () => {});
  it.skip("puts the third octet's top bit in the first character (octets 128.x and 127.x differ there)", () => {});
  it.skip("round-trips a room code with a LAN rendezvous on every port of RENDEZVOUS_PORTS, room 0..255, a 20-bit token", () => {});
  it.skip("round-trips a room code with the hosted rendezvous (`Z` first), room 0..32767, a 30-bit token", () => {});
  it.skip("refuses a character outside the alphabet (U, punctuation) and says which", () => {});
  it.skip("refuses the wrong length once hyphens and spaces are dropped", () => {});
  it.skip("refuses a room code naming a reserved rendezvous port index (12..21)", () => {});
  it.skip("won't encode a field out of its range (port offset 10, a 31-bit token, a LAN room of 256, a port not in the list)", () => {});
});
