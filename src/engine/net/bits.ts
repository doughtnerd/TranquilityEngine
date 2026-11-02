/**
 * Bit-level packing behind `createBitWriter` / `createBitReader` (ADR 0033, T8).
 *
 * Bits are packed little-endian: the first bit written is bit 0 of byte 0, and a multi-bit value's
 * low bits come first. Nothing is byte-aligned, so a bool costs one bit and a varint can start
 * mid-byte. Limits:
 * - `writeBits` takes 1..32 bits of an unsigned integer that fits in them.
 * - `writeVarUint` takes integers 0..2^53-1 (`Number.MAX_SAFE_INTEGER`), 7 bits per byte group, so
 *   at most 8 groups. `writeVarInt` zigzags first, so it takes -2^52..2^52-1.
 * - Strings are UTF-8 with a varuint byte length. Lone surrogates are written as U+FFFD (that's
 *   what TextEncoder does), and a reader rejects invalid UTF-8.
 * Bad arguments throw a RangeError on the writer. On the reader, malformed input (reading past the
 * end, an over-long varint, a string longer than the packet) throws a RangeError rather than
 * returning garbage. `remaining` counts the up-to-7 padding bits of the last byte too.
 */
import type { BitReader, BitWriter } from "./codec";

const MAX_GROUPS = 8; // 8 × 7 = 56 bits ≥ 53
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
// Scratch for float32 ⇄ bits.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function checkWidth(bits: number): void {
  if (!(bits >= 1 && bits <= 32 && Number.isInteger(bits))) throw new RangeError(`bit width must be an integer 1..32, got ${bits}`);
}

/** Zigzag a signed integer to an unsigned one: 0, -1, 1, -2 … → 0, 1, 2, 3 … */
export function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

export function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

export class BitWriterImpl implements BitWriter {
  private buf: Uint8Array;
  private pos = 0; // in bits

  constructor(initialBytes = 64) {
    this.buf = new Uint8Array(Math.max(1, initialBytes));
  }

  /** Bits written so far. */
  get length(): number {
    return this.pos;
  }

  /** Start over, keeping the buffer. */
  reset(): void {
    this.buf.fill(0, 0, (this.pos + 7) >> 3);
    this.pos = 0;
  }

  private ensure(bits: number): void {
    const need = (this.pos + bits + 7) >> 3;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
  }

  writeBits(value: number, bits: number): void {
    checkWidth(bits);
    if (!(value >= 0 && value < 2 ** bits && Number.isInteger(value))) {
      throw new RangeError(`writeBits: ${value} isn't an unsigned integer that fits in ${bits} bits`);
    }
    this.ensure(bits);
    const buf = this.buf;
    let pos = this.pos;
    let v = value >>> 0;
    let left = bits;
    while (left > 0) {
      const offset = pos & 7;
      const n = Math.min(8 - offset, left);
      buf[pos >> 3] |= (v & ((1 << n) - 1)) << offset;
      v >>>= n;
      pos += n;
      left -= n;
    }
    this.pos = pos;
  }

  writeBool(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  writeVarUint(value: number): void {
    if (!(value >= 0 && Number.isSafeInteger(value))) throw new RangeError(`writeVarUint: ${value} isn't an integer in 0..2^53-1`);
    let v = value;
    // Above 2^31, `%` and division instead of bit ops, which would truncate to 32 bits.
    while (v >= 0x80) {
      this.writeBits((v % 0x80) | 0x80, 8);
      v = Math.floor(v / 0x80);
    }
    this.writeBits(v, 8);
  }

  writeVarInt(value: number): void {
    if (!(Number.isSafeInteger(value) && value >= -(2 ** 52) && value < 2 ** 52)) {
      throw new RangeError(`writeVarInt: ${value} isn't an integer in -2^52..2^52-1`);
    }
    this.writeVarUint(zigzag(value));
  }

  writeFloat32(value: number): void {
    f32[0] = value;
    this.writeBits(u32[0], 32);
  }

  writeString(value: string): void {
    const bytes = encoder.encode(value);
    this.writeVarUint(bytes.length);
    this.ensure(bytes.length * 8);
    if ((this.pos & 7) === 0) {
      this.buf.set(bytes, this.pos >> 3);
      this.pos += bytes.length * 8;
    } else {
      for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i], 8);
    }
  }

  finish(): Uint8Array {
    return this.buf.slice(0, (this.pos + 7) >> 3);
  }
}

export class BitReaderImpl implements BitReader {
  private pos = 0;
  private readonly end: number;

  constructor(private readonly data: Uint8Array) {
    this.end = data.length * 8;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(bits: number, what: string): void {
    if (bits > this.end - this.pos) {
      throw new RangeError(`${what}: read past the end of the data (${bits} bits wanted, ${this.end - this.pos} left)`);
    }
  }

  readBits(bits: number): number {
    checkWidth(bits);
    this.need(bits, "readBits");
    const data = this.data;
    let pos = this.pos;
    let result = 0;
    let shift = 0;
    while (shift < bits) {
      const offset = pos & 7;
      const n = Math.min(8 - offset, bits - shift);
      result |= ((data[pos >> 3] >> offset) & ((1 << n) - 1)) << shift;
      pos += n;
      shift += n;
    }
    this.pos = pos;
    return result >>> 0;
  }

  readBool(): boolean {
    return this.readBits(1) === 1;
  }

  readVarUint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < MAX_GROUPS; i++) {
      const byte = this.readBits(8);
      result += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) {
        if (!Number.isSafeInteger(result)) throw new RangeError(`readVarUint: value exceeds 2^53-1`);
        return result;
      }
      scale *= 0x80;
    }
    throw new RangeError(`readVarUint: varint longer than ${MAX_GROUPS} bytes`);
  }

  readVarInt(): number {
    return unzigzag(this.readVarUint());
  }

  readFloat32(): number {
    u32[0] = this.readBits(32);
    return f32[0];
  }

  readString(): string {
    const length = this.readVarUint();
    this.need(length * 8, "readString");
    let bytes: Uint8Array;
    if ((this.pos & 7) === 0) {
      const start = this.pos >> 3;
      bytes = this.data.subarray(start, start + length);
      this.pos += length * 8;
    } else {
      bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = this.readBits(8);
    }
    try {
      return decoder.decode(bytes);
    } catch {
      throw new RangeError("readString: invalid UTF-8");
    }
  }
}
