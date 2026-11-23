/**
 * The compiled animation formats' headers, read in TypeScript (ADR 0370, 0371): `myco.anim@1`, `myco.skel@1`,
 * `myco.animgraph@1` and `myco.posedb@1` share one container (`native/anim/crates/anim-format/src/container.rs`, the
 * contract): a 32-byte header (8-byte magic, u32 version, flags, file length, section count, two reserved zeros), a
 * table of 16-byte section entries (kind, offset, length, count), then the sections, little-endian.
 *
 * `readAnimationHeader` checks what `container::parse` checks (magic, version, known flags, length, reserved words,
 * every section entry: a known kind at most once, aligned, in bounds, ascending and non-overlapping, a record section's
 * length `align4(count × stride)` with zero padding, required sections present) plus each format's section groups, and
 * reads the info record and the name from the string table. Anything off is refused with a problem rather than
 * misread (D14), so the loader and the editor can show a file's facts without the core. Deeper checks (key ranges,
 * enum values, acyclicity) stay the core's.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */

/** @internal The four compiled formats. */
export type AnimationBinaryFormat = "myco.anim@1" | "myco.skel@1" | "myco.animgraph@1" | "myco.posedb@1";

/** @internal One section as the table lists it. */
export interface BinarySection {
  readonly kind: number;
  readonly name: string;
  readonly offset: number;
  readonly length: number;
  readonly count: number;
}

/** @internal What a valid file's header and info record say. Per format, `info` holds that format's facts. */
export interface AnimationBinaryHeader {
  readonly format: AnimationBinaryFormat;
  readonly version: number;
  readonly flags: number;
  readonly length: number;
  readonly sections: readonly BinarySection[];
  /** The name in the info record (clip, skeleton, graph), or null. */
  readonly name: string | null;
  readonly info: ClipInfo | SkeletonInfo | GraphInfo | PoseDatabaseInfo;
}
export interface ClipInfo {
  readonly kind: "clip";
  readonly duration: number;
  readonly rate: number;
  readonly frames: number;
  readonly tracks: number;
  readonly bones: number;
  readonly keys: number;
  readonly loop: boolean;
  readonly additive: boolean;
  readonly slerp: boolean;
  readonly raw: boolean;
  readonly compressed: boolean;
  readonly rootCurve: boolean;
}
export interface SkeletonInfo {
  readonly kind: "skeleton";
  readonly bones: number;
  readonly profile: string | null;
  readonly roles: boolean;
  readonly jointRanges: boolean;
  readonly mirror: boolean;
}
export interface GraphInfo {
  readonly kind: "graph";
  readonly nodes: number;
  readonly parameters: number;
  readonly machines: number;
  readonly states: number;
  readonly transitions: number;
  readonly slots: number;
  readonly linked: number;
  readonly layers: number;
  readonly skeleton: string | null;
}
export interface PoseDatabaseInfo {
  readonly kind: "posedb";
  readonly frames: number;
  readonly dims: number;
  readonly features: number;
  readonly clips: number;
  readonly tags: number;
  readonly rate: number;
  readonly kdTree: boolean;
  readonly skeleton: string | null;
}

/** @internal A header read, or why the bytes were refused. */
export type HeaderRead = { readonly ok: true; readonly header: AnimationBinaryHeader } | { readonly ok: false; readonly problem: string };

type Layout = number | "custom";
interface SectionSpec { readonly kind: number; readonly name: string; readonly align: 4 | 16; readonly layout: Layout; readonly required: boolean }
interface FormatSpec { readonly format: AnimationBinaryFormat; readonly magic: string; readonly knownFlags: number; readonly sections: readonly SectionSpec[] }

const s = (kind: number, name: string, align: 4 | 16, layout: Layout, required = false): SectionSpec => ({ kind, name, align, layout, required });

