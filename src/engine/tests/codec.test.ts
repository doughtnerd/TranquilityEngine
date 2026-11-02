import { describe, expect, it } from "vitest";
import { f32, i32, u8 } from "../core/data";
import { createBitReader, createBitWriter, recordCodec, type BitReader, type BitWriter, type RecordCodec } from "../net/codec";

function roundTrip(write: (w: BitWriter) => void, read: (r: BitReader) => void): Uint8Array {
  const w = createBitWriter();
  write(w);
  const bytes = w.finish();
  read(createBitReader(bytes));
  return bytes;
}

describe("bits", () => {
  it("round-trips bits at every width 1..32, packed with no padding between them", () => {
    const values: number[] = [];
    let totalBits = 0;
    const bytes = roundTrip(
      (w) => {
        for (let bits = 1; bits <= 32; bits++) {
          for (const v of [0, 2 ** bits - 1, Math.floor((2 ** bits - 1) / 3)]) {
            w.writeBits(v, bits);
            values.push(v);
            totalBits += bits;
          }
        }
      },
      (r) => {
        let k = 0;
        for (let bits = 1; bits <= 32; bits++) {
          for (let j = 0; j < 3; j++) expect(r.readBits(bits)).toBe(values[k++]);
        }
        expect(r.remaining).toBeLessThan(8);
      },
    );
    expect(bytes.length).toBe(Math.ceil(totalBits / 8));
  });

  it("packs little-endian: the first bit written is bit 0 of byte 0", () => {
    const w = createBitWriter();
    w.writeBool(true);
    w.writeBits(0b101, 3);
    w.writeBits(0xabc, 12);
    expect([...w.finish()]).toEqual([0b1100_1011, 0b1010_1011]);
  });

  it("rejects bad widths and values that don't fit", () => {
    const w = createBitWriter();
    expect(() => w.writeBits(0, 0)).toThrow(RangeError);
    expect(() => w.writeBits(0, 33)).toThrow(RangeError);
    expect(() => w.writeBits(4, 2)).toThrow(RangeError);
    expect(() => w.writeBits(-1, 8)).toThrow(RangeError);
    expect(() => w.writeBits(1.5, 8)).toThrow(RangeError);
  });

  it("round-trips bools, one bit each", () => {
    const pattern = [true, false, false, true, true, true, false, true, false];
    const bytes = roundTrip(
      (w) => pattern.forEach((b) => w.writeBool(b)),
      (r) => pattern.forEach((b) => expect(r.readBool()).toBe(b)),
    );
    expect(bytes.length).toBe(2);
  });

  it("round-trips varuints, 7 bits per byte", () => {
    const cases: [number, number][] = [
      [0, 1],
      [127, 1],
      [128, 2],
      [16383, 2],
      [16384, 3],
      [2 ** 31, 5],
      [2 ** 32 + 5, 5],
      [2 ** 40 + 123, 6],
      [Number.MAX_SAFE_INTEGER, 8],
    ];
    for (const [v, size] of cases) {
      const bytes = roundTrip(
        (w) => w.writeVarUint(v),
        (r) => expect(r.readVarUint()).toBe(v),
      );
      expect(bytes.length).toBe(size);
    }
    const w = createBitWriter();
    expect(() => w.writeVarUint(-1)).toThrow(RangeError);
    expect(() => w.writeVarUint(1.5)).toThrow(RangeError);
    expect(() => w.writeVarUint(2 ** 53)).toThrow(RangeError);
  });

  it("round-trips varints (zigzag), small magnitudes in one byte", () => {
    const cases = [0, 1, -1, 63, -64, 64, -65, 2 ** 31 - 1, -(2 ** 31), 2 ** 40, -(2 ** 40), 2 ** 52 - 1, -(2 ** 52)];
    for (const v of cases) {
      roundTrip(
        (w) => w.writeVarInt(v),
        (r) => expect(r.readVarInt()).toBe(v),
      );
    }
    for (const v of [0, -1, 1, 63, -64]) {
      const w = createBitWriter();
      w.writeVarInt(v);
      expect(w.finish().length).toBe(1);
    }
    expect(() => createBitWriter().writeVarInt(2 ** 52)).toThrow(RangeError);
  });

  it("round-trips float32 bits exactly, including -0, NaN, Infinity and subnormals", () => {
    const cases = [0, -0, 1, -1.5, Math.fround(Math.PI), Infinity, -Infinity, 1.4e-45, -1.4e-45, 1e-40, 3.4028234663852886e38];
    roundTrip(
      (w) => {
        for (const v of cases) w.writeFloat32(v);
        w.writeFloat32(NaN);
      },
      (r) => {
        for (const v of cases) expect(Object.is(r.readFloat32(), Math.fround(v))).toBe(true);
        expect(r.readFloat32()).toBeNaN();
      },
    );
    // Non-float32 values come back as their float32.
    roundTrip(
      (w) => w.writeFloat32(0.1),
      (r) => expect(r.readFloat32()).toBe(Math.fround(0.1)),
    );
  });

  it("round-trips strings: ASCII, multi-byte UTF-8 and empty, aligned or not", () => {
    const cases = ["", "hello", "héllo wörld", "日本語", "emoji 🎮🚀", "a".repeat(300)];
    for (const offset of [0, 3]) {
      roundTrip(
        (w) => {
          if (offset) w.writeBits(0b101, offset);
          for (const s of cases) w.writeString(s);
        },
        (r) => {
          if (offset) expect(r.readBits(offset)).toBe(0b101);
          for (const s of cases) expect(r.readString()).toBe(s);
        },
      );
    }
    const w = createBitWriter();
    w.writeString("日");
    expect(w.finish().length).toBe(1 + 3);
  });

  it("round-trips a mix of everything in order", () => {
    roundTrip(
      (w) => {
        w.writeBool(true);
        w.writeVarInt(-300);
        w.writeString("id");
        w.writeFloat32(2.5);
        w.writeBits(7, 3);
        w.writeVarUint(1e12);
      },
      (r) => {
        expect(r.readBool()).toBe(true);
        expect(r.readVarInt()).toBe(-300);
        expect(r.readString()).toBe("id");
        expect(r.readFloat32()).toBe(2.5);
        expect(r.readBits(3)).toBe(7);
        expect(r.readVarUint()).toBe(1e12);
      },
    );
  });

  it("grows its buffer past the initial size", () => {
    const n = 10_000;
    roundTrip(
      (w) => {
        for (let i = 0; i < n; i++) w.writeVarUint(i);
      },
      (r) => {
        for (let i = 0; i < n; i++) expect(r.readVarUint()).toBe(i);
      },
    );
  });

  it("throws when reading past the end, and on malformed data", () => {
    const r = createBitReader(new Uint8Array([0xff]));
    expect(r.remaining).toBe(8);
    expect(r.readBits(5)).toBe(31);
    expect(r.remaining).toBe(3);
    expect(() => r.readBits(4)).toThrow(/past the end/);
    expect(() => createBitReader(new Uint8Array()).readBool()).toThrow(/past the end/);
    expect(() => createBitReader(new Uint8Array(3)).readFloat32()).toThrow(/past the end/);
    // A varint whose continuation bit never ends.
    expect(() => createBitReader(new Uint8Array([0x80, 0x80])).readVarUint()).toThrow(/past the end/);
    expect(() => createBitReader(new Uint8Array(12).fill(0xff)).readVarUint()).toThrow(/longer than/);
    // A string whose length is longer than the packet.
    expect(() => createBitReader(new Uint8Array([10, 65, 66])).readString()).toThrow(/past the end/);
    expect(() => createBitReader(new Uint8Array([2, 0xc3, 0x28])).readString()).toThrow(/UTF-8/);
  });
});

