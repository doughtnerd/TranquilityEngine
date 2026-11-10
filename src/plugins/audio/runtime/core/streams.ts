// The main side of streaming (B3; ADR 0157; architecture §1, §2.3, §3.4, §7): `CoreBackend` plays a `PlayRequest`
// with `stream: true` as a stream voice. Main is never on its PCM path; this module only steers:
//
// - **Ids.** Each stream voice gets a stream id from the reserved clip range (`0xFFFF0100..`, past the HRIR ids), so
//   it never collides with a clip registry id in `table.clip`; the core keeps stream ids in a namespace of their own.
// - **Channel.** Before the first stream (and again after a hard rebuild or a new decoder worker) a `MessageChannel`
//   connects the decoder worker to the worklet: one end to the worker (`connectWorklet`), the other to the node
//   (`CoreLink.connectStreamPort`). Chunks and credits flow on it without main.
// - **Open.** The backend sends the PLAY (flag `stream`) at once; the core holds the voice until data arrives. Here the
//   file is fetched and handed to the worker (`openStream`, the bytes transferred), which posts STREAM_OPEN and chunks.
// - **Waiting.** The voice reads `reason === "waitingForData"` from its play until it sounds, and again while starved:
//   the core lists a starving voice in STATUS `starved` (the mirror sets the reason), and the reason clears when a
//   STATUS playhead shows the voice moving again (a starved voice holds its position).
// - **Seek** (B3b, `seek`). Main picks `epoch = ++entry.epoch`, posts `seek(streamId, frame, epoch)` to the worker and
//   sends a SEEK record with the same epoch (`deps.sendSeek`); the core fades the old audio out over 5 ms, flushes the
//   ring and takes only chunks of the new epoch (`stream.rs`). Before the worker has reported the file's rate
//   (`streamOpened`) a seek in seconds waits for it.
// - **Close.** When the voice is freed (ended, stopped, stolen) the stream is closed on the worker, which sends
//   STREAM_CLOSE to the worklet (the core frees the ring).
// - **Errors** (architecture §7): a stream error from the worker, a failed fetch or a refused ring stops the voice with
//   a 50 ms fade and warns once, naming the asset. A decoder worker that dies takes its streams with it (B6 respawns
//   it for clip decodes only): each of its streams fails this way, and the next stream connects a new channel, on
//   which the worklet closes the dead worker's rings.
import { MAX_STARVED_PER_BLOCK, StreamEvent, type StatusBlock } from "../wire.generated";
import type { DecodeHint, StreamPortLike } from "../decoder/protocol";
import { hintFromName } from "../decoder/protocol";
import type { DecoderClient, StreamReply } from "../decoder/decoderClient";
import type { ClipInfo } from "./clipRegistry";
import type { CoreLink } from "./context";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";

/** @internal The first stream id: past the HRIR clip ids (`0xFFFF0000..0xFFFF00FF`) in the reserved range. */
export const STREAM_ID_FIRST = 0xffff0100;
/** @internal How many stream ids there are before they wrap (a stream id lives as long as its voice). */
const STREAM_ID_COUNT = 0xffffffff - STREAM_ID_FIRST + 1;
/** @internal Architecture §7: a stream error stops its voice with a 50 ms fade. */
export const STREAM_ERROR_FADE_SECONDS = 0.05;

/** @internal What the manager needs of the decoder client. */
export type StreamDecoderLike = Pick<DecoderClient, "connectWorklet" | "openStream" | "closeStream" | "onStream" | "generation"> & Partial<Pick<DecoderClient, "seekStream">>;

/** @internal The two ends of a channel. */
export interface StreamChannel {
  readonly worker: MessagePort | StreamPortLike;
  readonly worklet: MessagePort | StreamPortLike;
}

/** @internal What `StreamManager` takes. */
export interface StreamManagerDeps {
  readonly table: VoiceTable;
  /** The decoder client (the page's shared one in the app; tests pass one on an in-process worker). */
  readonly decoder: () => StreamDecoderLike;
  /** Hands the worklet its end of a channel (`CoreLink.connectStreamPort`). */
  readonly connectWorklet: (port: MessagePort | StreamPortLike) => void;
  /** Makes a channel; default `new MessageChannel()`. */
  readonly channel?: () => StreamChannel;
  /** B3b: sends the SEEK record for voice `id` (the backend's writer). */
  readonly sendSeek?: (id: number, frame: number, epoch: number) => void;
  /** Fetches an asset's encoded bytes. */
  readonly fetchBytes: (path: string) => Promise<ArrayBuffer>;
  /** A stream failed: stop voice `id` with a fade and warn (the backend's). */
  readonly onError: (id: number, asset: string, message: string) => void;
}

