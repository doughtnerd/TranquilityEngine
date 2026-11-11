// The main side of streaming (B3; ADR 0157; architecture §1, §2.3, §3.4, §7): `CoreBackend` plays a `PlayRequest`
// with `stream: true` as a stream voice. Main is never on its PCM path; this module only steers:
//
// - **Ids.** Each stream voice gets a stream id from the reserved clip range (`0xFFFF0100..`, past the HRIR ids), so
//   it never collides with a clip registry id in `table.clip`; the core keeps stream ids in a namespace of their own.
// - **Channel.** Before the first stream (and again after a hard rebuild or a new decoder worker) a `MessageChannel`
//   connects the decoder worker to the worklet: one end to the worker (`connectWorklet`), the other to the node
//   (`CoreLink.connectStreamPort`). Chunks and credits flow on it without main. The channel is the backend's
//   `WorkletChannel` (`workletChannel.ts`), shared with zone IRs (ADR 0162 C9): whichever needs it first connects it.
// - **Open.** The backend sends the PLAY (flag `stream`) at once; the core holds the voice until data arrives. Here the
//   file is fetched and handed to the worker (`openStream`, the bytes transferred), which posts STREAM_OPEN and chunks.
// - **Waiting.** The voice reads `reason === "waitingForData"` from its play until it sounds, and again while starved:
//   the core lists a starving voice in STATUS `starved` (the mirror sets the reason), and the reason clears when a
//   STATUS playhead shows the voice moving again (a starved voice holds its position).
// - **Seek** (B3b, `seek`). Main picks `epoch = ++entry.epoch`, posts `seek(streamId, frame, epoch)` to the worker and
//   sends a SEEK record with the same epoch (`deps.sendSeek`); the core fades the old audio out over 5 ms, flushes the
//   ring and takes only chunks of the new epoch (`stream.rs`). Before the worker has reported the file's rate
//   (`streamOpened`) a seek in seconds waits for it.
// - **Region loops and release** (ADR 0158 §4, M2 E4.4). A stream voice's loop (an event's `loopRegion` or `sustain`,
//   through `CoreAutomation.routeStreamLoop` → `setLoop`) goes to the worker: in `streamOpen` when the file's rate is
//   known by then (seconds to frames; cached per asset from earlier opens), else as a region change right after
//   `streamOpened`. A plain looping stream loops the whole file (0/0), as before (file loop points for plain loops are
//   E4.5's). A change while it plays (a release, `looping: false`, or a new region) lands at the end of the voice's
//   current pass, which main predicts from the voice's last STATUS playhead (`playheadAt`) at the
//   frame the change was asked for (`at`, as a SET_LOOP would land): the worker gets that stream frame and acts there,
//   splicing the core's ring when it had already sent past it (`decoder/streams.ts`, `stream.rs`). Each change reserves
//   the stream's next epoch for that splice. Main keeps the stream-frame → file-frame map that follows (`fileFrame`):
//   seeks, `reopenStreams` after a hard rebuild and the playhead wrap read it. The release lands on the predicted frame;
//   the prediction is exact while the voice neither starves nor changes pitch between the last STATUS and the end of the
//   pass.
// - **Ambisonic streams** (ADR 0162 B4, §2.4, §4.6). The open carries the sidecar's `ambisonic.convention`, so the
//   worker converts FuMa per chunk and streams all 4, 9 or 16 channels into a wide ring of the core. `streamOpened`
//   checks the channel count against the sidecar as the registry checks a clip's (`checkAmbisonic`: a mismatch fails
//   the stream), and a FuMa stream's `importGain` (the headroom scale) goes to the backend (`onImportGain`), which
//   multiplies the voice's volume by it, as a FuMa clip's import volume is. A wide stream's starves also count in
//   `wideStarved` (C24).
// - **Close.** When the voice is freed (ended, stopped, stolen) the stream is closed on the worker, which sends
//   STREAM_CLOSE to the worklet (the core frees the ring).
// - **Errors** (architecture §7): a stream error from the worker, a failed fetch or a refused ring stops the voice with
//   a 50 ms fade and warns once, naming the asset. A decoder worker that dies takes its streams with it (B6 respawns
//   it for clip decodes only): each of its streams fails this way, and the next stream connects a new channel, on
//   which the worklet closes the dead worker's rings.
import { MAX_STARVED_PER_BLOCK, StreamEvent, type StatusBlock } from "../wire.generated";
import { Assets } from "../../../../engine/scene/Assets";
import type { AmbisonicImport } from "../../../../engine/scene/importSettings";
import { setFileLoopPoints } from "../loopPoints";
import { wrapPosition, type LoopRecord } from "./coreAutomation";
import type { DecodeHint, StreamPortLike } from "../decoder/protocol";
import { hintFromName } from "../decoder/protocol";
import type { DecoderClient, StreamReply } from "../decoder/decoderClient";
import { checkAmbisonic, type ClipInfo } from "./clipRegistry";
import type { CoreLink } from "./context";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";
import { WorkletChannel, type StreamChannel } from "./workletChannel";

