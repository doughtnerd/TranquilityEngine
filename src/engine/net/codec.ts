/**
 * Binary encoding for netcode messages (ADR 0033): schema-driven, with optional quantization and
 * delta encoding against a baseline the receiver already has. The bit packing is in `bits.ts`.
 *
 * Per field type:
 * - `f32`: an IEEE float32 (32 bits). With `quantize`, rounded to the step and sent as a zigzag
 *   varint of the step count; step counts must stay within ±2^51, or `write` throws.
 * - `i32`: a zigzag varint (1 byte for -64..63, 5 at most for any int32).
 * - `u8`: 8 bits.
 * Values are coerced as the receiver's typed arrays would store them (`Math.fround`, `| 0`,
 * `& 0xff`), and `read` returns them that way: quantized fields come back rounded to the step.
 *
 * With a baseline, `write` sends a changed bit per field, then only the changed fields. Quantized
 * fields compare step counts, so noise below the step isn't a change. Changed `i32` and quantized
 * `f32` fields are delta-encoded: the varint carries the difference from the baseline (wrapping
 * at 32 bits for `i32`), which is small for the usual small per-tick changes. Full-precision `f32`
 * and `u8` fields are sent whole: their difference isn't smaller in bits.
 */
import type { Schema } from "../core/data";
import { BitReaderImpl, BitWriterImpl } from "./bits";

/** Writes bits into a growing buffer. */
export interface BitWriter {
  writeBits(value: number, bits: number): void;
  writeBool(value: boolean): void;
  /** Unsigned variable-length integer. */
  writeVarUint(value: number): void;
  /** Signed variable-length integer (zigzag). */
  writeVarInt(value: number): void;
  writeFloat32(value: number): void;
  writeString(value: string): void;
  /** The bytes written so far (padded to a whole byte). */
  finish(): Uint8Array;
}

/** Reads what a BitWriter wrote, in the same order. */
export interface BitReader {
  readBits(bits: number): number;
  readBool(): boolean;
  readVarUint(): number;
  readVarInt(): number;
  readFloat32(): number;
  readString(): string;
  /** Bits not yet read. */
  readonly remaining: number;
}

/** Per-field encoding options, from `FieldOptions` or a data component's replication settings. */
export interface FieldEncoding {
  /** Round to this step and send as an integer (e.g. 0.01). Omitted: full precision. */
  quantize?: number;
}

/** How to encode a record of a schema. */
export interface RecordCodec<S extends Schema = Schema> {
  readonly schema: S;
  readonly fields: readonly string[];
  /**
   * Write `values`. With a `baseline`, write only what changed since it (a bit per field, then the
   * changed values) so the receiver needs the same baseline to read it.
   */
  write(writer: BitWriter, values: Readonly<Record<keyof S, number>>, baseline?: Readonly<Record<keyof S, number>>): void;
  /** Read what `write` wrote, given the same baseline. */
  read(reader: BitReader, baseline?: Readonly<Record<keyof S, number>>): Record<keyof S, number>;
}

export function createBitWriter(): BitWriter {
  return new BitWriterImpl();
}

export function createBitReader(data: Uint8Array): BitReader {
  return new BitReaderImpl(data);
}

const F32 = 0;
const F32Q = 1;
const I32 = 2;
const U8 = 3;
const MAX_STEPS = 2 ** 51 - 1; // so a delta of two step counts still zigzags within 2^53

