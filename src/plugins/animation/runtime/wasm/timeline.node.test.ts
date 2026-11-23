// ADR 0371, 0372: tweens and timelines through the committed wasm, in Node. The tween table is driven with
// `TWEEN_CREATE`/`TWEEN_CONTROL` records and read through its value rows and change records; a timeline clip over a
// leaf clip (fixtures written by native/anim/crates/anim-wasm/tests/timeline_fixtures.rs) plays through
// `TIMELINE_CREATE`, a subclip bind, the block table, the value and weight views and the `tracks` records; a sequence
// of two tweens reports its members' completions. Values are f32 on both sides of exact arithmetic on binary
// fractions (tolerance 1e-3 only where a compressed clip is sampled).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./wire/core";
import * as timeline from "./wire/timeline";
import * as tracks from "./wire/tracks";
import * as tween from "./wire/tween";
import {
  create_instance,
  evaluate,
  init,
  initSync,
  load_clip,
  timeline_active_count,
  timeline_bind,
  timeline_block_bytes,
  timeline_blocks,
  timeline_changes_count,
  timeline_changes_ptr,
  timeline_control,
  timeline_create,
  timeline_create_sequence,
  timeline_info,
  timeline_records_len,
  timeline_records_ptr,
  timeline_values_ptr,
  timeline_weights_ptr,
  tween_changes_count,
  tween_changes_ptr,
  tween_columns_ptr,
  tween_control,
  tween_create,
  tween_values_count,
  tween_values_ptr,
  write_inputs,
} from "./myco_anim.js";