/** @internal The first stream id: past the HRIR clip ids (`0xFFFF0000..0xFFFF00FF`) in the reserved range. */
export const STREAM_ID_FIRST = 0xffff0100;
/** @internal How many stream ids there are before they wrap (a stream id lives as long as its voice). */
const STREAM_ID_COUNT = 0xffffffff - STREAM_ID_FIRST + 1;
/** @internal Architecture §7: a stream error stops its voice with a 50 ms fade. */
export const STREAM_ERROR_FADE_SECONDS = 0.05;

/**
 * @internal ADR 0166 §4.3 (R7): stream event 4, `musicFull`: the core's music pool had no ring for a music STREAM_OPEN
 * (the generated wire constant, ABI 3.0).
 */
export { STREAM_EVENT_MUSIC_FULL } from "../wire.generated";
import { STREAM_EVENT_MUSIC_FULL } from "../wire.generated";

/** @internal ADR 0166 (Q2): what `StreamManager.music` is (`core/musicOps.ts`). */
export interface MusicStreamEventSink {
  /** True when stream id `id` belongs to a music group member. */
  ownsStream(id: number): boolean;
  /** A STATUS stream event of a music member's stream, or code 4 for any stream. */
  onStreamEvent(id: number, code: number): void;
}

/** @internal What the manager needs of the decoder client. */
export type StreamDecoderLike = Pick<DecoderClient, "connectWorklet" | "openStream" | "closeStream" | "onStream" | "generation"> & Partial<Pick<DecoderClient, "seekStream" | "loopStream" | "primeGroup" | "cancelGroup" | "protectMusic" | "releaseMusic" | "onMusic">>;

export type { StreamChannel };

/** @internal What `StreamManager` takes. */
export interface StreamManagerDeps {
  readonly table: VoiceTable;
  /** The decoder client (the page's shared one in the app; tests pass one on an in-process worker). */
  readonly decoder: () => StreamDecoderLike;
  /** Hands the worklet its end of a channel (`CoreLink.connectStreamPort`). */
  readonly connectWorklet: (port: MessagePort | StreamPortLike) => void;
  /** Makes a channel; default `new MessageChannel()`. */
  readonly channel?: () => StreamChannel;
  /** ADR 0162 C9: the channel shared with zone IRs (the backend's); default one of this manager's own on the three above. */
  readonly worklet?: WorkletChannel<StreamDecoderLike>;
  /** B3b: sends the SEEK record for voice `id` (the backend's writer). */
  readonly sendSeek?: (id: number, frame: number, epoch: number) => void;
  /** Fetches an asset's encoded bytes. */
  readonly fetchBytes: (path: string) => Promise<ArrayBuffer>;
  /** A stream failed: stop voice `id` with a fade and warn (the backend's). `code` is the decoder's `ERR_*` code when it refused the file (B4). */
  readonly onError: (id: number, asset: string, message: string, code?: number) => void;
  /** E4.4: voice `voice`'s stream frame at context frame `frame` by the backend's playhead estimate (used until a STATUS shows it playing), or null. */
  readonly positionAt?: (voice: number, frame: number) => number | null;
  /** E4.4: voice `voice`'s stream frames per context frame now (pitch, rate; 0 paused). */
  readonly rateOf?: (voice: number) => number;
  /** B4: an asset's sidecar `ambisonic` block (default: `Assets.importSettings`), for the convention and the check. */
  readonly ambisonic?: (asset: string) => AmbisonicImport | null;
  /** B4: a FuMa stream's import gain (from `streamOpened`): the backend multiplies voice `voice`'s volume by it. */
  readonly onImportGain?: (voice: number, gain: number) => void;
}