/** A codec for records of `schema` (a data component's, an RPC's or an input's). */
export function recordCodec<S extends Schema>(schema: S, encoding: Partial<Record<keyof S, FieldEncoding>> = {}): RecordCodec<S> {
  // The field plan, computed once.
  const fields = Object.keys(schema);
  const count = fields.length;
  const kinds = new Uint8Array(count);
  const steps = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const name = fields[i];
    const kind = schema[name].kind;
    const step = (encoding as Record<string, FieldEncoding | undefined>)[name]?.quantize;
    if (step !== undefined) {
      if (kind !== "f32") throw new Error(`recordCodec: field "${name}" is ${kind}; only f32 fields can be quantized`);
      if (!(step > 0 && Number.isFinite(step))) throw new Error(`recordCodec: field "${name}" has quantize ${step}; it must be a positive number`);
      kinds[i] = F32Q;
      steps[i] = step;
    } else {
      kinds[i] = kind === "f32" ? F32 : kind === "i32" ? I32 : U8;
    }
  }
  // Which fields changed, between write's two passes (writes are synchronous, so one is enough).
  const changed = new Uint8Array(count);

  function stepCount(i: number, value: number): number {
    const n = Math.round(value / steps[i]);
    if (!(Math.abs(n) <= MAX_STEPS)) {
      throw new RangeError(`recordCodec: field "${fields[i]}" value ${value} is out of range for quantize ${steps[i]}`);
    }
    return n;
  }

  function writeField(w: BitWriter, i: number, v: number, base: number | undefined): void {
    switch (kinds[i]) {
      case F32:
        w.writeFloat32(v);
        break;
      case F32Q: {
        const n = stepCount(i, v);
        w.writeVarInt(base === undefined ? n : n - stepCount(i, base));
        break;
      }
      case I32:
        w.writeVarInt(base === undefined ? v | 0 : ((v | 0) - (base | 0)) | 0);
        break;
      default:
        w.writeBits(v & 0xff, 8);
    }
  }

  function readField(r: BitReader, i: number, base: number | undefined): number {
    switch (kinds[i]) {
      case F32:
        return r.readFloat32();
      case F32Q: {
        const d = r.readVarInt();
        return Math.fround((base === undefined ? d : stepCount(i, base) + d) * steps[i]);
      }
      case I32: {
        const d = r.readVarInt();
        return base === undefined ? d | 0 : ((base | 0) + d) | 0;
      }
      default:
        return r.readBits(8);
    }
  }

  function same(i: number, a: number, b: number): boolean {
    switch (kinds[i]) {
      case F32:
        return Object.is(Math.fround(a), Math.fround(b));
      case F32Q:
        return stepCount(i, a) === stepCount(i, b);
      case I32:
        return (a | 0) === (b | 0);
      default:
        return (a & 0xff) === (b & 0xff);
    }
  }

  /** An unchanged field reads as the baseline, coerced as if it had been sent. */
  function unchangedValue(i: number, base: number): number {
    switch (kinds[i]) {
      case F32:
        return Math.fround(base);
      case F32Q:
        return Math.fround(stepCount(i, base) * steps[i]);
      case I32:
        return base | 0;
      default:
        return base & 0xff;
    }
  }

  return {
    schema,
    fields,
    write(writer, values, baseline) {
      const v = values as Record<string, number>;
      if (!baseline) {
        for (let i = 0; i < count; i++) writeField(writer, i, v[fields[i]], undefined);
        return;
      }
      const b = baseline as Record<string, number>;
      for (let i = 0; i < count; i++) {
        const c = same(i, v[fields[i]], b[fields[i]]) ? 0 : 1;
        changed[i] = c;
        writer.writeBits(c, 1);
      }
      for (let i = 0; i < count; i++) {
        if (changed[i]) writeField(writer, i, v[fields[i]], b[fields[i]]);
      }
    },
    read(reader, baseline) {
      const out: Record<string, number> = {};
      if (!baseline) {
        for (let i = 0; i < count; i++) out[fields[i]] = readField(reader, i, undefined);
        return out as Record<keyof S, number>;
      }
      const b = baseline as Record<string, number>;
      for (let i = 0; i < count; i++) changed[i] = reader.readBits(1);
      for (let i = 0; i < count; i++) {
        const name = fields[i];
        out[name] = changed[i] ? readField(reader, i, b[name]) : unchangedValue(i, b[name]);
      }
      return out as Record<keyof S, number>;
    },
  };
}
