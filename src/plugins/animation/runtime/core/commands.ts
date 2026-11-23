// One World's command buffer (ADR 0370, "Memory and the boundary"): the gather sub-steps queue `core` and `graph` family
// commands (`PLAY`, `STOP`, `SET_LAYER`, `SET_PARAM`, `SLOT_PLAY`…) here during the frame, and the World's `evaluate`
// copies them into the core's command buffer and applies them with one `write_inputs` call just before it evaluates.
// Staging per World keeps Worlds apart: `write_inputs` clears the state-change records, so a World's refusals and
// interruptions are read by that World's apply stage, never another's.
//
// The core applies at most `COMMAND_BYTES` per call. Commands past that stay queued, in order, for the World's next
// evaluate (one warning per page): a frame never applies a partial record, and nothing is dropped.
import { COMMAND_BYTES } from "../wasm/wire/core";
import { putRecord, type RecordLayout, type RecordValues } from "./records";

/** @internal Where `flush` copies to and how it applies (the host's view of the core's command buffer). */
export interface CommandSink {
  /** The core's memory now (re-read: loads can grow it). */
  memory(): ArrayBuffer;
  /** The command buffer's byte offset in memory. */
  commandsPtr(): number;
  /** Applies the first `len` bytes of the command buffer; returns the commands applied. */
  writeInputs(len: number): number;
}

let warnedOverflow = false;

/** @internal A World's queued commands. */
export class CommandWriter {
  private bytes = new Uint8Array(1024);
  private view = new DataView(this.bytes.buffer);
  private length = 0;
  /** Each queued record's end offset, in order. */
  private readonly ends: number[] = [];

  /** Queued bytes. */
  get pending(): number {
    return this.length;
  }

  /** Queues one command record. Field values left out are 0. */
  put<L extends RecordLayout>(layout: L, values: RecordValues<L>): void {
    const end = this.length + layout.stride;
    if (end > this.bytes.length) {
      let size = this.bytes.length * 2;
      while (size < end) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    putRecord(this.view, this.length, layout, values);
    this.length = end;
    this.ends.push(end);
  }

  /** Drops every queued command (the World's namespace closed). */
  clear(): void {
    this.length = 0;
    this.ends.length = 0;
  }

  /**
   * Copies the queued commands that fit into the core's command buffer and applies them with one `write_inputs` call
   * (always made, even with nothing queued: it also applies the blackboard rows and starts the frame's change records).
   * Returns the commands applied.
   */
  flush(sink: CommandSink): number {
    let fit = 0;
    let records = 0;
    while (records < this.ends.length && this.ends[records]! <= COMMAND_BYTES) fit = this.ends[records++]!;
    if (fit > 0) new Uint8Array(sink.memory(), sink.commandsPtr(), fit).set(this.bytes.subarray(0, fit));
    const applied = sink.writeInputs(fit);
    if (records === this.ends.length) {
      this.clear();
      return applied;
    }
    if (!warnedOverflow) {
      warnedOverflow = true;
      console.warn(`[myco] animation: more than ${COMMAND_BYTES} bytes of animation commands in one World's frame; the rest apply next frame.`);
    }
    this.bytes.copyWithin(0, fit, this.length);
    this.length -= fit;
    this.ends.splice(0, records);
    for (let i = 0; i < this.ends.length; i++) this.ends[i]! -= fit;
    return applied;
  }
}