/** The four formats' section tables (each module's docs in `anim-format/src/`). */
const SPECS: readonly FormatSpec[] = [
  {
    format: "myco.anim@1", magic: "MYCOANIM", knownFlags: 1 | 2 | 4,
    sections: [
      s(1, "STRINGS", 4, "custom", true), s(2, "INFO", 4, 32, true), s(3, "TRACKS", 4, 32, true), s(4, "KEYS", 4, 32), s(5, "RAW", 16, 4), s(6, "ROOT_CURVE", 16, 16),
      s(16, "COMP_INFO", 4, 32), s(17, "COMP_CHANNELS", 4, 16), s(18, "COMP_CONSTANTS", 16, 4), s(19, "COMP_CLIP_RANGES", 16, 4), s(20, "COMP_SEGMENTS", 4, 16),
      s(21, "COMP_BIT_RATES", 4, 1), s(22, "COMP_SEGMENT_RANGES", 4, 1), s(23, "COMP_DATA", 16, 1),
    ],
  },
  {
    format: "myco.skel@1", magic: "MYCOSKEL", knownFlags: 0,
    sections: [s(1, "STRINGS", 4, "custom", true), s(2, "INFO", 4, 16, true), s(3, "BONES", 16, 96, true), s(4, "ROLES", 4, 2), s(5, "JOINT_RANGES", 4, 16), s(6, "MIRROR", 4, 4)],
  },
  {
    format: "myco.animgraph@1", magic: "MYCOAGPH", knownFlags: 0,
    sections: [
      s(1, "STRINGS", 4, "custom", true), s(2, "INFO", 4, 16, true), s(3, "PARAMS", 4, 24), s(4, "NODES", 4, 24, true), s(5, "NODE_INPUTS", 4, 4), s(6, "PARAM_BLOCKS", 4, 4),
      s(7, "MACHINES", 4, 32), s(8, "STATES", 4, 24), s(9, "TRANSITIONS", 4, 40), s(10, "INTERRUPTS", 4, 4), s(11, "CONDITION_PROGRAMS", 4, 8), s(12, "CONDITION_NODES", 4, 16),
      s(13, "SLOTS", 4, 16), s(14, "LINKED", 4, 16), s(15, "LAYERS", 4, 24), s(16, "CHOOSERS", 4, 16), s(17, "CHOOSER_ROWS", 4, 8),
    ],
  },
  {
    format: "myco.posedb@1", magic: "MYCOPSDB", knownFlags: 0,
    sections: [
      s(1, "STRINGS", 4, "custom", true), s(2, "INFO", 4, 32, true), s(3, "FEATURES", 4, 24, true), s(4, "NORMALIZATION", 16, 4, true), s(5, "MATRIX", 16, 4, true),
      s(6, "FRAMES", 4, 8, true), s(7, "CLIPS", 4, 4, true), s(8, "TAG_NAMES", 4, 4), s(9, "TAGS", 4, 4), s(10, "KD_NODES", 4, 16), s(11, "KD_INDICES", 4, 4),
    ],
  },
];

/** @internal The format a file's magic names, or null. */
export function animationBinaryFormat(bytes: Uint8Array): AnimationBinaryFormat | null {
  if (bytes.length < 8) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  return SPECS.find((f) => f.magic === magic)?.format ?? null;
}

const HEADER_LEN = 32;
const ENTRY_LEN = 16;
const NONE = 0xffffffff;
const align4 = (n: number) => (n + 3) & ~3;

/**
 * @internal Validates `bytes` as one of the compiled animation formats (`expect`, or whichever its magic names) and
 * returns its header, section table and info; refuses (`ok: false`, one problem) anything the core would refuse at
 * the container level.
 */
