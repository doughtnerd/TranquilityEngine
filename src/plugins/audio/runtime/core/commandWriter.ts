// The command writer (ADR 0157; api-and-models §4.2 "Sizing and carry-over"; architecture §3.3): records for the
// frame go into a staging area, then `flush` copies them into pooled 64 KB BATCH buffers and posts them. A batch is
// capped at 64 KB; the excess stays staged and goes in the next batch with its absolute frame preserved (the
// next batch's `firstFrame` is its earliest stamp; asap records stay asap). Records are stable-sorted by frame by
// insertion sort. When the pool is empty `flush` posts nothing and keeps everything staged. A full staging area drops
// the newest record and sets the `overflowed` flag on the next batch (bit0).
//
// Voice commands come from `VoiceTable.drainCommands(writer)` (this class is the `VoiceCommandSink`), so STOP and FADE
// for the frame are queued deduplicated by the table and written here in order.
import type { VoiceCommandSink } from "./voiceTable";
import type { BufferPool } from "./bufferPool";
import type { BusConfigBuses, BusMixBuses } from "../wire.generated";

/** What the writer needs from `CoreLink` (A1.4 adds `nextSeq` and `post` to it). */
export interface BatchPort {
  /** The host's BATCH pool (4 × 64 KB). */
  readonly batchPool: BufferPool;
  /** The envelope's next `seq` (per sender, wraps). */
  nextSeq(): number;
  /** Posts a BATCH buffer, transferring it (the worklet returns it to `batchPool`). */
  post(buffer: ArrayBuffer): void;
}

/** §4.2 PLAY, minus the head. `frameOffset` is the writer's business (see `play`). */
export interface PlayArgs {
  voiceId: number;
  clip: number;
  bus: number;
  /** `PLAY_FLAGS_*` from wire.generated (loop, stream, wantsPlayhead, mixed, spatial, panner). */
  flags: number;
  group: number;
  gain: number;
  pitch: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  lpHz: number;
  score: number;
  startOffsetFrames: number;
}

/** The staging area's size in bytes: four full batches. */
export const STAGING_BYTES = 4 * 65_536;

/** Counters for `Audio.debug()` and the tests. */
export interface CommandWriterStats {
  /** BATCH messages posted. */
  batches: number;
  /** Records written into posted batches. */
  records: number;
  /** Records dropped because the staging area was full. */
  dropped: number;
  /** Times a flush found the pool empty and posted nothing. */
  poolEmpty: number;
  /** Records that waited for a later batch because a batch was full (carry-over). */
  carried: number;
}

export class CommandWriter implements VoiceCommandSink {
  readonly stats: CommandWriterStats = { batches: 0, records: 0, dropped: 0, poolEmpty: 0, carried: 0 };

  /** `sampleRate` converts the table's seconds to frames (STOP and FADE take frames). */
  constructor(
    private readonly port: BatchPort,
    readonly sampleRate: number,
  ) {
    void this.port;
  }

  /** Records staged and not yet posted. */
  get pending(): number {
    throw new Error("not implemented: A1.4 (CommandWriter.pending)");
  }

  /** PLAY at `atFrame` (an absolute audio frame, stamped) or asap (omitted). */
  play(args: PlayArgs, atFrame?: number): void {
    void args;
    void atFrame;
    throw new Error("not implemented: A1.4 (CommandWriter.play)");
  }

  /** STOP `id`, fading over `fadeSeconds` (0 = now). Always asap. */
  stop(id: number, fadeSeconds: number): void {
    void id;
    void fadeSeconds;
    throw new Error("not implemented: A1.4 (CommandWriter.stop)");
  }

  /** FADE `id`'s gain multiplier to `to` over `seconds`. Always asap. */
  fade(id: number, to: number, seconds: number): void {
    void id;
    void to;
    void seconds;
    throw new Error("not implemented: A1.4 (CommandWriter.fade)");
  }

  /** SET_PARAMS (§4.2); `mask` is `SET_PARAMS_MASK_*`, other fields only matter where the mask says. */
  setParams(id: number, mask: number, gain: number, pitch: number, dirX: number, dirY: number, dirZ: number, lpHz: number, rampFrames: number): void {
    void [id, mask, gain, pitch, dirX, dirY, dirZ, lpHz, rampFrames];
    throw new Error("not implemented: A1.4 (CommandWriter.setParams)");
  }

  /** SET_PAUSED `id`. */
  setPaused(id: number, paused: boolean): void {
    void id;
    void paused;
    throw new Error("not implemented: A1.4 (CommandWriter.setPaused)");
  }

  /** BUS_CONFIG: the whole tree, root first (`parent` 0xFFFF for the root). */
  busConfig(buses: readonly BusConfigBuses[]): void {
    void buses;
    throw new Error("not implemented: A1.4 (CommandWriter.busConfig)");
  }

  /** BUS_MIX: gain and low-pass per bus, root first. */
  busMix(buses: readonly BusMixBuses[], rampFrames: number): void {
    void buses;
    void rampFrames;
    throw new Error("not implemented: A1.4 (CommandWriter.busMix)");
  }

  /** MASTER volume and mute. */
  master(volume: number, muted: boolean, rampFrames: number): void {
    void volume;
    void muted;
    void rampFrames;
    throw new Error("not implemented: A1.4 (CommandWriter.master)");
  }

  /** RESET (§4.2): `keepClips` 0 also resets the arena and slab classes. */
  reset(keepClips: boolean): void {
    void keepClips;
    throw new Error("not implemented: A1.4 (CommandWriter.reset)");
  }

  /**
   * Posts what is staged as one or more BATCHes. `firstFrame` is the frame every asap record would apply at
   * (`ClockMap.nextFirstFrame()`); a batch's header carries the earlier of it and its earliest stamp, and each
   * stamped record's `frameOffset` is its frame minus that. Returns the number of batches posted. Posts nothing, and
   * keeps everything staged, when the pool is empty.
   */
  flush(firstFrame: number): number {
    void firstFrame;
    throw new Error("not implemented: A1.4 (CommandWriter.flush)");
  }

  /** Drops everything staged (a rebuild, a closed host). */
  clear(): void {
    throw new Error("not implemented: A1.4 (CommandWriter.clear)");
  }
}
