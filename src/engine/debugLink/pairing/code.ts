// The pairing code (ADR 0403 "Pairing code"): "One format everywhere: 10 characters of Crockford base32 in two groups
// (`3F9QK-7KD2X`), single use, expiring after 5 minutes. [...] The first character says what the rest holds":
//
// - **Address code**: "the listener's private IPv4 address (its last two octets), its port offset (0–9) and a 30-bit
//   token". The connecting side completes the address from its own networks (`address.ts`).
// - **Room code**: "a rendezvous room and a token, for pairs where neither side can reach a listener on the other", plus
//   (plan decision O7, amendment R0) the rendezvous's LAN address in the address code's form, "two octets and a port from
//   a fixed list", or none, meaning the configured hosted rendezvous (`debug.rendezvous`, Preferences).
//
// This module only turns a code into text and back; issuing tokens and checking them is `gate.ts`.
//
// **Text.** Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, value 0..31), 10 characters shown as two
// groups of 5 joined by `-`. Reading is forgiving, as Crockford's spec says: case is ignored, `O` reads as 0, `I` and `L`
// as 1, and hyphens and spaces anywhere are dropped; `U` and any other character are refused, as is a length other
// than 10 once those are dropped.
//
// **Bit layout.** The 10 characters are one 50-bit number N, most significant character first: N = c0 * 2^45 + R, where
// c0 is the first character's value and R the 45 bits of the other nine. 0403's address code needs 16 + log2(10) + 30
// = 49.3 bits, so a whole first character can't be spent on the kind; instead **the first character's value range is
// the kind**: `0`..`K` (0..19) address, `M`..`Z` (20..31) room. (A person still reads the kind from the first
// character: a digit or A..K is an address code, M..Z a room code.)
//
//   Address code, c0 in 0..19:
//     c0           = portOffset * 2 + (octets >> 15)       portOffset 0..9 (port 7790 + offset), octets = third * 256 + fourth
//     R bits 30..44 = octets & 0x7fff                        (15 bits)
//     R bits  0..29 = token                                  (30 bits)
//
//   Room code with a LAN rendezvous, c0 in 20..30:
//     port index    = (c0 - 20) * 2 + R bit 44               index into RENDEZVOUS_PORTS (22 slots, 12 in use)
//     R bits 28..43 = the rendezvous's octets                (16 bits, third * 256 + fourth)
//     R bits 20..27 = room                                   (8 bits)
//     R bits  0..19 = token                                  (20 bits)
//
//   Room code with the hosted rendezvous, c0 = 31:
//     R bits 30..44 = room                                   (15 bits)
//     R bits  0..29 = token                                  (30 bits)
//
// N stays below 2^50, inside a double's exact integers; implementations must use arithmetic (or BigInt), not 32-bit
// bitwise operators, above bit 31.
//
// A LAN room code's token is 20 bits: with single use, 5-minute expiry and the rendezvous's and the gate's lockout
// (5 wrong tries a minute) a guesser gets about 25 tries at a million values.

/** Characters in a code, hyphens not counted. */
export const PAIR_CODE_LENGTH = 10;
/** Characters in each of the two groups. */
export const PAIR_CODE_GROUP = 5;
/** Crockford base32's alphabet, value order. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The port a listener tries first (0403: "The default port is 7790"). An address code carries `port - this`. */
export const PAIR_BASE_PORT = 7790;
/** Port offsets an address code carries: 0..9 (0403: "when it's taken the listener tries 7791–7799"). */
export const PAIR_PORT_OFFSETS = 10;
/** Bits of an address code's token, and of a hosted room code's (0403: "a 30-bit token"). */
export const PAIR_TOKEN_BITS = 30;
/** Bits of a LAN room code's token. */
export const LAN_ROOM_TOKEN_BITS = 20;
/** Bits of a LAN room code's room. */
export const LAN_ROOM_BITS = 8;
/** Bits of a hosted room code's room. */
export const HOSTED_ROOM_BITS = 15;
/** The first character values of room codes (`M`); address codes use 0 up to this. */
export const ROOM_CODE_FIRST = 20;
/** The first character value of a room code that names no LAN rendezvous (`Z`): the configured hosted one. */
export const HOSTED_ROOM_FIRST = 31;

