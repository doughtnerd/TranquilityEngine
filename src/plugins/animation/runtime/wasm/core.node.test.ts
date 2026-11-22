// ADR 0340: the committed animation core, end to end in Node. Loads myco_anim_bg.wasm through its glue (`initSync`),
// loads the fixture skeleton and clips (written by native/anim/crates/anim-wasm/tests/fixtures.rs with anim-format and
// anim-compress), plays and crossfades through the commands and views laid out by the generated wire constants, and
// compares the bone matrices with the values anim-offline (f64) computed for the same playback. This runs the wasm
// simd128 path: sampling, blending, model space and skinning matrices. Tolerance: fixtures/expected.json's (1e-4 on
// matrix entries; f32 against f64 over a short bone chain, see the fixture generator).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./wire/core";
import * as tracks from "./wire/tracks";
import {
  changes_ptr,
  commands_ptr,
  create_instance,
  evaluate,
  init,
  initSync,
  last_status,
  load_clip,
  load_skeleton,
  matrices_ptr,
  restore,
  snapshot,
  snapshot_bytes,
  tracks_ptr,
  write_inputs,
} from "./myco_anim.js";

type ScalarType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";
interface RecordLayout {
  readonly opcode: number;
  readonly version: number;
  readonly stride: number;
  readonly fields: Readonly<Record<string, { readonly offset: number; readonly type: ScalarType }>>;
}

interface Expected {
  maxBones: number;
  bones: number;
  dt: number;
  tolerance: number;
  eventTime: number;
  play: number[];
  crossfade: number[];
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("./fixtures/expected.json", import.meta.url), "utf8")) as Expected;

/** Writes `values` as `layout` at `at` in `view` (header first). */
function put(view: DataView, at: number, layout: RecordLayout, values: Record<string, number>): number {
  view.setUint16(at + core.WIRE_HEADER.opcode, layout.opcode, true);
  view.setUint16(at + core.WIRE_HEADER.version, layout.version, true);
  for (const [name, f] of Object.entries(layout.fields)) {
    const v = values[name] ?? 0;
    const o = at + f.offset;
    if (f.type === "f32") view.setFloat32(o, v, true);
    else view.setUint32(o, v >>> 0, true);
  }
  return layout.stride;
}

/** Reads a record of `layout` at `at`. */
function get(view: DataView, at: number, layout: RecordLayout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, f] of Object.entries(layout.fields)) {
    out[name] = f.type === "f32" ? view.getFloat32(at + f.offset, true) : view.getUint32(at + f.offset, true);
  }
  return out;
}

