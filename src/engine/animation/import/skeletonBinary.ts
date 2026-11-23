/**
 * An imported skeleton as a `myco.skel@1` file (ADR 0370, 0371), the layout `native/anim/crates/anim-format/src/
 * skeleton.rs` documents and its writer produces: the shared container (32-byte header, 16-byte section entries,
 * sections aligned to 16), then `STRINGS` (the bone names, then the skeleton's name), `INFO` and `BONES`. Roles,
 * joint ranges and mirror maps are the compile's (T19) to add; the import writes this file to ask the core for a bone
 * map (`guess_bone_map`), which reads names, parents and the rest pose.
 *
 * Pure. Internal: not public API.
 */
import type { ImportedSkeleton } from "./skeleton";

const MAGIC = "MYCOSKEL";
const VERSION = 1;
const NONE = 0xffffffff;
const NO_PARENT = 0xffff;
const SECTION = { STRINGS: 1, INFO: 2, BONES: 3 } as const;

const align = (n: number, a: number) => Math.ceil(n / a) * a;

/** The string table's bytes (end offsets, then the UTF-8 characters, zero-padded to 4). */
function stringTable(strings: readonly string[]): Uint8Array {
  const encoded = strings.map((s) => new TextEncoder().encode(s));
  const chars = encoded.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(align(4 * (strings.length + 1) + chars, 4));
  const view = new DataView(out.buffer);
  let end = 0;
  const base = 4 * (strings.length + 1);
  encoded.forEach((e, i) => {
    out.set(e, base + end);
    end += e.length;
    view.setUint32(4 * (i + 1), end, true);
  });
  return out;
}

/** @internal The skeleton as `myco.skel@1` bytes, named `name` (or nameless). */
export function encodeSkeleton(skeleton: ImportedSkeleton, name = ""): Uint8Array {
  const bones = skeleton.bones;
  const strings = [...bones.map((b) => b.name), ...(name ? [name] : [])];
  const info = new Uint8Array(16);
  const iv = new DataView(info.buffer);
  iv.setUint32(0, name ? bones.length : NONE, true);
  iv.setUint32(4, NONE, true);
  iv.setUint32(8, 0, true); // mirror axis x
  iv.setUint32(12, bones.length, true);
  const records = new Uint8Array(bones.length * 96);
  const bv = new DataView(records.buffer);
  bones.forEach((b, i) => {
    const at = i * 96;
    bv.setUint32(at, i, true);
    bv.setUint16(at + 4, b.parent < 0 ? NO_PARENT : b.parent, true);
    bv.setUint16(at + 6, 0, true);
    const f = [...b.rest.position, ...b.rest.rotation, ...b.rest.scale, ...skeleton.inverseBinds.subarray(i * 12, i * 12 + 12)];
    f.forEach((v, k) => bv.setFloat32(at + 8 + k * 4, v, true));
  });
  const sections: { kind: number; count: number; bytes: Uint8Array }[] = [
    { kind: SECTION.STRINGS, count: strings.length, bytes: stringTable(strings) },
    { kind: SECTION.INFO, count: 1, bytes: info },
    { kind: SECTION.BONES, count: bones.length, bytes: records },
  ];
  let at = align(32 + 16 * sections.length, 16);
  const placed = sections.map((s) => {
    const offset = at;
    at = align(offset + s.bytes.length, 16);
    return { ...s, offset };
  });
  const length = placed[placed.length - 1].offset + placed[placed.length - 1].bytes.length;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint32(8, VERSION, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, length, true);
  view.setUint32(20, placed.length, true);
  placed.forEach((s, i) => {
    const e = 32 + i * 16;
    view.setUint32(e, s.kind, true);
    view.setUint32(e + 4, s.offset, true);
    view.setUint32(e + 8, s.bytes.length, true);
    view.setUint32(e + 12, s.count, true);
    out.set(s.bytes, s.offset);
  });
  return out;
}