/**
 * The fixed list of ports a LAN room code's rendezvous may be on (plan O7), by index: 0..9 the native listeners' range
 * 7790..7799 (0403 "Rendezvous" 1: any native Myco app), 10 the Vite dev server's 3000 and 11 an export's `serve.mjs`
 * default 8080 (0403 "Rendezvous" 2). Indexes 12..21 are reserved: a code naming one is refused. A rendezvous on another
 * port can't be named by a code; the person types its full address instead.
 */
export const RENDEZVOUS_PORTS: readonly number[] = [7790, 7791, 7792, 7793, 7794, 7795, 7796, 7797, 7798, 7799, 3000, 8080];

/** The last two octets of a private IPv4 address: `[third, fourth]`, each 0..255. */
export type PairOctets = readonly [number, number];

/** An address code: where a listener is (completed by the connecting side) and the token it expects. */
export interface AddressPairCode {
  readonly kind: "address";
  /** The listener's last two octets. */
  readonly octets: PairOctets;
  /** 0..9: the listener is on port `PAIR_BASE_PORT + portOffset`. */
  readonly portOffset: number;
  /** 0..2^30-1, checked by the listener's gate in the connection's `pair`. */
  readonly token: number;
}

/** Where a LAN room code's rendezvous is: the last two octets and one of `RENDEZVOUS_PORTS`. */
export interface RendezvousLocation {
  readonly octets: PairOctets;
  /** A port in `RENDEZVOUS_PORTS`. */
  readonly port: number;
}

/** A room code: a rendezvous room both sides join, and the token the waiting side expects. */
export interface RoomPairCode {
  readonly kind: "room";
  /** The rendezvous on the LAN, or null for the configured hosted rendezvous. */
  readonly rendezvous: RendezvousLocation | null;
  /** 0..255 with a LAN rendezvous, 0..32767 with the hosted one. */
  readonly room: number;
  /** 0..2^20-1 with a LAN rendezvous, 0..2^30-1 with the hosted one. */
  readonly token: number;
}

/** A pairing code's contents. */
export type PairCode = AddressPairCode | RoomPairCode;

/**
 * `code` as text: 10 Crockford characters in two groups of 5 (`3F9QK-7KD2X`), per the layout above. Throws a RangeError
 * naming the field for a value out of its range (a programming error: codes are made from issued tokens).
 */
export function encodePairCode(code: PairCode): string {
  let first: number;
  let rest: number;
  if (code.kind === "address") {
    checkRange("portOffset", code.portOffset, PAIR_PORT_OFFSETS - 1);
    checkRange("token", code.token, 2 ** PAIR_TOKEN_BITS - 1);
    const octets = octetsValue("address", code.octets);
    first = code.portOffset * 2 + Math.floor(octets / 2 ** 15);
    rest = (octets % 2 ** 15) * 2 ** 30 + code.token;
  } else if (code.rendezvous === null) {
    checkRange("room", code.room, 2 ** HOSTED_ROOM_BITS - 1);
    checkRange("token", code.token, 2 ** PAIR_TOKEN_BITS - 1);
    first = HOSTED_ROOM_FIRST;
    rest = code.room * 2 ** PAIR_TOKEN_BITS + code.token;
  } else {
    checkRange("room", code.room, 2 ** LAN_ROOM_BITS - 1);
    checkRange("token", code.token, 2 ** LAN_ROOM_TOKEN_BITS - 1);
    const portIndex = RENDEZVOUS_PORTS.indexOf(code.rendezvous.port);
    if (portIndex < 0) throw new RangeError(`rendezvous port ${code.rendezvous.port} is not in RENDEZVOUS_PORTS`);
    const octets = octetsValue("rendezvous", code.rendezvous.octets);
    first = ROOM_CODE_FIRST + Math.floor(portIndex / 2);
    rest =
      (portIndex % 2) * 2 ** 44 +
      octets * 2 ** 28 +
      code.room * 2 ** LAN_ROOM_TOKEN_BITS +
      code.token;
  }
  const value = first * 2 ** 45 + rest;
  let text = "";
  for (let place = PAIR_CODE_LENGTH - 1; place >= 0; place--) {
    text += CROCKFORD_ALPHABET.charAt(Math.floor(value / 32 ** place) % 32);
  }
  return `${text.slice(0, PAIR_CODE_GROUP)}-${text.slice(PAIR_CODE_GROUP)}`;
}