/** E4.4: a loop region in file frames (`end` exclusive, resolved: never 0 once the file's length is known). */
interface Region {
  readonly start: number;
  readonly end: number;
}

/** E4.4: from stream frame `stream` on, the stream plays file frame `file` on, looping `region` or not. */
interface Segment {
  readonly stream: number;
  readonly file: number;
  readonly loop: boolean;
  readonly region: Region;
}

/** What an asset's earlier `streamOpened` said (E4.4: the next open can send its region in frames). */
interface FileFacts {
  readonly rate: number;
  readonly frames: number;
  readonly loop: Region | null;
}

interface Entry {
  readonly voice: number;
  readonly asset: string;
  /** Looping now (PLAY's loop flag, then the voice's loop record). */
  loop: boolean;
  /** E4.4: the voice's loop record (seconds; `end` 0 the end), or null: a plain stream (a plain loop loops the whole file). */
  record: LoopRecord | null;
  /** The file's own loop points (from `streamOpened`), or null. */
  fileLoop?: Region | null;
  /** The stream frame it opened at, and whether the open carried the voice's region in frames (else it looped the whole file). */
  openFrame: number;
  sentRegion: boolean;
  /** The stream-frame → file-frame map, newest last (empty until `streamOpened`). */
  segments: Segment[];
  /** From `streamOpened`: the file's rate, frames (0 until then, or when unknown) and channels (B4: over 2, wide). */
  rate: number;
  frames: number;
  channels?: number;
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
  /** Channels this manager made (one per decoder worker and core; one zone IRs made first isn't counted here). */
  connections: number;
  /** Seeks sent to the worker and the core (B3b). */
  seeks: number;
  /** B4 (C24): starves of wide (ambisonic) streams, also counted in `starves`. */
  wideStarved: number;
}

/** @internal The main side of streaming; see the header. */
export class StreamManager {
  readonly stats: StreamStats = { opened: 0, closed: 0, errors: 0, starves: 0, eos: 0, coreErrors: 0, connections: 0, seeks: 0, wideStarved: 0 };
  private readonly byStream = new Map<number, Entry>();
  /** Per slot: the playhead last seen in STATUS (the waiting reason clears when it moves). */
  private readonly seen: Float64Array;
  /** E4.4: per slot, the context frame of `seen` while the voice was playing (NaN: not since it opened or seeked). */
  private readonly seenFrame: Float64Array;
  private nextId = 0;
  /** E4.4: what each asset's last `streamOpened` said. */
  private readonly facts = new Map<string, FileFacts>();
  /** The worker ↔ worklet channel (shared with zone IRs in the backend). */
  private readonly worklet: WorkletChannel<StreamDecoderLike>;
  /** B3b: told the frame a seek that waited for the file's rate landed on (the backend re-anchors the playhead). */
  afterSeek: ((voice: number, frame: number) => void) | null = null;
  /**
   * ADR 0166 (Q2): where music stream events go (the backend's `musicOps`, P1 fills it): stream event 4 (`musicFull`),
   * and every event of a stream a music group member owns. Those never reach the counts and failures below.
   */
  music: MusicStreamEventSink | null = null;
  private unsubscribe: (() => void) | null = null;
  private subscribed: StreamDecoderLike | null = null;
  private readonly starved: number[] = [];

  constructor(private readonly deps: StreamManagerDeps) {
    this.worklet = deps.worklet ?? new WorkletChannel<StreamDecoderLike>({ decoder: deps.decoder, connectWorklet: deps.connectWorklet, channel: deps.channel });
    this.seen = new Float64Array(deps.table.capacity);
    this.seenFrame = new Float64Array(deps.table.capacity).fill(Number.NaN);
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
    this.byStream.set(streamId, { voice, asset, loop, record: null, openFrame: 0, sentRegion: false, segments: [], rate: 0, frames: 0, epoch: 1 });
  }

