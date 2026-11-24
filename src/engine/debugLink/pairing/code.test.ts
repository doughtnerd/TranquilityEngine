// The pairing code (ADR 0403; plan task L2): Crockford base32, two groups, the first character's range says the kind,
// address codes and room codes round-trip, bad text is refused.
import { describe, expect, it } from "vitest";
import {
  CROCKFORD_ALPHABET,
  RENDEZVOUS_PORTS,
  decodePairCode,
  encodePairCode,
  type PairCode,
} from "./code";

const PAIR_CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
const ADDRESS_FIRST = "0123456789ABCDEFGHJK";
const ROOM_FIRST = "MNPQRSTVWXYZ";

function decodedCode(text: string): PairCode {
  const result = decodePairCode(text);
  if (!("code" in result)) throw new Error(`expected ${text} to decode, got: ${result.refused}`);
  return result.code;
}

describe("the pairing code", () => {
  it("writes 10 Crockford base32 characters in two groups of 5 (`3F9QK-7KD2X`)", () => {
    const zero = encodePairCode({ kind: "address", octets: [0, 0], portOffset: 0, token: 0 });
    expect(zero).toBe("00000-00000");
    expect(encodePairCode({ kind: "room", rendezvous: null, room: 0, token: 0 })).toBe("Z0000-00000");
    const sample = encodePairCode({ kind: "address", octets: [200, 17], portOffset: 7, token: 123456789 });
    expect(sample).toMatch(PAIR_CODE_SHAPE);
    expect(decodedCode(sample)).toEqual({ kind: "address", octets: [200, 17], portOffset: 7, token: 123456789 });
    expect(decodedCode("3F9QK-7KD2X").kind).toBe("address");
  });

  it("reads forgivingly: lower case, O as 0, I and L as 1, hyphens and spaces anywhere", () => {
    const canonical = decodePairCode("00000-00000");
    expect(decodePairCode("OOOOO-OOOOO")).toEqual(canonical);
    expect(decodePairCode("ooooo ooooo")).toEqual(canonical);
    expect(decodePairCode("0000000000")).toEqual(canonical);
    expect(decodePairCode("  0-0 0 00-00000 ")).toEqual(canonical);
    expect(decodePairCode("IIIII-IIIII")).toEqual(decodePairCode("11111-11111"));
    expect(decodePairCode("lllll-lllll")).toEqual(decodePairCode("11111-11111"));
    const sample = decodePairCode("3F9QK-7KD2X");
    expect(decodePairCode("3f9qk7kd2x")).toEqual(sample);
    expect(decodePairCode("3f9qk-7kd2x")).toEqual(sample);
  });

  it("says the kind in the first character: 0..K an address code, M..Z a room code", () => {
    for (const portOffset of [0, 9]) {
      const text = encodePairCode({ kind: "address", octets: [255, 255], portOffset, token: 1 });
      expect(ADDRESS_FIRST).toContain(text.charAt(0));
    }
    const lan = encodePairCode({
      kind: "room",
      rendezvous: { octets: [1, 2], port: RENDEZVOUS_PORTS[11] },
      room: 255,
      token: 1,
    });
    expect(ROOM_FIRST).toContain(lan.charAt(0));
    const hosted = encodePairCode({ kind: "room", rendezvous: null, room: 32767, token: 1 });
    expect(hosted.charAt(0)).toBe("Z");
    expect(CROCKFORD_ALPHABET.indexOf("K")).toBe(19);
    expect(CROCKFORD_ALPHABET.indexOf("M")).toBe(20);
  });

  it("round-trips an address code: both octets 0..255, every port offset 0..9, tokens 0 and 2^30-1", () => {
    const octetPairs: [number, number][] = [
      [0, 0],
      [0, 255],
      [255, 0],
      [255, 255],
      [1, 2],
    ];
    for (const octets of octetPairs) {
      for (let portOffset = 0; portOffset <= 9; portOffset++) {
        for (const token of [0, 2 ** 30 - 1]) {
          const code: PairCode = { kind: "address", octets, portOffset, token };
          expect(decodedCode(encodePairCode(code))).toEqual(code);
        }
      }
    }
  });

  it("puts the third octet's top bit in the first character (octets 128.x and 127.x differ there)", () => {
    const low = encodePairCode({ kind: "address", octets: [127, 5], portOffset: 0, token: 0 });
    const high = encodePairCode({ kind: "address", octets: [128, 5], portOffset: 0, token: 0 });
    expect(low.charAt(0)).toBe("0");
    expect(high.charAt(0)).toBe("1");
    expect(decodedCode(high)).toEqual({ kind: "address", octets: [128, 5], portOffset: 0, token: 0 });
    // 127.5 and 255.5 share their other 15 bits, so only the first character tells them apart.
    const twoFiftyFive = encodePairCode({ kind: "address", octets: [255, 5], portOffset: 0, token: 0 });
    expect(twoFiftyFive.charAt(0)).toBe("1");
    expect(twoFiftyFive.slice(1)).toBe(low.slice(1));
  });

  it("round-trips a room code with a LAN rendezvous on every port of RENDEZVOUS_PORTS, room 0..255, a 20-bit token", () => {
    for (const port of RENDEZVOUS_PORTS) {
      for (const room of [0, 255]) {
        for (const token of [0, 2 ** 20 - 1]) {
          for (const octets of [
            [0, 0],
            [255, 255],
          ] as [number, number][]) {
            const code: PairCode = { kind: "room", rendezvous: { octets, port }, room, token };
            expect(decodedCode(encodePairCode(code))).toEqual(code);
          }
        }
      }
    }
  });

  it("round-trips a room code with the hosted rendezvous (`Z` first), room 0..32767, a 30-bit token", () => {
    for (const room of [0, 32767]) {
      for (const token of [0, 2 ** 30 - 1]) {
        const code: PairCode = { kind: "room", rendezvous: null, room, token };
        const text = encodePairCode(code);
        expect(text.charAt(0)).toBe("Z");
        expect(decodedCode(text)).toEqual(code);
      }
    }
  });

  it("refuses a character outside the alphabet (U, punctuation) and says which", () => {
    expect(decodePairCode("3F9QK-7KD2U")).toEqual({ refused: expect.stringContaining('"U"') });
    expect(decodePairCode("3F9QK-7KD2!")).toEqual({ refused: expect.stringContaining('"!"') });
    expect(decodePairCode("3F9QK-7KD2u")).toEqual({ refused: expect.stringContaining('"U"') });
  });

  it("refuses the wrong length once hyphens and spaces are dropped", () => {
    expect(decodePairCode("")).toHaveProperty("refused");
    expect(decodePairCode("3F9QK-7KD2")).toEqual({ refused: expect.stringContaining("9") });
    expect(decodePairCode("3F9QK-7KD2XA")).toEqual({ refused: expect.stringContaining("11") });
    expect(decodePairCode("---")).toHaveProperty("refused");
  });

  it("refuses a room code naming a reserved rendezvous port index (12..21)", () => {
    // Port index 12: first character T (26), the rest zero.
    expect(decodePairCode("T0000-00000")).toEqual({ refused: expect.stringContaining("12") });
    // Port index 21: first character Y (30), then the top bit of the room block set (2^44 = 16 in the second character).
    expect(decodePairCode("YG000-00000")).toEqual({ refused: expect.stringContaining("21") });
    // Port index 11 (8080) is in use and decodes: first character S (25), then the top bit set (G).
    expect(decodePairCode("SG000-00000")).toHaveProperty("code");
  });

  it("won't encode a field out of its range (port offset 10, a 31-bit token, a LAN room of 256, a port not in the list)", () => {
    expect(() => encodePairCode({ kind: "address", octets: [0, 0], portOffset: 10, token: 0 })).toThrow(
      /portOffset/,
    );
    expect(() => encodePairCode({ kind: "address", octets: [0, 0], portOffset: 0, token: 2 ** 30 })).toThrow(
      RangeError,
    );
    expect(() =>
      encodePairCode({ kind: "room", rendezvous: { octets: [0, 0], port: 7790 }, room: 256, token: 0 }),
    ).toThrow(/room/);
    expect(() =>
      encodePairCode({ kind: "room", rendezvous: { octets: [0, 0], port: 7800 }, room: 0, token: 0 }),
    ).toThrow(/rendezvous port 7800/);
    expect(() => encodePairCode({ kind: "address", octets: [256, 0], portOffset: 0, token: 0 })).toThrow(RangeError);
    expect(() => encodePairCode({ kind: "room", rendezvous: null, room: 32768, token: 0 })).toThrow(RangeError);
  });
});