describe("animation core in Node", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const memory = (): DataView => new DataView(exports.memory.buffer);
  const initBytes = new Uint8Array(core.INIT.stride);
  put(new DataView(initBytes.buffer), 0, core.INIT, { maxInstances: 4, maxBones: expected.maxBones, arenaInitialBytes: 1 << 20 });
  const reply = get(new DataView(init(initBytes).buffer), 0, core.MEMORY_NEEDED);
  const skel = load_skeleton(fixture("small.skel"));
  const walk = load_clip(fixture("walk.anim"));
  const run = load_clip(fixture("run.anim"));
  const dt = Math.fround(expected.dt);

  const send = (records: [RecordLayout, Record<string, number>][]): number => {
    const view = memory();
    let at = commands_ptr();
    const start = at;
    for (const [layout, values] of records) at += put(view, at, layout, values);
    return write_inputs(at - start);
  };
  const frame = (): number => {
    write_inputs(0);
    return evaluate(0, core.PASS_NORMAL, dt, dt);
  };
  const matrices = (instance: number): Float32Array => {
    const row = (instance & core.HANDLE_INDEX_MASK) * expected.maxBones * core.MATRIX_FLOATS;
    return new Float32Array(exports.memory.buffer, matrices_ptr() + row * 4, expected.bones * core.MATRIX_FLOATS).slice();
  };
  const maxDiff = (a: Float32Array, b: number[]): number => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);
  /** The `tracks` Event records of instance `h` this frame. */
  const events = (h: number): Record<string, number>[] => {
    const view = memory();
    const base = tracks_ptr() + (h & core.HANDLE_INDEX_MASK) * core.TRACK_STRIDE;
    const header = get(view, base + core.TRACK_HEADER, tracks.OUTPUT_HEADER);
    const out: Record<string, number>[] = [];
    let at = base + core.TRACK_RECORDS;
    const end = at + header.recordBytes!;
    while (at < end) {
      const opcode = view.getUint16(at, true);
      const layouts = (Object.values(tracks) as unknown[]).filter(
        (v): v is RecordLayout => typeof v === "object" && v !== null && "opcode" in v,
      );
      const layout = layouts.find((l) => l.opcode === opcode);
      if (!layout) throw new Error(`unknown opcode ${opcode}`);
      if (layout.opcode === tracks.EVENT.opcode) out.push(get(view, at, layout));
      at += layout.stride;
    }
    return out;
  };

  it("starts and loads the fixtures", () => {
    expect(reply.status).toBe(core.STATUS_OK);
    expect(reply.bytes).toBeGreaterThan(0);
    expect([skel, walk, run].every((h) => h !== 0), `last status ${last_status()}`).toBe(true);
  });

  it("plays a clip and crossfades to another, matching anim-offline", () => {
    const h = create_instance(0, skel, 0);
    expect(h).not.toBe(0);
    expect(send([[core.PLAY, { instance: h, clip: walk, playId: 1, layer: 0, fade: 0, speed: 1, start: 0, flags: 0 }]])).toBe(1);
    const fired: number[] = [];
    for (let f = 1; f <= 10; f++) {
      frame();
      if (events(h).some((e) => e.clip === walk && e.method === 0)) fired.push(f);
    }
    expect(maxDiff(matrices(h), expected.play)).toBeLessThan(expected.tolerance);
    // The clip's notify at 0.2 s fired once, through the wasm, on frame 6 or 7 (f32 playhead).
    expect(fired.length).toBe(1);
    expect(Math.abs(fired[0]! * dt - expected.eventTime)).toBeLessThanOrEqual(dt + 1e-6);

    expect(send([[core.PLAY, { instance: h, clip: run, playId: 2, layer: 0, fade: 0.5, speed: 1, start: 0, flags: 0 }]])).toBe(1);
    const interrupted = get(memory(), changes_ptr(), core.STATE_CHANGE);
    expect([interrupted.kind, interrupted.playId, interrupted.instance]).toEqual([core.CHANGE_INTERRUPTED, 1, h]);
    evaluate(0, core.PASS_NORMAL, dt, dt);
    for (let f = 0; f < 5; f++) frame();
    expect(maxDiff(matrices(h), expected.crossfade)).toBeLessThan(expected.tolerance);
  });

  it("restores a snapshot to identical later frames", () => {
    const h = create_instance(0, skel, 0);
    send([[core.PLAY, { instance: h, clip: walk, playId: 0, layer: 0, fade: 0, speed: 1, start: 0, flags: 0 }]]);
    for (let f = 0; f < 4; f++) frame();
    send([[core.PLAY, { instance: h, clip: run, playId: 0, layer: 0, fade: 0.3, speed: 1, start: 0, flags: core.PLAY_INERTIALIZE }]]);
    evaluate(0, core.PASS_NORMAL, dt, dt);
    const snap = new Uint8Array(snapshot_bytes(h));
    expect(snapshot(h, snap)).toBe(core.STATUS_OK);
    const record = (): Float32Array[] => Array.from({ length: 6 }, () => (frame(), matrices(h)));
    const first = record();
    expect(restore(h, snap)).toBe(core.STATUS_OK);
    expect(record()).toEqual(first);
  });
});