  /**
   * E4.4: stream `streamId`'s voice loops `loop` (a region, or `looping: false` a release), asked for at context frame
   * `at`. Before the stream is open it rides in `streamOpen` (or follows `streamOpened`); while it plays it lands at the
   * end of the voice's current pass (see the header).
   */
  setLoop(streamId: number, loop: LoopRecord, at: number): void {
    const e = this.byStream.get(streamId);
    if (!e || e.failed) return;
    e.record = loop;
    if (e.rate <= 0 || e.segments.length === 0) {
      // Not open yet: the open (or `streamOpened`) sends it.
      e.loop = loop.looping;
      return;
    }
    this.sendLoop(streamId, e, at);
  }

  /**
   * E4.4: the file frame stream `streamId` plays at stream frame `pos` (its playhead's unit), from the map the opens,
   * wraps, splices and seeks made; `pos` itself while the file isn't known. Past the end of a stream that no longer
   * loops it is past `frames` (the caller drops it).
   */
  fileFrame(streamId: number, pos: number): number {
    const e = this.byStream.get(streamId);
    if (!e || e.segments.length === 0) return pos;
    return fileAt(e.segments, pos, e.frames);
  }

  /** E4.4: whether stream `streamId` loops now (a released one doesn't). */
  looping(streamId: number): boolean {
    return this.byStream.get(streamId)?.loop ?? false;
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
    this.seenFrame[i] = Number.NaN;
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
        e.openFrame = startFrame;
        // E4.4: the region in frames when the file's rate is known already (a plain loop: the whole file).
        const facts = this.facts.get(e.asset);
        // Never the file's own points: a looping stream whose region isn't known in frames yet loops the whole file (0/0)
        // until `streamOpened` sends it.
        const region = e.loop && e.record && facts ? regionOf(e.record, facts.rate, facts.frames) : null;
        e.sentRegion = region !== null;
        // B4: the sidecar's convention lets the worker stream an ambisonic file's channels (FuMa converted per chunk).
        const convention = this.ambisonicOf(e.asset)?.convention;
        decoder.openStream({ streamId, asset: e.asset, bytes, hint, startFrame, epoch: e.epoch, loop: e.loop, ...(e.loop ? { loopStartFrame: region?.start ?? 0, loopEndFrame: region?.end ?? 0 } : {}), ...(convention ? { convention } : {}) });
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
    if (e) this.byStream.set(id, { ...e, failed: false, epoch: 1, pendingSeek: undefined, segments: [], sentRegion: false });
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
    // E4.4: a loop wraps into its region (the whole file for a plain loop).
    const region = this.regionNow(e);
    if (e.frames > 0) frame = e.loop ? wrapPosition(frame, region.start, region.end, e.frames) : Math.min(frame, e.frames);
    if (e.segments.length > 0) e.segments = [{ stream: frame, file: frame, loop: e.loop, region }];
    const epoch = ++e.epoch;
    this.stats.seeks++;
    const i = e.voice & 0xffff;
    this.seen[i] = frame;
    this.seenFrame[i] = Number.NaN;
    this.deps.table.reason[i] = VoiceReason.WAITING_FOR_DATA;
    this.subscribed?.seekStream?.(streamId, frame, epoch);
    this.deps.sendSeek?.(e.voice, frame, epoch);
    return frame;
  }

  /** The core is being replaced: the next open connects a new channel to the new node. */
  disconnect(): void {
    this.worklet.disconnect();
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
    // A worker spawned since (or never connected), or a new core: a new channel to both (unless zone IRs made it).
    const before = this.worklet.connections;
    this.worklet.ensure();
    if (this.worklet.connections !== before) this.stats.connections++;
    return decoder;
  }

