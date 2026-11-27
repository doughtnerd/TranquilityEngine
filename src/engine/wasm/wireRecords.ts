// The wire's record layouts as data (ADR 0370; `anim-wire`'s generated constants: the animation plugin's
// `runtime/wasm/wire/*.ts`, the engine tween backend's `src/engine/tween/wasm/wire/*.ts`, ADR 0424), and one generic
// encoder and decoder over them: every record starts with the header (opcode `u16`, family version `u16`), then its
// fields, little-endian, at the offsets the layout gives. A pure library: the animation core host's command writer and
// output readers use it, the engine's tween backend too, and so can any later family without a hand-written codec.

/**
 * @internal The header every record starts with (`anim-wire`'s `WIRE_HEADER`, generated into each `wire/core.ts`;
 * `wireRecords.test.ts` holds them equal): the opcode at byte 0, the family version at byte 2.
 */
export const WIRE_HEADER = { bytes: 4, opcode: 0, version: 2 } as const;

/** @internal A field's scalar type, as `gen_wire` writes it. */
export type WireScalar = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";

/** @internal One generated record layout (`core.PLAY`, `graph.SET_PARAM`, `tracks.EVENT`…). */
export interface RecordLayout {
  readonly opcode: number;
  readonly version: number;
  readonly stride: number;
  readonly fields: Readonly<Record<string, { readonly offset: number; readonly type: WireScalar }>>;
}

/** @internal A record's field values by name; a field left out is written as 0. */
export type RecordValues<L extends RecordLayout> = { readonly [K in keyof L["fields"]]?: number };

/** @internal A decoded record: every field of the layout. */
export type RecordFields<L extends RecordLayout> = { -readonly [K in keyof L["fields"]]: number };

function write(view: DataView, at: number, type: WireScalar, v: number): void {
  switch (type) {
    case "f32":
      view.setFloat32(at, v, true);
      return;
    case "u32":
      view.setUint32(at, v >>> 0, true);
      return;
    case "i32":
      view.setInt32(at, v | 0, true);
      return;
    case "u16":
      view.setUint16(at, v & 0xffff, true);
      return;
    case "i16":
      view.setInt16(at, v, true);
      return;
    case "u8":
      view.setUint8(at, v & 0xff);
      return;
    case "i8":
      view.setInt8(at, v);
      return;
  }
}

function read(view: DataView, at: number, type: WireScalar): number {
  switch (type) {
    case "f32":
      return view.getFloat32(at, true);
    case "u32":
      return view.getUint32(at, true);
    case "i32":
      return view.getInt32(at, true);
    case "u16":
      return view.getUint16(at, true);
    case "i16":
      return view.getInt16(at, true);
    case "u8":
      return view.getUint8(at);
    case "i8":
      return view.getInt8(at);
  }
}

/** @internal Writes `layout` with `values` at byte `at` of `view` (header first, then every field; padding untouched). Returns the stride. */
export function putRecord<L extends RecordLayout>(view: DataView, at: number, layout: L, values: RecordValues<L>): number {
  view.setUint16(at + WIRE_HEADER.opcode, layout.opcode, true);
  view.setUint16(at + WIRE_HEADER.version, layout.version, true);
  const given = values as Readonly<Record<string, number | undefined>>;
  for (const name in layout.fields) {
    const f = layout.fields[name]!;
    write(view, at + f.offset, f.type, given[name] ?? 0);
  }
  return layout.stride;
}

/** @internal The opcode of the record at byte `at` of `view`. */
export function recordOpcode(view: DataView, at: number): number {
  return view.getUint16(at + WIRE_HEADER.opcode, true);
}

/**
 * @internal Reads the record of `layout` at byte `at` of `view` into `out` (a new object when omitted; pass one back to
 * read without allocating). Doesn't check the header: see {@link recordOpcode}.
 */
export function getRecord<L extends RecordLayout>(view: DataView, at: number, layout: L, out?: RecordFields<L>): RecordFields<L> {
  const target = (out ?? {}) as Record<string, number>;
  for (const name in layout.fields) {
    const f = layout.fields[name]!;
    target[name] = read(view, at + f.offset, f.type);
  }
  return target as RecordFields<L>;
}

/** @internal An `INIT`-style record as its own bytes (the boundary's one-record calls: `init`, `tween_create`…). */
export function encodeRecord<L extends RecordLayout>(layout: L, values: RecordValues<L>): Uint8Array {
  const bytes = new Uint8Array(layout.stride);
  putRecord(new DataView(bytes.buffer), 0, layout, values);
  return bytes;
}
