// The compiled animation formats' header reader (ADR 0370, 0371, D14) on the core's committed fixtures
// (`src/plugins/animation/runtime/wasm/fixtures/`, written by `anim-format`'s writers) and on copies corrupted here, one
// container rule each: a file the core would refuse is refused with a problem, never misread. The pose database has no
// committed fixture, so one is built here from `posedb.rs`'s layout table.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { animationBinaryFormat, readAnimationHeader, type AnimationBinaryHeader, type BinarySection } from "./binaryHeader";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../plugins/animation/runtime/wasm/fixtures/${name}`, import.meta.url)));

function header(bytes: Uint8Array): AnimationBinaryHeader {
  const read = readAnimationHeader(bytes);
  if (!read.ok) throw new Error(read.problem);
  return read.header;
}

const names = (h: AnimationBinaryHeader) => h.sections.map((s) => s.name);

describe("the compiled animation header reader", () => {
  it("reads a compressed clip (walk.anim)", () => {
    const h = header(fixture("walk.anim"));
    expect(h).toMatchObject({ format: "myco.anim@1", version: 1, flags: 1, length: fixture("walk.anim").length, name: null });
    expect(h.info).toEqual({ kind: "clip", duration: 2, rate: 30, frames: 61, tracks: 13, bones: 12, keys: 1, loop: true, additive: false, slerp: false, raw: false, compressed: true, rootCurve: true });
    expect(names(h)).toEqual(["STRINGS", "INFO", "TRACKS", "KEYS", "ROOT_CURVE", "COMP_INFO", "COMP_CHANNELS", "COMP_CONSTANTS", "COMP_CLIP_RANGES", "COMP_SEGMENTS", "COMP_BIT_RATES", "COMP_SEGMENT_RANGES", "COMP_DATA"]);
  });

  it("reads a raw clip (graph_shot.anim)", () => {
    expect(header(fixture("graph_shot.anim")).info).toMatchObject({ kind: "clip", loop: false, raw: true, compressed: false, keys: 0, tracks: 12 });
  });

  it("reads skeletons with and without their optional sections", () => {
    expect(header(fixture("small.skel")).info).toEqual({ kind: "skeleton", bones: 12, profile: null, roles: false, jointRanges: false, mirror: false });
    expect(header(fixture("rig.skel")).info).toEqual({ kind: "skeleton", bones: 24, profile: null, roles: true, jointRanges: true, mirror: false });
  });

  it("reads a compiled graph (loco.animgraph)", () => {
    expect(header(fixture("loco.animgraph")).info).toEqual({ kind: "graph", nodes: 9, parameters: 4, machines: 1, states: 3, transitions: 4, slots: 1, linked: 0, layers: 0, skeleton: null });
  });

  it("reads a pose database built from posedb.rs's layout", () => {
    const h = header(poseDb());
    expect(h.format).toBe("myco.posedb@1");
    expect(h.info).toEqual({ kind: "posedb", frames: 2, dims: 3, features: 1, clips: 1, tags: 1, rate: 30, kdTree: false, skeleton: "hero" });
  });

  it("names a file's format by its magic", () => {
    expect(animationBinaryFormat(fixture("walk.anim"))).toBe("myco.anim@1");
    expect(animationBinaryFormat(fixture("small.skel"))).toBe("myco.skel@1");
    expect(animationBinaryFormat(fixture("loco.animgraph"))).toBe("myco.animgraph@1");
    expect(animationBinaryFormat(poseDb())).toBe("myco.posedb@1");
    expect(animationBinaryFormat(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  // --- refusals -----------------------------------------------------------------------------------------------------

  const walk = () => fixture("walk.anim");
  const sectionsOf = (b: Uint8Array): readonly BinarySection[] => header(b).sections;
  const entryAt = (b: Uint8Array, name: string) => 32 + 16 * sectionsOf(b).findIndex((s) => s.name === name);
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const edit = (change: (b: Uint8Array, v: DataView) => void) => {
    const b = walk();
    change(b, view(b));
    return b;
  };
  const refused = (b: Uint8Array, expect?: Parameters<typeof readAnimationHeader>[1]) => {
    const read = readAnimationHeader(b, expect);
    return read.ok ? "accepted" : read.problem;
  };

  it.each<[string, () => Uint8Array, string]>([
    ["truncated header", () => walk().subarray(0, 20), "truncated: a header needs 32 bytes, the file has 20."],
    ["bad magic", () => edit((b) => (b[0] = 0x58)), "bad magic: not a compiled animation file."],
    ["another version", () => edit((_, v) => v.setUint32(8, 2, true)), "unsupported version 2 (this build reads version 1 of myco.anim@1)."],
    ["an unknown flag bit", () => edit((_, v) => v.setUint32(12, 1 | 8, true)), "unknown header flags 0x9."],
    ["a length that doesn't match", () => walk().subarray(0, walk().length - 4), `length mismatch: the header says ${walk().length} bytes, the file has ${walk().length - 4}.`],
    ["a reserved word set", () => edit((_, v) => v.setUint32(28, 1, true)), "the header's reserved words aren't 0."],
    ["a section table past the end", () => edit((_, v) => v.setUint32(20, 10000, true)), `truncated: 10000 section entries need ${32 + 16 * 10000} bytes, the file has ${walk().length}.`],
    ["an unknown section kind", () => edit((b, v) => v.setUint32(entryAt(b, "KEYS"), 7, true)), "unknown section kind 7."],
    ["a section twice", () => edit((b, v) => v.setUint32(entryAt(b, "INFO"), 1, true)), "section STRINGS appears twice."],
    ["a misaligned section", () => edit((b, v) => v.setUint32(entryAt(b, "ROOT_CURVE") + 4, v.getUint32(entryAt(b, "ROOT_CURVE") + 4, true) + 4, true)), "section ROOT_CURVE at"],
    ["a section out of bounds", () => edit((b, v) => v.setUint32(entryAt(b, "COMP_DATA") + 8, 1 << 20, true)), "section COMP_DATA"],
    ["overlapping sections", () => edit((b, v) => v.setUint32(entryAt(b, "TRACKS") + 4, v.getUint32(entryAt(b, "INFO") + 4, true), true)), "section TRACKS overlaps the one before it."],
    ["a record count that doesn't fit the length", () => edit((b, v) => v.setUint32(entryAt(b, "TRACKS") + 12, 14, true)), "section TRACKS's length is 416, expected 448 for 14 records."],
    ["a partial compressed group", () => edit((_, v) => v.setUint32(20, v.getUint32(20, true) - 1, true)), "the compressed sections must all be present or all absent."],
    ["info disagreeing with the tracks", () => edit((b, v) => v.setUint32(sectionsOf(b).find((s) => s.name === "INFO")!.offset + 12, 12, true)), "the clip's info says 12 tracks, the TRACKS section holds 13."],
    ["a name naming no string", () => edit((b, v) => v.setUint32(sectionsOf(b).find((s) => s.name === "INFO")!.offset + 16, 999, true)), "the info record names a string the string table doesn't hold."],
    ["a non-finite duration", () => edit((b, v) => v.setFloat32(sectionsOf(b).find((s) => s.name === "INFO")!.offset, NaN, true)), "the clip's duration isn't a finite number ≥ 0."],
  ])("refuses a clip with %s", (_label, make, problem) => {
    const got = refused(make());
    expect(got.startsWith(problem), got).toBe(true);
  });

  it("refuses non-zero padding in a record section", () => {
    // humanoid_run.anim's COMP_DATA holds 12709 bytes in a 12712-byte section: three bytes of padding.
    const b = fixture("humanoid_run.anim");
    const data = sectionsOf(b).find((x) => x.name === "COMP_DATA")!;
    expect([data.count, data.length]).toEqual([12709, 12712]);
    b[data.offset + data.length - 1] = 1;
    expect(refused(b)).toBe("section COMP_DATA's padding isn't 0.");
  });

  it("refuses a file of another format than the one expected", () => {
    expect(refused(fixture("small.skel"), "myco.anim@1")).toBe('bad magic: expected "MYCOANIM" (myco.anim@1).');
    expect(refused(walk(), "myco.anim@1")).toBe("accepted");
  });

  it("refuses a skeleton whose optional section doesn't have one entry per bone", () => {
    // rig.skel's ROLES holds 24 u16 in 48 bytes; 23 entries (the last zeroed as padding) still fill 48 bytes, so only
    // the per-bone rule catches it.
    const b = fixture("rig.skel");
    const roles = sectionsOf(b).find((x) => x.name === "ROLES")!;
    const entry = entryAt(b, "ROLES");
    view(b).setUint16(roles.offset + 46, 0, true);
    view(b).setUint32(entry + 12, 23, true);
    expect(refused(b)).toBe("section ROLES must hold one entry per bone.");
  });

  it("refuses a graph whose output node is out of range", () => {
    const b = fixture("loco.animgraph");
    const info = header(b).sections.find((s) => s.name === "INFO")!;
    view(b).setUint32(info.offset + 4, 9, true);
    expect(refused(b)).toBe("the graph's output node is out of range.");
  });

  it("refuses a pose database with tags but no tag names, or a missing required section", () => {
    expect(refused(poseDb({ dropTagNames: true }))).toBe("TAG_NAMES and TAGS come together.");
    expect(refused(poseDb({ dropFrames: true }))).toBe("section FRAMES is missing.");
  });

  it("refuses a string table that isn't UTF-8 or whose padding isn't 0", () => {
    expect(refused(poseDb({ badUtf8: true }))).toBe("string 0 isn't UTF-8.");
    expect(refused(poseDb({ dirtyPadding: true }))).toBe("the string table's padding isn't 0.");
  });
});

// --- a pose database, written from posedb.rs's layout -------------------------------------------------------------------

interface PoseDbOptions { dropTagNames?: boolean; dropFrames?: boolean; badUtf8?: boolean; dirtyPadding?: boolean }

/** Little-endian words. */
function words(values: readonly (number | ["f", number])[]): Uint8Array {
  const b = new Uint8Array(values.length * 4);
  const v = new DataView(b.buffer);
  values.forEach((x, i) => (Array.isArray(x) ? v.setFloat32(i * 4, x[1], true) : v.setUint32(i * 4, x, true)));
  return b;
}

/** A container (`container.rs`): header, table, then each section 16-byte aligned, in kind order. */
function container(magic: string, sections: readonly { kind: number; count: number; data: Uint8Array }[]): Uint8Array {
  const tableEnd = 32 + 16 * sections.length;
  const at: number[] = [];
  let end = tableEnd;
  for (const s of sections) {
    end = (end + 15) & ~15;
    at.push(end);
    end += s.data.length;
  }
  const b = new Uint8Array(end);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 8; i++) b[i] = magic.charCodeAt(i);
  v.setUint32(8, 1, true);
  v.setUint32(16, end, true);
  v.setUint32(20, sections.length, true);
  sections.forEach((s, i) => {
    const e = 32 + 16 * i;
    v.setUint32(e, s.kind, true);
    v.setUint32(e + 4, at[i], true);
    v.setUint32(e + 8, s.data.length, true);
    v.setUint32(e + 12, s.count, true);
    b.set(s.data, at[i]);
  });
  return b;
}

function poseDb(o: PoseDbOptions = {}): Uint8Array {
  // Strings: "hero" (skeleton), "clip.anim.json", "idle" (a tag): end offsets 0, 4, 18, 22; 16 + 22 = 38 bytes, padded to 40.
  const chars = new TextEncoder().encode("heroclip.anim.jsonidle");
  if (o.badUtf8) chars[0] = 0xff;
  const strings = new Uint8Array(40);
  strings.set(words([0, 4, 18, 22]));
  strings.set(chars, 16);
  if (o.dirtyPadding) strings[39] = 1;
  const f = (x: number): ["f", number] => ["f", x];
  const sections = [
    { kind: 1, count: 3, data: strings },
    // INFO: frames 2, dims 3, row stride 4, features 1, clips 1, tags 1, rate 30, skeleton "hero".
    { kind: 2, count: 1, data: words([2, 3, 4, 1, 1, 1, f(30), 0]) },
    // FEATURES: bone position (kind 0, 3 dims) of bone 0, first dim 0, weight 1, no time offset, no name.
    { kind: 3, count: 1, data: words([0 | (3 << 16), 0, 0, f(1), f(0), 0xffffffff]) },
    { kind: 4, count: 6, data: words([f(0), f(0), f(0), f(1), f(1), f(1)]) },
    { kind: 5, count: 8, data: words([f(0), f(0), f(0), f(0), f(1), f(1), f(1), f(0)]) },
    { kind: 6, count: 2, data: words([0, f(0), 0, f(1 / 30)]) },
    { kind: 7, count: 1, data: words([1]) },
    { kind: 8, count: 1, data: words([2]) },
    { kind: 9, count: 2, data: words([1, 0]) },
  ].filter((s) => !(o.dropTagNames && s.kind === 8) && !(o.dropFrames && s.kind === 6));
  return container("MYCOPSDB", sections);
}
