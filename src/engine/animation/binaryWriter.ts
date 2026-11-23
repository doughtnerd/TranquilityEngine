/**
 * Writing the compiled animation formats' shared container in TypeScript (ADR 0370, 0371): the inverse of
 * `binaryHeader.ts`'s reader and the same layout as `anim-format`'s `container::Writer` and `strings::write` (the
 * contract): a 32-byte header (8-byte magic, u32 version, flags, file length, section count, two reserved zeros), a
 * table of 16-byte section entries (kind, offset, length, count) in ascending kind order, then the sections, each
 * padded to 4 bytes with zeros and placed at a 16-byte boundary, little-endian. A string table is `n + 1` end offsets
 * then the UTF-8 characters, padded to 4.
 *
 * Byte-for-byte what the Rust writer produces for the same sections, so a TypeScript compiler's output can be compared
 * with the core's fixtures. Pure; no plugin, no DOM. Internal: not public API.
 */

/** @internal A growable little-endian byte buffer. */
export class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  get length(): number {
    return this.len;
  }

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.room(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
    return this;
  }
  u16(v: number): this {
    this.room(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }
  u32(v: number): this {
    this.room(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }
  u32s(vs: readonly number[]): this {
    for (const v of vs) this.u32(v);
    return this;
  }
  f32(v: number): this {
    this.room(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  /** Zero bytes up to a multiple of `align`. */
  pad(align: number): this {
    const target = Math.ceil(this.len / align) * align;
    this.room(target - this.len);
    this.buf.fill(0, this.len, target);
    this.len = target;
    return this;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const scratch = new DataView(new ArrayBuffer(4));
/** @internal The bits of `v` rounded to an f32 (as `f32::to_bits`). */
export function f32Bits(v: number): number {
  scratch.setFloat32(0, v, true);
  return scratch.getUint32(0, true);
}

/** @internal One section to write: its kind, element count and contents (padded to 4 by the writer). */
export interface ContainerSection {
  readonly kind: number;
  readonly count: number;
  readonly data: Uint8Array;
}

const HEADER_LEN = 32;
const ENTRY_LEN = 16;
const align16 = (n: number) => (n + 15) & ~15;
const align4 = (n: number) => (n + 3) & ~3;

/** @internal A container file: `magic` (8 ASCII characters), version, flags and the sections (any order; written by kind). */
export function writeContainer(magic: string, version: number, flags: number, sections: readonly ContainerSection[]): Uint8Array {
  const sorted = [...sections].sort((a, b) => a.kind - b.kind);
  let offset = align16(HEADER_LEN + sorted.length * ENTRY_LEN);
  const table = sorted.map((s) => {
    const entry = { kind: s.kind, offset, length: align4(s.data.length), count: s.count, data: s.data };
    offset = align16(offset + entry.length);
    return entry;
  });
  const total = table.length ? table[table.length - 1].offset + table[table.length - 1].length : offset;
  const w = new ByteWriter();
  for (let i = 0; i < 8; i++) w.u8(magic.charCodeAt(i) & 0xff);
  w.u32(version).u32(flags).u32(total).u32(table.length).u32(0).u32(0);
  for (const e of table) w.u32(e.kind).u32(e.offset).u32(e.length).u32(e.count);
  for (const e of table) {
    while (w.length < e.offset) w.u8(0);
    w.bytes(e.data).pad(4);
  }
  return w.finish();
}

/** @internal A string table section's contents (`anim-format/src/strings.rs`). */
export function encodeStringTable(strings: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const encoded = strings.map((s) => enc.encode(s));
  const w = new ByteWriter();
  let end = 0;
  w.u32(0);
  for (const e of encoded) w.u32((end += e.length));
  for (const e of encoded) w.bytes(e);
  return w.pad(4).finish();
}
