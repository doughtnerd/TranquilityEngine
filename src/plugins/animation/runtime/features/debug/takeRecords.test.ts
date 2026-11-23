// The take's animation records (ADR 0348, T73): each payload round trips, a row that repeats the last is stored once, and a
// payload that doesn't read is refused rather than misread.
import { describe, expect, it } from "vitest";
import type { CompiledAnimGraph } from "../../../../../engine/animation/graphCompile";
import { INPUT_STRIDE } from "../../wasm/wire/core";
import { BLACKBOARD_STRIDE } from "../../wasm/wire/graph";
import { RIG_INPUT_STRIDE } from "../../wasm/wire/rig";
import type { RawFrame } from "./recorder";
import { RawDecoder, RawEncoder, TAKE_MAX_BEFORE, TAKE_MAX_COMMAND_BYTES, decodeKey, decodeSelect, decodeTarget, encodeKey, encodeSelect, encodeTarget, graphHash } from "./takeRecords";

const tables: CompiledAnimGraph = {
  bytes: new Uint8Array([1, 2, 3]),
  ok: true,
  problems: [{ path: "x", message: "dropped on encode", severity: "error" }],
  strings: ["Jump"],
  bindings: [],
  nodes: ["idle", "walk", "machine"],
  parameters: ["x", "moving"],
  machines: [{ node: "machine", states: ["Idle", "Walk"] }],
  slots: ["Attack"],
  linked: [],
  layers: ["Base"],
  ikTargets: [],
  rays: 0,
  transitions: ["nodes[2].machine.states[0].transitions[0]"],
  conditions: ["nodes[2].machine.states[0].transitions[0].if"],
};

const filled = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

function row(over: Partial<RawFrame> = {}): RawFrame {
  return { pass: 0, dt: 1 / 30, du: 1 / 30, input: filled(INPUT_STRIDE, 1), blackboard: filled(BLACKBOARD_STRIDE, 2), rig: filled(RIG_INPUT_STRIDE, 3), commands: new Uint8Array([9, 0, 0, 0, 7, 7, 7, 7]), starts: [0], complete: true, ...over };
}

describe("ANIM_TARGET", () => {
  it("round trips an Animator's identity and tables, without the graph's bytes and problems", () => {
    const payload = encodeTarget({ id: 3, label: "Hero (Main)", graph: "hero.animgraph.json", graphHash: graphHash(tables.bytes), bones: 12, tables })!;
    const read = decodeTarget(payload);
    if ("refused" in read) throw new Error(read.refused);
    expect(read.target).toMatchObject({ id: 3, label: "Hero (Main)", graph: "hero.animgraph.json", bones: 12, graphHash: graphHash(new Uint8Array([1, 2, 3])) });
    expect(read.target.tables).toEqual({ ...tables, bytes: null, problems: [] });
  });

  it("refuses cut-off payloads and tables that aren't lists of strings", () => {
    const payload = encodeTarget({ id: 0, label: "A", graph: "g", graphHash: 0, bones: 0, tables })!;
    for (const n of [0, 1, 5, 20, payload.length - 1]) expect("refused" in decodeTarget(payload.slice(0, n)), `${n} bytes`).toBe(true);
    const bad = encodeTarget({ id: 0, label: "A", graph: "g", graphHash: 0, bones: 0, tables: { ...tables, parameters: [1] as unknown as string[] } })!;
    expect(decodeTarget(bad)).toEqual({ refused: expect.stringContaining("tables.parameters") });
  });

  it("returns null for tables past the cap", () => {
    const huge = { ...tables, strings: Array.from({ length: 30000 }, (_, i) => `a fairly long string number ${i}`) };
    expect(encodeTarget({ id: 0, label: "A", graph: "g", graphHash: 0, bones: 0, tables: huge })).toBeNull();
  });
});

describe("ANIM_SELECT and ANIM_KEY", () => {
  it("round trip", () => {
    expect(decodeSelect(encodeSelect(7))).toEqual({ target: 7 });
    const snapshot = new Uint8Array([5, 4, 3, 2, 1]);
    expect(decodeKey(encodeKey(41, snapshot))).toEqual({ index: 41, snapshot });
    expect("refused" in decodeSelect(new Uint8Array(1))).toBe(true);
    expect("refused" in decodeKey(encodeKey(1, snapshot).slice(0, 7))).toBe(true);
  });
});

describe("ANIM_RAW", () => {
  it("round trips rows with the rows ahead of them, storing a row that repeats the last only once", () => {
    const enc = new RawEncoder();
    const dec = new RawDecoder();
    const first = row();
    const a = enc.encode(0, first, [])!;
    const second = row({ commands: new Uint8Array(0), starts: [], du: 1 / 60 });
    const b = enc.encode(1, second, [row({ pass: 1, dt: 0, blackboard: filled(BLACKBOARD_STRIDE, 8) })])!;
    expect(b.length).toBeLessThan(a.length); // the rows that didn't change aren't written again
    const ra = dec.decode(a);
    const rb = dec.decode(b);
    if ("refused" in ra || "refused" in rb) throw new Error("refused");
    expect(ra.index).toBe(0);
    expect(ra.raw).toEqual(first);
    expect(rb.index).toBe(1);
    expect(rb.before).toHaveLength(1);
    expect(rb.before[0]).toMatchObject({ pass: 1, dt: 0 });
    expect(Array.from(rb.before[0]!.blackboard)).toEqual(Array.from(filled(BLACKBOARD_STRIDE, 8)));
    expect(rb.raw).toEqual(second);
    expect(Array.from(rb.raw.blackboard)).toEqual(Array.from(filled(BLACKBOARD_STRIDE, 2))); // restored by the next row's own bytes
  });

  it("keeps the incomplete flag, and marks a frame with too many rows ahead of it incomplete", () => {
    const enc = new RawEncoder();
    const dec = new RawDecoder();
    const one = dec.decode(enc.encode(0, row({ complete: false }), [])!);
    if ("refused" in one) throw new Error(one.refused);
    expect(one.raw.complete).toBe(false);
    const many = Array.from({ length: TAKE_MAX_BEFORE + 1 }, () => row({ pass: 1 }));
    const two = dec.decode(enc.encode(1, row(), many)!);
    if ("refused" in two) throw new Error(two.refused);
    expect(two.before).toHaveLength(0);
    expect(two.raw.complete).toBe(false);
  });

  it("writes nothing for a row past the command cap, and refuses payloads that don't read", () => {
    const enc = new RawEncoder();
    expect(enc.encode(0, row({ commands: new Uint8Array(TAKE_MAX_COMMAND_BYTES + 4), starts: [0] }), [])).toBeNull();
    const payload = new RawEncoder().encode(0, row(), [])!;
    for (const n of [0, 3, 10, 100, payload.length - 1]) expect("refused" in new RawDecoder().decode(payload.slice(0, n)), `${n} bytes`).toBe(true);
    // A row that repeats a row nobody wrote.
    const second = new RawEncoder();
    second.encode(0, row(), []);
    expect("refused" in new RawDecoder().decode(second.encode(1, row(), [])!)).toBe(true);
    // A command that starts outside the commands.
    const outside = new RawEncoder().encode(0, row({ starts: [6] }), [])!;
    expect("refused" in new RawDecoder().decode(outside)).toBe(true);
  });
});
