// ADR 0370 (T13t): the wire record codec over generated layouts, and a World's command writer: records round-trip
// through every scalar type; the writer applies what fits in the core's command buffer with one call and keeps the
// rest, in order, for the next evaluate.
import { describe, expect, it, vi } from "vitest";
import { COMMAND_BYTES, PLAY, STOP, WIRE_HEADER } from "../wasm/wire/core";
import { CommandWriter, type CommandSink } from "./commands";
import { WIRE_HEADER as ENGINE_HEADER } from "../../../../engine/wasm/wireRecords";
import { encodeRecord, getRecord, putRecord, recordOpcode, type RecordLayout } from "./records";

const EVERY: RecordLayout = {
  opcode: 0x7f01,
  version: 3,
  stride: 24,
  fields: {
    a: { offset: 4, type: "u8" },
    b: { offset: 5, type: "i8" },
    c: { offset: 6, type: "u16" },
    d: { offset: 8, type: "i16" },
    e: { offset: 12, type: "u32" },
    f: { offset: 16, type: "i32" },
    g: { offset: 20, type: "f32" },
  },
};

describe("wire records", () => {
  it("writes the header gen_wire generates", () => {
    expect(ENGINE_HEADER).toEqual(WIRE_HEADER);
  });

  it("round-trips every scalar type, header first", () => {
    const values = { a: 200, b: -5, c: 60000, d: -30000, e: 0xfffffff0, f: -123456, g: 1.5 };
    const bytes = encodeRecord(EVERY, values);
    const view = new DataView(bytes.buffer);
    expect(recordOpcode(view, 0)).toBe(0x7f01);
    expect(view.getUint16(WIRE_HEADER.version, true)).toBe(3);
    expect(getRecord(view, 0, EVERY)).toEqual(values);
  });

  it("writes left-out fields as 0 and reads into a given object", () => {
    const view = new DataView(new ArrayBuffer(64));
    new Uint8Array(view.buffer).fill(0xff);
    expect(putRecord(view, 8, PLAY, { instance: 7, speed: 2 })).toBe(PLAY.stride);
    const out = getRecord(view, 0, PLAY);
    const again = getRecord(view, 8, PLAY, out);
    expect(again).toBe(out);
    expect(again).toEqual({ instance: 7, clip: 0, playId: 0, layer: 0, fade: 0, speed: 2, start: 0, flags: 0 });
  });
});

/** A core stand-in: a memory with the command buffer at 16, recording each `write_inputs` call's records. */
function sink() {
  const memory = new ArrayBuffer(16 + COMMAND_BYTES);
  const calls: number[][] = [];
  const s: CommandSink = {
    memory: () => memory,
    commandsPtr: () => 16,
    writeInputs: (len) => {
      const view = new DataView(memory, 16, len);
      const instances: number[] = [];
      for (let at = 0; at < len; at += PLAY.stride) instances.push(getRecord(view, at, PLAY).instance);
      calls.push(instances);
      return instances.length;
    },
  };
  return { s, calls };
}

describe("the command writer", () => {
  it("applies the queued commands with one call, and still calls with nothing queued", () => {
    const w = new CommandWriter();
    const { s, calls } = sink();
    w.put(PLAY, { instance: 1 });
    w.put(PLAY, { instance: 2 });
    expect(w.pending).toBe(2 * PLAY.stride);
    expect(w.flush(s)).toBe(2);
    expect(w.flush(s)).toBe(0);
    expect(calls).toEqual([[1, 2], []]);
  });

  it("keeps what doesn't fit in the command buffer for the next flush, in order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const w = new CommandWriter();
      const { s, calls } = sink();
      const perCall = Math.floor(COMMAND_BYTES / PLAY.stride);
      for (let i = 0; i < perCall + 3; i++) w.put(PLAY, { instance: i });
      expect(w.flush(s)).toBe(perCall);
      expect(w.pending).toBe(3 * PLAY.stride);
      expect(w.flush(s)).toBe(3);
      expect(calls[1]).toEqual([perCall, perCall + 1, perCall + 2]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("drops its queue when cleared", () => {
    const w = new CommandWriter();
    const { s, calls } = sink();
    w.put(STOP, { instance: 1 });
    w.clear();
    w.flush(s);
    expect(calls).toEqual([[]]);
  });
});