interface Entry {
  readonly voice: number;
  readonly asset: string;
  readonly loop: boolean;
  /** From `streamOpened`: the file's rate and frames (0 until then, or when unknown). */
  rate: number;
  frames: number;
  /** The seek epoch: 1 at open, one more per seek (B3b). */
  epoch: number;
  /** A seek in seconds asked for before the file's rate was known (applied on `streamOpened`). */
  pendingSeek?: number;
  /** Failed already (stopping): later errors for it (a dead worker's rings closed early in the core) say nothing more. */
  failed?: boolean;
}

/** @internal Counts for `Audio.debug()` and tests. */
export interface StreamStats {
  opened: number;
  closed: number;
  errors: number;
  /** Stream events from STATUS: starves, ends of stream, core-side errors (a refused ring). */
  starves: number;
  eos: number;
  coreErrors: number;
  /** Channels made (one per decoder worker and core). */
  connections: number;
  /** Seeks sent to the worker and the core (B3b). */
  seeks: number;
}

/** @internal The main side of streaming; see the header. */
export class StreamManager {
  readonly stats: StreamStats = { opened: 0, closed: 0, errors: 0, starves: 0, eos: 0, coreErrors: 0, connections: 0, seeks: 0 };
  private readonly byStream = new Map<number, Entry>();
  /** Per slot: the playhead last seen in STATUS (the waiting reason clears when it moves). */
  private readonly seen: Float64Array;
  private nextId = 0;
  /** The decoder generation and core this manager connected, or -1 when a new channel is needed. */
  private connectedGeneration = -1;
  /** B3b: told the frame a seek that waited for the file's rate landed on (the backend re-anchors the playhead). */
  afterSeek: ((voice: number, frame: number) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private subscribed: StreamDecoderLike | null = null;
  private readonly starved: number[] = [];

  constructor(private readonly deps: StreamManagerDeps) {
    this.seen = new Float64Array(deps.table.capacity);
  }

  /** Stream voices open. */
  get size(): number {
    return this.byStream.size;
  }

  /** A new stream id. */
  allocate(): number {
    const id = STREAM_ID_FIRST + this.nextId;
    this.nextId = (this.nextId + 1) % STREAM_ID_COUNT;
    return id >>> 0;
  }

  /** Voice `voice` plays stream `streamId` of `asset` (its PLAY may still wait for the unlock). */
  register(streamId: number, voice: number, asset: string, loop: boolean): void {
    this.byStream.set(streamId, { voice, asset, loop, rate: 0, frames: 0, epoch: 1 });
  }

  /** A `ClipInfo` for stream `id` (the playhead tracker's rate and the replay's loop length), or null. */
  clipInfo(id: number): ClipInfo | null {
    const e = this.byStream.get(id);
    if (!e) return null;
    return { id, path: e.asset, state: "ready", refs: 1, frames: e.frames, channels: 0, sampleRate: e.rate, format: 0, bytes: 0, failure: null };
  }

  /** The asset of stream `id` (for `Audio.debug()`), or null. */
  assetOf(id: number): string | null {
    return this.byStream.get(id)?.asset ?? null;
  }

  /**
   * Starts stream `streamId` on the worker from stream frame `startFrame`: connects the channel if needed, fetches the
   * file and opens it. The voice reads "waitingForData" until it sounds.
   */
  open(streamId: number, startFrame = 0): void {
    const e = this.byStream.get(streamId);
    if (!e) return;
    const t = this.deps.table;
    const i = e.voice & 0xffff;
    this.seen[i] = startFrame;
    t.reason[i] = VoiceReason.WAITING_FOR_DATA;
    let decoder: StreamDecoderLike;
    try {
      decoder = this.connect();
    } catch (err) {
      this.fail(streamId, err);
      return;
    }
    const hint: DecodeHint = hintFromName(e.asset);
    this.deps.fetchBytes(e.asset).then(
      (bytes) => {
        if (this.byStream.get(streamId) !== e) return; // closed meanwhile
        this.stats.opened++;
        decoder.openStream({ streamId, asset: e.asset, bytes, hint, startFrame, epoch: e.epoch, loop: e.loop });
      },
      (err) => {
        if (this.byStream.get(streamId) === e) this.fail(streamId, err);
      },
    );
  }

  /** The voice of stream `streamId` is gone: close it on the worker (the worklet then frees the ring). */
  close(streamId: number): void {
    if (!this.byStream.delete(streamId)) return;
    this.stats.closed++;
    this.subscribed?.closeStream(streamId);
  }

  /**
   * A hard rebuild: stream `oldId`'s voice moves to a new stream id (the new core has no ring for the old one), to be
   * opened again from its playhead. Returns the new id.
   */
  rekey(oldId: number): number {
    const e = this.byStream.get(oldId);
    const id = this.allocate();
    this.close(oldId);
    if (e) this.byStream.set(id, { ...e, failed: false, epoch: 1, pendingSeek: undefined });
    return id;
  }

  /**
   * B3b: seeks stream `streamId` to `seconds` (of its file) and returns the stream frame it lands on, or null when it
   * isn't known yet (the seek then waits for the file's rate) or there is no such stream. The frame is clamped to the
   * file (wrapped for a loop). The voice reads "waitingForData" until it sounds from there.
   */
  seek(streamId: number, seconds: number): number | null {
    const e = this.byStream.get(streamId);
    if (!e || e.failed) return null;
    if (e.rate <= 0) {
      e.pendingSeek = seconds;
      return null;
    }
    e.pendingSeek = undefined;
    let frame = Math.max(0, Math.round(seconds * e.rate));
    if (e.frames > 0) frame = e.loop ? frame % e.frames : Math.min(frame, e.frames);
    const epoch = ++e.epoch;
    this.stats.seeks++;
    const i = e.voice & 0xffff;
    this.seen[i] = frame;
    this.deps.table.reason[i] = VoiceReason.WAITING_FOR_DATA;
    this.subscribed?.seekStream?.(streamId, frame, epoch);
    this.deps.sendSeek?.(e.voice, frame, epoch);
    return frame;
  }

  /** The core is being replaced: the next open connects a new channel to the new node. */
  disconnect(): void {
    this.connectedGeneration = -1;
  }

  /** Listens to STATUS (after the mirror): clears "waitingForData" for stream voices that are moving again. */
  attach(link: Pick<CoreLink, "onStatus">): () => void {
    return link.onStatus((status) => this.onStatus(status));
  }

  /** The decoder, its replies subscribed, connected to the current worklet. */
  private connect(): StreamDecoderLike {
    const decoder = this.deps.decoder();
    if (this.subscribed !== decoder) {
      this.unsubscribe?.();
      this.subscribed = decoder;
      this.unsubscribe = decoder.onStream((reply) => this.onReply(reply));
    }
    // A worker spawned since (or never connected), or a new core: a new channel to both.
    if (this.connectedGeneration === -1 || this.connectedGeneration !== decoder.generation) {
      const channel = this.deps.channel?.() ?? defaultChannel();
      decoder.connectWorklet(channel.worker);
      this.deps.connectWorklet(channel.worklet);
      this.connectedGeneration = decoder.generation;
      this.stats.connections++;
    }
    return decoder;
  }

  private onReply(reply: StreamReply): void {
    const e = this.byStream.get(reply.streamId);
    if (!e) return;
    if (reply.type === "streamOpened") {
      e.rate = reply.info.rate;
      e.frames = reply.info.frames > 0 ? reply.info.frames : 0;
      if (e.pendingSeek !== undefined) {
        const frame = this.seek(reply.streamId, e.pendingSeek);
        if (frame !== null) this.afterSeek?.(e.voice, frame);
      }
    } else if (reply.type === "error") {
      this.stats.errors++;
      this.fail(reply.streamId, reply.message);
    }
  }

  private fail(streamId: number, err: unknown): void {
    const e = this.byStream.get(streamId);
    if (!e || e.failed) return;
    e.failed = true;
    const message = err instanceof Error ? err.message : String(err);
    this.deps.onError(e.voice, e.asset, message);
  }

  /** A STATUS stream event (drained per frame by the backend). Code 3 is the core refusing the stream (no ring free). */
  streamEvent(id: number, code: number): void {
    if (code === StreamEvent.Starved) this.stats.starves++;
    else if (code === StreamEvent.Eos) this.stats.eos++;
    else if (code === StreamEvent.Error) {
      this.stats.coreErrors++;
      const e = this.byStream.get(id);
      // A drained stream closed early ends on its own; a voice still live here had its ring refused.
      if (e && this.deps.table.isLive(e.voice)) this.fail(id, "audio: no stream ring free (too many streams at once)");
    }
  }

  private onStatus(status: StatusBlock): void {
    if (this.byStream.size === 0) return;
    const t = this.deps.table;
    const starved = this.starved;
    starved.length = 0;
    for (let k = 0; k < status.starved.length && k < MAX_STARVED_PER_BLOCK; k++) starved.push(status.starved[k]!);
    const playheads = status.playheads;
    for (let k = 0; k < playheads.length; k++) {
      const { id, clipFrame } = playheads[k]!;
      const i = id & 0xffff;
      if (!t.isLive(id) || (t.flags[i]! & VoiceFlag.STREAM) === 0) continue;
      const prev = this.seen[i]!;
      this.seen[i] = clipFrame;
      if (t.reason[i] !== VoiceReason.WAITING_FOR_DATA || clipFrame === prev || starved.includes(id)) continue;
      const s = t.state[i];
      if (s === VoiceState.PLAYING) t.reason[i] = VoiceReason.NONE;
      else if (s === VoiceState.VIRTUAL) t.reason[i] = VoiceReason.VIRTUAL;
    }
  }

  /** Closes every stream and stops listening. */
  dispose(): void {
    for (const id of [...this.byStream.keys()]) this.close(id);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribed = null;
  }
}

function defaultChannel(): StreamChannel {
  const channel = new MessageChannel();
  return { worker: channel.port1, worklet: channel.port2 };
}