export function readAnimationHeader(bytes: Uint8Array, expect?: AnimationBinaryFormat): HeaderRead {
  const fail = (problem: string): HeaderRead => ({ ok: false, problem });
  if (bytes.length < HEADER_LEN) return fail(`truncated: a header needs ${HEADER_LEN} bytes, the file has ${bytes.length}.`);
  const found = animationBinaryFormat(bytes);
  const spec = SPECS.find((f) => f.format === (expect ?? found));
  if (!spec || (expect && found !== expect)) return fail(expect ? `bad magic: expected "${SPECS.find((f) => f.format === expect)!.magic}" (${expect}).` : "bad magic: not a compiled animation file.");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => v.getUint32(at, true);
  const version = u32(8);
  if (version !== 1) return fail(`unsupported version ${version} (this build reads version 1 of ${spec.format}).`);
  const flags = u32(12);
  if ((flags & ~spec.knownFlags) !== 0) return fail(`unknown header flags 0x${flags.toString(16)}.`);
  const length = u32(16);
  if (length !== bytes.length) return fail(`length mismatch: the header says ${length} bytes, the file has ${bytes.length}.`);
  if (u32(24) !== 0 || u32(28) !== 0) return fail("the header's reserved words aren't 0.");
  const count = u32(20);
  const tableEnd = HEADER_LEN + count * ENTRY_LEN;
  if (tableEnd > bytes.length) return fail(`truncated: ${count} section entries need ${tableEnd} bytes, the file has ${bytes.length}.`);

  const sections: BinarySection[] = [];
  let prevEnd = tableEnd;
  for (let i = 0; i < count; i++) {
    const at = HEADER_LEN + i * ENTRY_LEN;
    const kind = u32(at), offset = u32(at + 4), len = u32(at + 8), n = u32(at + 12);
    const sp = spec.sections.find((x) => x.kind === kind);
    if (!sp) return fail(`unknown section kind ${kind}.`);
    if (sections.some((x) => x.kind === kind)) return fail(`section ${sp.name} appears twice.`);
    if (offset % sp.align !== 0) return fail(`section ${sp.name} at ${offset} isn't ${sp.align}-byte aligned.`);
    if (offset < tableEnd || offset + len > bytes.length) return fail(`section ${sp.name} (offset ${offset}, length ${len}) is out of bounds.`);
    if (offset < prevEnd) return fail(`section ${sp.name} overlaps the one before it.`);
    prevEnd = offset + len;
    if (sp.layout === "custom") {
      if (len % 4 !== 0) return fail(`section ${sp.name}'s length ${len} isn't a multiple of 4.`);
    } else {
      const used = n * sp.layout;
      if (used > NONE || len !== align4(used)) return fail(`section ${sp.name}'s length is ${len}, expected ${align4(used)} for ${n} records.`);
      for (let p = offset + used; p < offset + len; p++) if (bytes[p] !== 0) return fail(`section ${sp.name}'s padding isn't 0.`);
    }
    sections.push({ kind, name: sp.name, offset, length: len, count: n });
  }
  for (const sp of spec.sections) if (sp.required && !sections.some((x) => x.kind === sp.kind)) return fail(`section ${sp.name} is missing.`);

  const sec = (name: string) => sections.find((x) => x.name === name);
  const has = (name: string) => sec(name) !== undefined;
  const countOf = (name: string) => sec(name)?.count ?? 0;

  // The string table: n + 1 non-decreasing end offsets, then the characters (decoded lazily for the ids asked).
  const strings = sec("STRINGS")!;
  const nStrings = strings.count;
  const charsAt = strings.offset + 4 * (nStrings + 1);
  if (4 * (nStrings + 1) > strings.length) return fail("the string table is truncated.");
  const ends = (i: number) => u32(strings.offset + 4 * i);
  if (ends(0) !== 0) return fail("the string table's first offset isn't 0.");
  for (let i = 0; i < nStrings; i++) if (ends(i + 1) < ends(i)) return fail("the string table's offsets decrease.");
  if (strings.length !== align4(4 * (nStrings + 1) + ends(nStrings))) return fail("the string table's length doesn't match its offsets.");
  for (let p = charsAt + ends(nStrings); p < strings.offset + strings.length; p++) if (bytes[p] !== 0) return fail("the string table's padding isn't 0.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const table: string[] = [];
  try {
    for (let i = 0; i < nStrings; i++) table.push(decoder.decode(bytes.subarray(charsAt + ends(i), charsAt + ends(i + 1))));
  } catch {
    return fail(`string ${table.length} isn't UTF-8.`);
  }
  let badString = false;
  const str = (id: number): string | null => {
    if (id === NONE) return null;
    if (id >= nStrings) badString = true;
    return table[id] ?? null;
  };

  const infoAt = sec("INFO")!.offset;
  if (sec("INFO")!.count !== 1) return fail("the INFO section must hold exactly one record.");
  const f32 = (at: number) => v.getFloat32(at, true);
  let name: string | null = null;
  let info: AnimationBinaryHeader["info"];
  switch (spec.format) {
    case "myco.anim@1": {
      const comp = spec.sections.filter((x) => x.kind >= 16).map((x) => has(x.name));
      if (comp.some(Boolean) && !comp.every(Boolean)) return fail("the compressed sections must all be present or all absent.");
      const duration = f32(infoAt), rate = f32(infoAt + 4), frames = u32(infoAt + 8), tracks = u32(infoAt + 12);
      if (!Number.isFinite(duration) || duration < 0) return fail("the clip's duration isn't a finite number ≥ 0.");
      if (!Number.isFinite(rate) || rate <= 0) return fail("the clip's sample rate isn't a finite number > 0.");
      if (frames < 1) return fail("the clip has no frames.");
      if (tracks !== countOf("TRACKS")) return fail(`the clip's info says ${tracks} tracks, the TRACKS section holds ${countOf("TRACKS")}.`);
      if (has("ROOT_CURVE") && countOf("ROOT_CURVE") !== frames) return fail("the root curve doesn't have one record per frame.");
      if (u32(infoAt + 28) !== 0) return fail("the clip info's reserved word isn't 0.");
      name = str(u32(infoAt + 16));
      info = { kind: "clip", duration, rate, frames, tracks, bones: u32(infoAt + 20), keys: countOf("KEYS"), loop: (flags & 1) !== 0, additive: (flags & 2) !== 0, slerp: (flags & 4) !== 0, raw: has("RAW"), compressed: comp.every(Boolean), rootCurve: has("ROOT_CURVE") };
      break;
    }
    case "myco.skel@1": {
      const bones = u32(infoAt + 12);
      if (bones !== countOf("BONES")) return fail(`the skeleton's info says ${bones} bones, the BONES section holds ${countOf("BONES")}.`);
      if (bones > 0xffff) return fail("a skeleton holds at most 65535 bones.");
      if (u32(infoAt + 8) > 2) return fail("the mirror axis must be 0, 1 or 2.");
      for (const opt of ["ROLES", "JOINT_RANGES", "MIRROR"]) if (has(opt) && countOf(opt) !== bones) return fail(`section ${opt} must hold one entry per bone.`);
      name = str(u32(infoAt));
      info = { kind: "skeleton", bones, profile: str(u32(infoAt + 4)), roles: has("ROLES"), jointRanges: has("JOINT_RANGES"), mirror: has("MIRROR") };
      break;
    }
    case "myco.animgraph@1": {
      const nodes = countOf("NODES");
      if (nodes < 1) return fail("a graph has at least one node.");
      if (u32(infoAt + 4) >= nodes) return fail("the graph's output node is out of range.");
      if (u32(infoAt + 12) !== 0) return fail("the graph info's reserved word isn't 0.");
      name = str(u32(infoAt));
      info = {
        kind: "graph", nodes, parameters: countOf("PARAMS"), machines: countOf("MACHINES"), states: countOf("STATES"), transitions: countOf("TRANSITIONS"),
        slots: countOf("SLOTS"), linked: countOf("LINKED"), layers: countOf("LAYERS"), skeleton: str(u32(infoAt + 8)),
      };
      break;
    }
    case "myco.posedb@1": {
      if (has("TAG_NAMES") !== has("TAGS")) return fail("TAG_NAMES and TAGS come together.");
      if (has("KD_NODES") !== has("KD_INDICES")) return fail("KD_NODES and KD_INDICES come together.");
      const frames = u32(infoAt), dims = u32(infoAt + 4), stride = u32(infoAt + 8), features = u32(infoAt + 12), clips = u32(infoAt + 16), tags = u32(infoAt + 20), rate = f32(infoAt + 24);
      if (frames !== countOf("FRAMES")) return fail(`the database's info says ${frames} frames, the FRAMES section holds ${countOf("FRAMES")}.`);
      if (dims < 1 || stride !== align4(dims)) return fail("the database's dims or row stride are invalid.");
      if (features !== countOf("FEATURES") || clips !== countOf("CLIPS") || tags !== countOf("TAG_NAMES")) return fail("the database's info counts don't match its sections.");
      if (countOf("NORMALIZATION") !== 2 * dims || countOf("MATRIX") !== frames * stride) return fail("the normalisation or matrix size doesn't match the dims.");
      if (has("TAGS") && countOf("TAGS") !== frames * Math.ceil(tags / 32)) return fail("the tag bitsets don't have one row per frame.");
      if (!Number.isFinite(rate) || rate <= 0) return fail("the database's sample rate isn't a finite number > 0.");
      info = { kind: "posedb", frames, dims, features, clips, tags, rate, kdTree: has("KD_NODES"), skeleton: str(u32(infoAt + 28)) };
      break;
    }
  }
  if (badString) return fail("the info record names a string the string table doesn't hold.");
  return { ok: true, header: { format: spec.format, version, flags, length, sections, name, info } };
}