/** Throws a RangeError naming `field` unless `value` is an integer in `0..max`. */
function checkRange(field: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${field} ${value} is out of range 0..${max}`);
  }
}

/** The 16-bit value of two octets `[third, fourth]`, each checked to 0..255. */
function octetsValue(field: string, octets: PairOctets): number {
  checkRange(`${field} third octet`, octets[0], 255);
  checkRange(`${field} fourth octet`, octets[1], 255);
  return octets[0] * 256 + octets[1];
}

/**
 * The code `text` holds, or why it holds none: a character outside Crockford's alphabet (after the forgiving reading
 * above), the wrong length, or a room code naming a reserved rendezvous port index. Never throws.
 */
export function decodePairCode(text: string): { code: PairCode } | { refused: string } {
  // Case is folded per ASCII letter, so a locale's case rules (`ß` and the like) can't change the length.
  const upper = text.replace(/[a-z]/g, (letter) => letter.toUpperCase());
  const digits = upper.replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  for (let i = 0; i < digits.length; i++) {
    if (!CROCKFORD_ALPHABET.includes(digits.charAt(i))) {
      return { refused: `"${digits.charAt(i)}" is not a character of a pairing code` };
    }
  }
  if (digits.length !== PAIR_CODE_LENGTH) {
    return { refused: `a pairing code has ${PAIR_CODE_LENGTH} characters, not ${digits.length}` };
  }

  let value = 0;
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    value = value * 32 + CROCKFORD_ALPHABET.indexOf(digits.charAt(i));
  }
  const first = Math.floor(value / 2 ** 45);
  const rest = value - first * 2 ** 45;

  if (first < ROOM_CODE_FIRST) {
    const octets = Math.floor(rest / 2 ** 30) + (first % 2) * 2 ** 15;
    return {
      code: {
        kind: "address",
        octets: [Math.floor(octets / 256), octets % 256],
        portOffset: Math.floor(first / 2),
        token: rest % 2 ** PAIR_TOKEN_BITS,
      },
    };
  }
  if (first < HOSTED_ROOM_FIRST) {
    const portIndex = (first - ROOM_CODE_FIRST) * 2 + Math.floor(rest / 2 ** 44);
    if (portIndex >= RENDEZVOUS_PORTS.length) {
      return { refused: `rendezvous port index ${portIndex} is reserved` };
    }
    const octets = Math.floor(rest / 2 ** 28) % 2 ** 16;
    return {
      code: {
        kind: "room",
        rendezvous: {
          octets: [Math.floor(octets / 256), octets % 256],
          port: RENDEZVOUS_PORTS[portIndex],
        },
        room: Math.floor(rest / 2 ** LAN_ROOM_TOKEN_BITS) % 2 ** LAN_ROOM_BITS,
        token: rest % 2 ** LAN_ROOM_TOKEN_BITS,
      },
    };
  }
  return {
    code: {
      kind: "room",
      rendezvous: null,
      room: Math.floor(rest / 2 ** PAIR_TOKEN_BITS),
      token: rest % 2 ** PAIR_TOKEN_BITS,
    },
  };
}
