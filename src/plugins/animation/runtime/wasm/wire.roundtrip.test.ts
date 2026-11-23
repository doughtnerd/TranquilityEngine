// ADR 0350: the animation core's boundary records are defined once in Rust (native/anim/crates/anim-wire) and the
// TypeScript constants in wire/<family>.ts are generated from them. For every family, this test decodes the byte
// vectors Rust encoded (anim-wire/vectors/<family>.json) with the generated constants and encodes the values back,
// so both sides agree on every layout; then it drives the core's `init` through the committed wasm with the same
// constants. Each family's cases come from its own files, so a task adding records changes no line here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./wire/core";
import * as debug from "./wire/debug";
import * as graph from "./wire/graph";
import * as match from "./wire/match";
import * as physics from "./wire/physics";
import * as plugin from "./wire/plugin";
import * as rig from "./wire/rig";
import * as timeline from "./wire/timeline";
import * as tracks from "./wire/tracks";
import * as tween from "./wire/tween";
import { init, initSync } from "./myco_anim.js";

type ScalarType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";
interface FieldLayout {
  readonly offset: number;
  readonly type: ScalarType;
}
interface RecordLayout {
  readonly opcode: number;
  readonly version: number;
  readonly stride: number;
  readonly fields: Readonly<Record<string, FieldLayout>>;
}
interface FamilyConst {
  readonly name: string;
  readonly id: number;
  readonly version: number;
}
interface VectorFile {
  family: string;
  id: number;
  version: number;
  vectors: { name: string; record: string; values: Record<string, number>; hex: string }[];
}

const vectorDir = new URL("../../../../../native/anim/crates/anim-wire/vectors/", import.meta.url);

/** Every family's generated module, in id order (the generator writes all ten from the start). */
const FAMILIES: [string, Record<string, unknown>][] = [
  ["core", core],
  ["tracks", tracks],
  ["graph", graph],
  ["rig", rig],
  ["match", match],
  ["tween", tween],
  ["timeline", timeline],
  ["physics", physics],
  ["plugin", plugin],
  ["debug", debug],
];

function readField(view: DataView, at: number, type: ScalarType): number {
  switch (type) {
    case "u8":
      return view.getUint8(at);
    case "i8":
      return view.getInt8(at);
    case "u16":
      return view.getUint16(at, true);
    case "i16":
      return view.getInt16(at, true);
    case "u32":
      return view.getUint32(at, true);
    case "i32":
      return view.getInt32(at, true);
    case "f32":
      return view.getFloat32(at, true);
  }
}

function writeField(view: DataView, at: number, type: ScalarType, value: number): void {
  switch (type) {
    case "u8":
      return view.setUint8(at, value);
    case "i8":
      return view.setInt8(at, value);
    case "u16":
      return view.setUint16(at, value, true);
    case "i16":
      return view.setInt16(at, value, true);
    case "u32":
      return view.setUint32(at, value, true);
    case "i32":
      return view.setInt32(at, value, true);
    case "f32":
      return view.setFloat32(at, value, true);
  }
}

/** The record's header and fields, read with its generated layout. */
function decode(layout: RecordLayout, bytes: Uint8Array): { opcode: number; version: number; values: Record<string, number> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: Record<string, number> = {};
  for (const [name, field] of Object.entries(layout.fields)) values[name] = readField(view, field.offset, field.type);
  return { opcode: view.getUint16(core.WIRE_HEADER.opcode, true), version: view.getUint16(core.WIRE_HEADER.version, true), values };
}

/** The record's bytes, written with its generated layout. */
function encode(layout: RecordLayout, values: Record<string, number>): Uint8Array {
  const bytes = new Uint8Array(layout.stride);
  const view = new DataView(bytes.buffer);
  view.setUint16(core.WIRE_HEADER.opcode, layout.opcode, true);
  view.setUint16(core.WIRE_HEADER.version, layout.version, true);
  for (const [name, field] of Object.entries(layout.fields)) writeField(view, field.offset, field.type, values[name]);
  return bytes;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("animation wire families", () => {
  it.each(FAMILIES)("%s: the generated constants decode and re-encode Rust's vectors", (name, module) => {
    const file = JSON.parse(readFileSync(new URL(`${name}.json`, vectorDir), "utf8")) as VectorFile;
    const family = module[`${name.toUpperCase()}_FAMILY`] as FamilyConst;
    expect(family).toEqual({ name, id: file.id, version: file.version });
    for (const vector of file.vectors) {
      const layout = module[vector.record] as RecordLayout | undefined;
      expect(layout, `${name}/${vector.name}: ${vector.record} is generated`).toBeDefined();
      if (!layout) continue;
      expect(layout.opcode >> 8, `${name}/${vector.name}: the opcode's high byte is the family id`).toBe(family.id);
      const bytes = Uint8Array.from(Buffer.from(vector.hex, "hex"));
      expect(bytes.length, `${name}/${vector.name}: stride`).toBe(layout.stride);
      const decoded = decode(layout, bytes);
      expect(decoded.opcode).toBe(layout.opcode);
      expect(decoded.version).toBe(family.version);
      // f32 values compare at f32 precision: the JSON carries Rust's shortest round-trip text.
      const expected = Object.fromEntries(
        Object.entries(vector.values).map(([k, v]) => [k, layout.fields[k]?.type === "f32" ? Math.fround(v) : v]),
      );
      expect(decoded.values, `${name}/${vector.name}: decoded values`).toEqual(expected);
      expect(hex(encode(layout, vector.values)), `${name}/${vector.name}: re-encoded bytes`).toBe(vector.hex);
    }
  });
});

describe("the core's init through the committed wasm", () => {
  initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const reply = (values: Record<string, number>) => decode(core.MEMORY_NEEDED, init(encode(core.INIT, values)));

  it("answers an INIT record with the memory it needs", () => {
    const small = reply({ maxInstances: 16, maxBones: 64, arenaInitialBytes: 1 << 20 });
    expect(small.opcode).toBe(core.MEMORY_NEEDED.opcode);
    expect(small.version).toBe(core.CORE_FAMILY.version);
    expect(small.values.status).toBe(core.STATUS_OK);
    expect(small.values.bytes).toBeGreaterThanOrEqual(1 << 20);
    expect(small.values.pages).toBe(Math.ceil(small.values.bytes / 65536));
    const more = reply({ maxInstances: 16, maxBones: 128, arenaInitialBytes: 1 << 20 });
    expect(more.values.bytes).toBeGreaterThan(small.values.bytes);
  });

  it("refuses a record of another version", () => {
    const bytes = encode(core.INIT, { maxInstances: 1, maxBones: 1, arenaInitialBytes: 0 });
    new DataView(bytes.buffer).setUint16(core.WIRE_HEADER.version, core.CORE_FAMILY.version + 1, true);
    const r = decode(core.MEMORY_NEEDED, init(bytes));
    expect(r.values).toEqual({ status: core.STATUS_BAD_RECORD, bytes: 0, pages: 0 });
  });

  it("refuses a short record", () => {
    expect(decode(core.MEMORY_NEEDED, init(new Uint8Array(4))).values.status).toBe(core.STATUS_BAD_RECORD);
  });

  it("reports parameters that need more than 4 GiB", () => {
    const r = reply({ maxInstances: 0xffffffff, maxBones: 0xffffffff, arenaInitialBytes: 0 });
    expect(r.values).toEqual({ status: core.STATUS_TOO_LARGE, bytes: 0, pages: 0 });
  });
});