describe("recordCodec", () => {
  const Transform = { x: f32, y: f32, z: f32, hp: i32, team: u8 };

  function encode(codec: RecordCodec, values: Record<string, number>, baseline?: Record<string, number>): Uint8Array {
    const w = createBitWriter();
    codec.write(w, values, baseline);
    return w.finish();
  }

  it("round-trips a full record at full precision", () => {
    const codec = recordCodec(Transform);
    expect(codec.fields).toEqual(["x", "y", "z", "hp", "team"]);
    const values = { x: 1.25, y: -3.5, z: Math.fround(1e-30), hp: -100, team: 3 };
    const bytes = encode(codec, values);
    expect(bytes.length).toBe(3 * 4 + 2 + 1);
    expect(codec.read(createBitReader(bytes))).toEqual(values);
  });

  it("decodes values as the receiver's typed arrays would store them", () => {
    const codec = recordCodec(Transform);
    const out = codec.read(createBitReader(encode(codec, { x: 0.1, y: 0, z: 0, hp: 2.7, team: 257 })));
    expect(out).toEqual({ x: Math.fround(0.1), y: 0, z: 0, hp: 2, team: 1 });
  });

  it("quantizes: rounds to the step and sends a step count", () => {
    const codec = recordCodec({ x: f32, y: f32 }, { x: { quantize: 0.01 }, y: { quantize: 0.5 } });
    const bytes = encode(codec, { x: 1.23456, y: -2.3 });
    // 123 steps → 2 bytes; -5 steps (−2.3 / 0.5 = −4.6 → −5) → 1 byte.
    expect(bytes.length).toBe(3);
    const out = codec.read(createBitReader(bytes));
    expect(out.x).toBe(Math.fround(1.23));
    expect(out.y).toBe(-2.5);
  });

  it("rejects quantize on non-f32 fields and non-positive steps", () => {
    expect(() => recordCodec({ n: i32 }, { n: { quantize: 1 } })).toThrow(/only f32/);
    expect(() => recordCodec({ x: f32 }, { x: { quantize: 0 } })).toThrow(/positive/);
    const codec = recordCodec({ x: f32 }, { x: { quantize: 1e-6 } });
    expect(() => codec.write(createBitWriter(), { x: 1e30 })).toThrow(/out of range/);
    expect(() => codec.write(createBitWriter(), { x: NaN })).toThrow(/out of range/);
  });

  it("against an unchanged baseline, sends only the changed mask", () => {
    const codec = recordCodec(Transform, { x: { quantize: 0.01 } });
    const values = { x: 10, y: 20, z: 30, hp: 100, team: 2 };
    const bytes = encode(codec, values, values);
    expect(bytes.length).toBe(1); // 5 mask bits
    expect(codec.read(createBitReader(bytes), values)).toEqual(values);
  });

  it("against a baseline, sends only the field that changed", () => {
    const codec = recordCodec(Transform);
    const baseline = { x: 10, y: 20, z: 30, hp: 100, team: 2 };
    const full = encode(codec, baseline);

    const moved = { ...baseline, y: 20.5 };
    const movedBytes = encode(codec, moved, baseline);
    expect(movedBytes.length).toBe(Math.ceil((5 + 32) / 8)); // mask + one float32
    expect(codec.read(createBitReader(movedBytes), baseline)).toEqual(moved);

    const hurt = { ...baseline, hp: 97 };
    const hurtBytes = encode(codec, hurt, baseline);
    expect(hurtBytes.length).toBe(Math.ceil((5 + 8) / 8)); // mask + delta −3 in one byte
    expect(codec.read(createBitReader(hurtBytes), baseline)).toEqual(hurt);
    expect(hurtBytes.length).toBeLessThan(full.length);
  });

  it("delta-encodes quantized and i32 fields against the baseline", () => {
    const codec = recordCodec({ x: f32, n: i32 }, { x: { quantize: 0.01 } });
    const baseline = { x: 5000, n: 1_000_000 };
    // Absolute: 500000 steps → 3 bytes, 1e6 → 3 bytes. Delta: +1 step, +1 → a byte each.
    expect(encode(codec, baseline).length).toBe(6);
    const next = { x: 5000.01, n: 1_000_001 };
    const bytes = encode(codec, next, baseline);
    expect(bytes.length).toBe(Math.ceil((2 + 8 + 8) / 8));
    const out = codec.read(createBitReader(bytes), baseline);
    expect(out.x).toBe(Math.fround(5000.01));
    expect(out.n).toBe(1_000_001);
  });

  it("wraps i32 deltas at 32 bits", () => {
    const codec = recordCodec({ n: i32 });
    const baseline = { n: 2 ** 31 - 1 };
    const next = { n: -(2 ** 31) };
    const bytes = encode(codec, next, baseline);
    expect(bytes.length).toBe(Math.ceil((1 + 8) / 8)); // delta +1 after wrapping
    expect(codec.read(createBitReader(bytes), baseline)).toEqual(next);
  });

  it("doesn't count noise below the quantize step as a change", () => {
    const codec = recordCodec({ x: f32, y: f32 }, { x: { quantize: 0.01 }, y: { quantize: 0.01 } });
    const baseline = { x: 1.0, y: 2.0 };
    const noisy = { x: 1.0012, y: 1.9963 };
    const bytes = encode(codec, noisy, baseline);
    expect(bytes.length).toBe(1);
    const r = createBitReader(bytes);
    expect(r.readBits(1)).toBe(0);
    expect(r.readBits(1)).toBe(0);
    expect(codec.read(createBitReader(bytes), baseline)).toEqual({ x: 1, y: 2 });
    // Crossing a step boundary is a change.
    expect(codec.read(createBitReader(encode(codec, { x: 1.006, y: 2 }, baseline)), baseline).x).toBe(Math.fround(1.01));
  });

  it("treats full-precision changes by their float32 bits", () => {
    const codec = recordCodec({ x: f32 });
    expect(encode(codec, { x: 0.1 }, { x: Math.fround(0.1) }).length).toBe(1); // same float32
    expect(encode(codec, { x: -0 }, { x: 0 }).length).toBe(5); // -0 is a change
    expect(encode(codec, { x: NaN }, { x: NaN }).length).toBe(1);
  });

  it("round-trips mixed schemas over a stream of baselines", () => {
    const schema = { px: f32, py: f32, vx: f32, vy: f32, ammo: i32, state: u8, flags: u8 };
    const codec = recordCodec(schema, { px: { quantize: 0.01 }, py: { quantize: 0.01 } });
    const states: Record<keyof typeof schema, number>[] = [];
    let s = { px: 0, py: 0, vx: 1.5, vy: -2, ammo: 30, state: 0, flags: 0 };
    for (let tick = 0; tick < 50; tick++) {
      s = {
        ...s,
        px: s.px + s.vx / 60,
        py: s.py + s.vy / 60,
        vy: tick % 10 === 0 ? s.vy + 0.5 : s.vy,
        ammo: tick % 7 === 0 ? s.ammo - 1 : s.ammo,
        state: tick % 20 === 0 ? (s.state + 1) % 4 : s.state,
      };
      states.push(s);
    }
    // First record full, the rest against the previous one. (The sender's baseline is unquantized
    // and the receiver's quantized; both give the same step counts.)
    let sentBaseline: Record<keyof typeof schema, number> | undefined;
    const r0 = createBitWriter();
    for (const st of states) {
      codec.write(r0, st, sentBaseline);
      sentBaseline = st;
    }
    const bytes = r0.finish();
    const r = createBitReader(bytes);
    let recvBaseline: Record<keyof typeof schema, number> | undefined;
    for (const st of states) {
      const out = codec.read(r, recvBaseline);
      expect(out.px).toBe(Math.fround(Math.round(st.px / 0.01) * 0.01));
      expect(out.py).toBe(Math.fround(Math.round(st.py / 0.01) * 0.01));
      expect(out.vx).toBe(Math.fround(st.vx));
      expect(out.vy).toBe(Math.fround(st.vy));
      expect(out.ammo).toBe(st.ammo);
      expect(out.state).toBe(st.state);
      recvBaseline = out;
    }
    expect(r.remaining).toBeLessThan(8);
    // Much smaller than 50 full records (4 × 4 + up to 5 + 2 bytes each).
    expect(bytes.length).toBeLessThan(50 * 12);
  });
});