  private onReply(reply: StreamReply): void {
    const e = this.byStream.get(reply.streamId);
    if (!e) return;
    if (reply.type === "streamOpened") {
      e.rate = reply.info.rate;
      e.frames = reply.info.frames > 0 ? reply.info.frames : 0;
      e.channels = reply.info.channels;
      // B4 (ADR 0162 §2.4): over 2 channels the sidecar must agree (order, WAV for orders 2-3), as for a clip.
      if (reply.info.channels > 2) {
        const checked = checkAmbisonic(e.asset, reply.info.channels, this.ambisonicOf(e.asset));
        if ("error" in checked) return this.fail(reply.streamId, `audio decoder: ${checked.error}`);
      }
      if (reply.info.importGain !== undefined && reply.info.importGain !== 1) this.deps.onImportGain?.(e.voice, reply.info.importGain);
      // E4.4: the file's own loop points, the asset's facts for the next open, and the map from here.
      const info = reply.info;
      e.fileLoop = info.loopStartFrame !== undefined && info.loopEndFrame !== undefined && info.loopEndFrame > info.loopStartFrame ? { start: info.loopStartFrame, end: info.loopEndFrame } : null;
      if (e.rate > 0) {
        this.facts.set(e.asset, { rate: e.rate, frames: e.frames, loop: e.fileLoop });
        // C1: what the decoder found in a streamed file, as it does for decoded clips (E4.2 keeps it, E4.5 uses it).
        setFileLoopPoints(e.asset, e.fileLoop ? { start: e.fileLoop.start / e.rate, end: e.fileLoop.end / e.rate } : null);
      }
      const opened = e.sentRegion ? this.regionNow(e) : { start: 0, end: e.frames };
      const file = e.loop ? wrapPosition(e.openFrame, opened.start, opened.end, e.frames) : e.openFrame;
      e.segments = [{ stream: e.openFrame, file, loop: e.loop, region: opened }];
      // A region asked for before the rate was known goes now, from the start of the stream.
      if (!e.sentRegion && e.record && e.loop) this.sendLoop(reply.streamId, e, Number.NaN);
      if (e.pendingSeek !== undefined) {
        const frame = this.seek(reply.streamId, e.pendingSeek);
        if (frame !== null) this.afterSeek?.(e.voice, frame);
      }
    } else if (reply.type === "error") {
      this.stats.errors++;
      this.fail(reply.streamId, reply.message, reply.code);
    }
  }

  /**
   * E4.4: voice `voice`'s stream frame at context frame `frame`: its last STATUS playhead while playing, run on at its
   * rate (exact unless it starves or its pitch moves meanwhile), else the backend's estimate.
   */
  private playheadAt(voice: number, frame: number): number | null {
    const i = voice & 0xffff;
    const at = this.seenFrame[i]!;
    if (at === at) return this.seen[i]! + Math.max(0, frame - at) * (this.deps.rateOf?.(voice) ?? 0);
    return this.deps.positionAt?.(voice, frame) ?? null;
  }

  /** The region `e` loops by its record now (resolved against the file), or the whole file. */
  private regionNow(e: Entry): Region {
    return (e.rate > 0 ? regionOf(e.record, e.rate, e.frames) : null) ?? { start: 0, end: e.frames };
  }