type ScalarType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";
interface RecordLayout {
  readonly opcode: number;
  readonly version: number;
  readonly stride: number;
  readonly fields: Readonly<Record<string, { readonly offset: number; readonly type: ScalarType }>>;
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Encodes `values` as `layout` (header first) into a fresh buffer. */
function encode(layout: RecordLayout, values: Record<string, number>): Uint8Array {
  const bytes = new Uint8Array(layout.stride);
  const view = new DataView(bytes.buffer);
  view.setUint16(core.WIRE_HEADER.opcode, layout.opcode, true);
  view.setUint16(core.WIRE_HEADER.version, layout.version, true);
  for (const [name, f] of Object.entries(layout.fields)) {
    const v = values[name] ?? 0;
    if (f.type === "f32") view.setFloat32(f.offset, v, true);
    else view.setUint32(f.offset, v >>> 0, true);
  }
  return bytes;
}

/** Decodes a record of `layout` at `at` in `view`. */
function decode(view: DataView, at: number, layout: RecordLayout): Record<string, number> {
  expect(view.getUint16(at + core.WIRE_HEADER.opcode, true)).toBe(layout.opcode);
  const out: Record<string, number> = {};
  for (const [name, f] of Object.entries(layout.fields)) {
    out[name] = f.type === "f32" ? view.getFloat32(at + f.offset, true) : view.getUint32(at + f.offset, true);
  }
  return out;
}

describe("tweens and timelines in Node", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const memory = (): DataView => new DataView(exports.memory.buffer);
  const reply = decode(
    new DataView(init(encode(core.INIT, { maxInstances: 4, maxBones: 16, arenaInitialBytes: 1 << 20 })).buffer),
    0,
    core.MEMORY_NEEDED,
  );
  const frame = (dt: number): void => {
    write_inputs(0);
    evaluate(0, core.PASS_NORMAL, dt, dt);
  };
  /** The tween rows of this frame: [column, x, y, z, w]. */
  const rows = (): number[][] => {
    const n = tween_values_count();
    const cols = new Uint32Array(exports.memory.buffer, tween_columns_ptr(), n);
    const vals = new Float32Array(exports.memory.buffer, tween_values_ptr(), n * 4);
    return Array.from({ length: n }, (_, i) => [cols[i]!, ...vals.subarray(i * 4, i * 4 + 4)]);
  };
  const tweenChanges = (): Record<string, number>[] =>
    Array.from({ length: tween_changes_count() }, (_, i) =>
      decode(memory(), tween_changes_ptr() + i * tween.TWEEN_CHANGE.stride, tween.TWEEN_CHANGE),
    );
  const timelineChanges = (): Record<string, number>[] =>
    Array.from({ length: timeline_changes_count() }, (_, i) =>
      decode(memory(), timeline_changes_ptr() + i * timeline.TIMELINE_CHANGE.stride, timeline.TIMELINE_CHANGE),
    );
  const spec = {
    world: 0,
    hostId: 1,
    column: 7,
    valueKind: tween.KIND_VALUE,
    width: 2,
    ease: tween.EASE_LINEAR,
    flags: 0,
    timeMode: tween.TIME_SCALED,
    loops: 1,
    duration: 1,
    delay: 0,
    speed: 1,
    from0: 0,
    from1: 10,
    to0: 4,
    to1: -10,
  };

  it("starts", () => {
    expect(reply.status).toBe(core.STATUS_OK);
  });

  it("runs a tween to its exact end value and reports it completed", () => {
    const h = tween_create(encode(tween.TWEEN_CREATE, spec));
    expect(h).not.toBe(0);
    const seen: number[][] = [];
    for (let f = 0; f < 4; f++) {
      frame(0.25);
      seen.push(rows()[0]!);
    }
    expect(seen).toEqual([
      [7, 1, 5, 0, 0],
      [7, 2, 0, 0, 0],
      [7, 3, -5, 0, 0],
      [7, 4, -10, 0, 0],
    ]);
    expect(tweenChanges()).toEqual([{ hostId: 1, handle: h, kind: tween.CHANGE_COMPLETED, cycle: 1 }]);
    // Gone: the handle is stale.
    expect(tween_control(encode(tween.TWEEN_CONTROL, { handle: h, op: tween.OP_PAUSE }))).toBe(core.STATUS_STALE_HANDLE);
  });

  it("applies an easing by id and resolves a destroyed target", () => {
    const eased = tween_create(encode(tween.TWEEN_CREATE, { ...spec, hostId: 2, column: 8, width: 1, ease: tween.EASE_OUT_QUAD, from0: 0, to0: 1 }));
    const doomed = tween_create(encode(tween.TWEEN_CREATE, { ...spec, hostId: 3, column: 9, width: 1 }));
    expect(tween_control(encode(tween.TWEEN_CONTROL, { handle: doomed, op: tween.OP_DESTROYED }))).toBe(core.STATUS_OK);
    frame(0.25);
    // out quad at 0.25: 1 - 0.75^2.
    expect(rows()).toEqual([[8, 0.4375, 0, 0, 0]]);
    expect(tweenChanges()).toEqual([{ hostId: 3, handle: doomed, kind: tween.CHANGE_DESTROYED, cycle: 0 }]);
    expect(tween_control(encode(tween.TWEEN_CONTROL, { handle: eased, op: tween.OP_KILL }))).toBe(core.STATUS_OK);
    frame(0.25);
    expect(rows()).toEqual([]);
    expect(tweenChanges().map((c) => [c.hostId, c.kind])).toEqual([[2, tween.CHANGE_KILLED]]);
  });

  it("plays a timeline clip over a nested subclip: values, weights and the nested clip's event", () => {
    const leaf = load_clip(fixture("timeline_leaf.anim"));
    const root = load_clip(fixture("timeline_root.anim"));
    expect(leaf).not.toBe(0);
    expect(root).not.toBe(0);
    const h = timeline_create(
      encode(timeline.TIMELINE_CREATE, { world: 0, hostId: 100, clip: root, timeMode: 0, wrap: timeline.WRAP_HOLD, flags: timeline.FLAG_PLAY, speed: 1, start: 0 }),
    );
    expect(h).not.toBe(0);
    expect(timeline_bind(h, root, 0, leaf)).toBe(core.STATUS_OK);
    // Info and blocks, read after the bind.
    const infoBytes = new Uint8Array(timeline.TIMELINE_INFO.stride);
    expect(timeline_info(h, infoBytes)).toBe(timeline.TIMELINE_INFO.stride);
    const info = decode(new DataView(infoBytes.buffer), 0, timeline.TIMELINE_INFO);
    expect(info.blocks).toBe(2);
    expect(info.duration).toBe(4);
    const blockBytes = new Uint8Array(timeline_block_bytes(h));
    expect(timeline_blocks(h, blockBytes)).toBe(blockBytes.length);
    const blocks = [0, 1].map((i) => decode(new DataView(blockBytes.buffer), i * timeline.TIMELINE_BLOCK.stride, timeline.TIMELINE_BLOCK));
    expect(blocks.map((b) => b.kind)).toEqual([timeline.BLOCK_ROOT, timeline.BLOCK_SUBCLIP]);

    const dt = 0.25;
    const fired: [number, number, number][] = [];
    for (let step = 1; step <= 14; step++) {
      frame(dt);
      expect(timeline_active_count()).toBe(1);
      const values = new Float32Array(exports.memory.buffer, timeline_values_ptr() + info.valueOffset! * 4, info.valueWords);
      const weights = new Float32Array(exports.memory.buffer, timeline_weights_ptr() + info.weightOffset! * 4, info.blocks);
      const t = step * dt;
      expect(Math.abs(values[blocks[0]!.offset!]! - t)).toBeLessThan(1e-3);
      if (t < 1) expect(weights[1]).toBe(0);
      if (t >= 1.5 && t < 3) {
        // The entry plays the leaf from 0.5 at double speed; the blend in is 0.5 s.
        expect(weights[1]).toBe(1);
        expect(Math.abs(values[blocks[1]!.offset!]! - (0.5 + (t - 1) * 2))).toBeLessThan(1e-3);
      }
      if (t === 1.25) expect(weights[1]).toBeCloseTo(0.5, 6);
      // Records.
      const view = memory();
      let at = timeline_records_ptr();
      const end = at + timeline_records_len();
      while (at < end) {
        const opcode = view.getUint16(at, true);
        if (opcode === tracks.EVENT.opcode) {
          const e = decode(view, at, tracks.EVENT);
          fired.push([t, e.clip!, e.time!]);
        }
        const layout = (Object.values(tracks) as unknown[]).find(
          (v): v is RecordLayout => typeof v === "object" && v !== null && "opcode" in v && (v as RecordLayout).opcode === opcode,
        );
        at += layout!.stride;
      }
    }
    // The leaf's notify at local 1.5 is timeline time 1 + (1.5 - 0.5) / 2 = 1.5.
    expect(fired).toEqual([[1.5, leaf, 1.5]]);
    expect(timeline_control(encode(timeline.TIMELINE_CONTROL, { handle: h, op: timeline.OP_KILL, value: 0 }))).toBe(core.STATUS_OK);
    frame(dt);
    expect(timelineChanges().map((c) => c.kind)).toEqual([timeline.CHANGE_KILLED]);
  });

  it("runs a sequence of two tweens and reports each member and the end", () => {
    const member = (hostId: number, column: number, offset: number, to: number): Uint8Array =>
      encode(timeline.SEQ_MEMBER, {
        hostId, column, valueKind: tween.KIND_VALUE, width: 1, ease: tween.EASE_LINEAR, flags: 0, loops: 1, offset, duration: 1, delay: 0, from0: 0, to0: to,
      });
    const head = encode(timeline.SEQ_CREATE, { world: 0, hostId: 200, timeMode: 0, wrap: timeline.WRAP_ONCE, flags: timeline.FLAG_PLAY, speed: 1, members: 2 });
    const bytes = new Uint8Array([...head, ...member(11, 5, 0, 1), ...member(12, 6, 1, 2)]);
    const h = timeline_create_sequence(bytes);
    expect(h).not.toBe(0);
    const infoBytes = new Uint8Array(timeline.TIMELINE_INFO.stride);
    timeline_info(h, infoBytes);
    const info = decode(new DataView(infoBytes.buffer), 0, timeline.TIMELINE_INFO);
    const log: [number, number][] = [];
    for (let step = 1; step <= 4; step++) {
      frame(0.5);
      const values = new Float32Array(exports.memory.buffer, timeline_values_ptr() + info.valueOffset! * 4, info.valueWords);
      if (step === 1) expect([...values]).toEqual([0.5, 0]);
      if (step === 3) expect([...values]).toEqual([1, 1]);
      for (const c of timelineChanges()) log.push([c.kind!, c.member!]);
    }
    expect(log).toEqual([
      [timeline.CHANGE_MEMBER_DONE, 11],
      [timeline.CHANGE_MEMBER_DONE, 12],
      [timeline.CHANGE_FINISHED, timeline.NONE],
    ]);
  });
});
