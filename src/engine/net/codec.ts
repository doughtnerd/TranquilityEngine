/**
 * Binary encoding for netcode messages (ADR 0033): schema-driven, with optional quantization and
 * delta encoding against a baseline the receiver already has. Implemented by T8.
 */
import { notYet } from "../core/worlds";
import type { Schema } from "../core/data";

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
  return notYet("T8", "createBitWriter()");
}

export function createBitReader(_data: Uint8Array): BitReader {
  return notYet("T8", "createBitReader()");
}

/** A codec for records of `schema` (a data component's, an RPC's or an input's). */
export function recordCodec<S extends Schema>(_schema: S, _encoding: Partial<Record<keyof S, FieldEncoding>> = {}): RecordCodec<S> {
  return notYet("T8", "recordCodec()");
}