  /**
   * E4.4: sends `e`'s loop record as a change landing at the end of the voice's current pass at context frame `at`
   * (NaN: from where the stream opened, before it sounds), reserving the next epoch, and extends the map.
   */
  private sendLoop(streamId: number, e: Entry, at: number): void {
    const rec = e.record;
    if (!rec) return;
    const segs = e.segments;
    const p0 = Number.isNaN(at) ? e.openFrame : this.playheadAt(e.voice, at);
    const p = p0 === null || p0 === undefined ? null : Math.max(segs[0]!.stream, Math.floor(p0));
    // The segment the voice is in at `p` (later ones are changes still ahead of it; the next one's start, a seam, ends its pass).
    let k = segs.length - 1;
    while (p !== null && k > 0 && segs[k]!.stream > p) k--;
    const cur = segs[k]!;
    const ahead = segs[k + 1];
    const f = p === null ? 0 : fileAt(segs, p, e.frames);
    const region = this.regionNow(e);
    let x: number | undefined;
    let next: Segment | null = null;
    if (p !== null && e.frames > 0) {
      // Where the voice's current pass ends: its segment's seam, or a change still ahead (which begins with one).
      const seam = cur.loop ? p + (cur.region.end - f) : Number.POSITIVE_INFINITY;
      const stop = ahead ? Math.min(seam, ahead.stream) : seam;
      const lin = (at: number) => (at === seam ? cur.region.end : f + (at - p)); // the file frame at `at` without a wrap
      if (rec.looping) {
        // A new region: its end, if the voice reaches it first in this pass, else the pass's end; there it jumps to
        // the region's start unless it is inside the region already.
        const end = f < region.end && p + (region.end - f) < stop ? p + (region.end - f) : stop;
        if (Number.isFinite(end)) {
          x = end;
          const file = end === stop ? lin(end) : region.end;
          next = { stream: x, file: file >= region.start && file < region.end ? file : region.start, loop: true, region };
        }
      } else if (Number.isFinite(stop)) {
        x = stop;
        next = { stream: x, file: lin(x), loop: false, region: cur.region };
      }
    }
    e.loop = rec.looping;
    e.epoch = (e.epoch + 1) >>> 0;
    if (next) {
      while (segs.length > 1 && segs[segs.length - 1]!.stream >= next.stream) segs.pop();
      segs.push(next);
    } else if (segs.length > 0) {
      // Where the worker is: the map can't know the frame; it follows the change from the voice's position.
      segs.push({ stream: p ?? cur.stream, file: f, loop: rec.looping, region: rec.looping ? region : cur.region });
    }
    this.subscribed?.loopStream?.(streamId, rec.looping, rec.looping ? region.start : undefined, rec.looping ? region.end : undefined, x);
  }

  /** B4: `asset`'s sidecar `ambisonic` block, or null. */
  private ambisonicOf(asset: string): AmbisonicImport | null {
    return this.deps.ambisonic ? this.deps.ambisonic(asset) : Assets.importSettings(asset).ambisonic;
  }

  private fail(streamId: number, err: unknown, code?: number): void {
    const e = this.byStream.get(streamId);
    if (!e || e.failed) return;
    e.failed = true;
    const message = err instanceof Error ? err.message : String(err);
    this.deps.onError(e.voice, e.asset, message, code);
  }

  /**
   * A STATUS stream event (drained per frame by the backend). Code 3 is the core refusing the stream (no ring free).
   * ADR 0166 (Q2): code 4 (`musicFull`, the music pool) and a music member's events go to `music`.
   */
  streamEvent(id: number, code: number): void {
    const music = this.music;
    if (music !== null && (code === STREAM_EVENT_MUSIC_FULL || music.ownsStream(id))) {
      music.onStreamEvent(id, code);
      return;
    }
    if (code === StreamEvent.Starved) {
      this.stats.starves++;
      if ((this.byStream.get(id)?.channels ?? 0) > 2) this.stats.wideStarved++;
    }
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
      // E4.4: where it plays, for `playheadAt` (a waiting or starved voice holds; the core reports the end of a block).
      this.seenFrame[i] = !starved.includes(id) && t.reason[i] !== VoiceReason.WAITING_FOR_DATA ? status.currentFrame : Number.NaN;
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

/** A loop record (seconds) as a region of a file at `rate` with `frames` frames (0 unknown); null without a record. */
function regionOf(rec: LoopRecord | null, rate: number, frames: number): Region | null {
  if (!rec) return null;
  let start = Math.max(0, Math.round(rec.start * rate));
  let end = rec.end > 0 ? Math.round(rec.end * rate) : frames;
  if (frames > 0 && (end <= 0 || end > frames)) end = frames;
  if (!(start < end)) {
    start = 0;
    end = frames;
  }
  return { start, end };
}

/** The file frame at stream frame `pos` by the map `segs` (newest last) of a `frames`-frame file. */
function fileAt(segs: readonly Segment[], pos: number, frames: number): number {
  let k = segs.length - 1;
  while (k > 0 && segs[k]!.stream > pos) k--;
  const s = segs[k]!;
  const f = s.file + Math.max(0, pos - s.stream);
  return s.loop ? wrapPosition(f, s.region.start, s.region.end, frames) : f;
}
