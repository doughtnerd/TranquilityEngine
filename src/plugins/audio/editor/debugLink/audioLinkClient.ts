// The audio link client (ADR 0417): the tool side of the build's `audio` debug-link topic (schema in
// `runtime/debugLink/schema.ts`, build side in `runtime/debugLink/topic.ts`), made from a `DebugLinkPeer`. It owns the
// topic's method names, record types, decoding and reassembly, so a tool (the Audio Studio, a test, an e2e spec) never
// speaks the wire itself:
//
// - **Take operations**: `start`, `stop`, `mark` (each answering the take's state), `frames` (the take pictures' width).
// - **Uploads as bytes**: `uploadTake` (`take.upload`), `buildAudio` (`build.audio`, parsed) and `buildFile`
//   (`build.file`). One reassembly for all of them: it reads only `AudioLinkRecord.takeChunk` records, takes the chunks in
//   order (a chunk delivered again with the same bytes is skipped; anything else out of order fails), reports progress
//   and can be aborted (`AbortSignal`).
// - **Follows**: the take's state (`take`, ADR 0408: while one is held the tool owns the build's takes), the live take
//   (`takeLive`, reassembled by `TakeLiveStream` into `Take` snapshots a few times a second) and the live capture
//   (`capture`: the ring's head, then each sealed segment, reassembled from pieces). Updates arrive through plain
//   callbacks, and each follow returns its unsubscribe. No signals: the Studio's build session is the reactive seam.
// - **Mix ops**: `mixOp` sends one live mix op as the `mix.op` command.
//
// A request the build refuses, a request or upload cut by the link closing (`linkClosed`, or the peer already closed),
// a reply or record that doesn't read and an aborted upload all reject with one `AudioLinkError`, whose `kind` says which
// and whose message is the reason (the build's own message for a refusal).
import type { DebugLinkPeer } from "../../../../engine/debugLink/client";
import type { LinkRecord } from "../../../../engine/debugLink/records";
import type { MixOp } from "../../../../engine/audio/mixOps";
import type { Take } from "../../../../engine/audio/take/reader";
import type { AudioTakeState } from "../../runtime/capture/take";
import {
  AUDIO_TOPIC, AudioLinkRecord, AudioRequest, MIX_OP_COMMAND, decodeCapturePiece, decodeTakeChunk, decodeTakeState, mixOpCommand,
  type AudioSubscriptionParams, type BuildAudioIndex, type BuildFileParams, type TakeChunk, type TakeFramesParams, type TakeMarkParams,
  type TakeStateReply, type TakeUploadReply,
} from "../../runtime/debugLink/schema";
import { TakeLiveStream } from "./takeLiveStream";

/** What the client needs of a peer (a `DebugLinkPeer`; a test may hand it a fake). */
export type AudioLinkPeer = Pick<DebugLinkPeer, "subscribe" | "request" | "command" | "state" | "closedReason">;

/**
 * Why an audio link operation failed: `refused` (the build answered with an error), `closed` (the link closed before
 * it finished), `broken` (a reply or record that doesn't read, an upload out of order) or `aborted` (the caller's signal).
 */
export type AudioLinkErrorKind = "refused" | "closed" | "broken" | "aborted";

/** The one error an audio link operation rejects with. Its message is the reason. */
export class AudioLinkError extends Error {
  constructor(
    readonly kind: AudioLinkErrorKind,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "AudioLinkError";
  }
}

/** An upload's progress: `received` of `chunks` chunks (`bytes` of `total` bytes). */
export interface UploadProgress {
  readonly received: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly total: number;
}

export interface UploadOptions {
  /** Progress: once when the upload starts (nothing received), then after each chunk but the last. */
  onProgress?(progress: UploadProgress): void;
  /** Aborts the upload (its reason, a string or an error's message, is the error's). */
  readonly signal?: AbortSignal;
}

/** The live take as it stands: the take recording on the build (or its last one, stopped). */
export interface LiveTakeSnapshot {
  readonly state: "recording" | "stopped";
  /** The take so far: requests, keyframes and pictures; META's facts (its duration grows while it records). */
  readonly take: Take;
  /** The take's id on the build: a new take, a new id. */
  readonly id: number;
  /** Whether the build takes pictures for it, and how wide. */
  readonly pictures: boolean;
  readonly pictureWidth: number;
  /** Why it stopped by itself (the build's message), or why the feed broke or ended; null otherwise. */
  readonly message: string | null;
}

export interface LiveTakeFollowOptions {
  /** At most how often a growing take is handed out, ms (default `LIVE_TAKE_PUBLISH_MS`); a start or stop at once. */
  readonly publishMs?: number;
}

/** How often the live take is handed out while records arrive, at most, ms. */
export const LIVE_TAKE_PUBLISH_MS = 250;

/** Why a live capture follow ended: the ring dropped a segment, the feed broke, the build refused it, the link closed. */
export interface CaptureFollowEnd {
  readonly kind: "lost" | "broken" | "refused" | "closed";
  readonly reason: string;
}

/** What a live capture follow hears. */
export interface CaptureFollower {
  /** The ring's head (`LiveRecording.head()`), whole; first, once. */
  head(bytes: Uint8Array): void;
  /** A sealed segment of raw capture records, whole, in order. */
  segment(id: number, bytes: Uint8Array): void;
  /** The feed ended for good (once); nothing follows. */
  ended(end: CaptureFollowEnd): void;
}

/** The tool side of a build's audio topic. */
export interface AudioLinkClient {
  /** `take.start`: the build begins a take; answers its state. */
  start(): Promise<TakeStateReply>;
  /** `take.stop`: the build ends the take and keeps it for an upload. */
  stop(): Promise<TakeStateReply>;
  /** `take.mark`: a marker with `text` at the take's present moment (a no-op while none records). */
  mark(text: string): Promise<TakeStateReply>;
  /** `take.frames`: the width of the pictures takes started from now on record; answers the width in force. */
  frames(width: number): Promise<number>;
  /** `take.upload`: the build's take as file bytes (stopping a running take). */
  uploadTake(options?: UploadOptions): Promise<Uint8Array>;
  /** `build.audio` (ADR 0410): the build's audio index. */
  buildAudio(options?: UploadOptions): Promise<BuildAudioIndex>;
  /** `build.file` (ADR 0410): one file of the build's audio, as bytes. */
  buildFile(file: BuildFileParams, options?: UploadOptions): Promise<Uint8Array>;
  /** `mix.op`: sends one live mix op. False when the link isn't open; throws when the op can't be encoded. */
  mixOp(op: MixOp): boolean;
  /** Follows the take's state (now, then each change); `ended` says why the follow stopped (a refusal, the link). */
  followTakeState(on: (state: TakeStateReply) => void, ended?: (reason: string) => void): () => void;
  /**
   * Follows the live take: `on` hears the take as it stands (null until the build has one), a start or stop at once, its
   * growth a few times a second. When the feed ends (an older build refuses it, the link closes) what was handed out last
   * comes again with why.
   */
  followLiveTake(on: (live: LiveTakeSnapshot | null) => void, options?: LiveTakeFollowOptions): () => void;
  /** Follows the live capture: the build joins its ring as an owner while this holds. */
  followCapture(follower: CaptureFollower): () => void;
  /**
   * The link closed (the peer drops its subscriptions without a word): every request and upload still running rejects
   * with `reason` (`closed`), every follow ends with it, and nothing more is sent.
   */
  linkClosed(reason: string): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const TAKE_STATES: readonly AudioTakeState[] = ["idle", "loading", "recording", "stopped"];
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function readStateReply(v: unknown, method: string): TakeStateReply {
  const r = (v ?? {}) as Record<string, unknown>;
  if (TAKE_STATES.includes(r.state as AudioTakeState) && typeof r.seconds === "number") return { state: r.state as AudioTakeState, seconds: r.seconds };
  throw new AudioLinkError("broken", `${method}'s reply isn't a take's state`);
}

function readUploadReply(v: unknown, method: string): TakeUploadReply {
  const r = (v ?? {}) as Record<string, unknown>;
  if (isCount(r.upload) && isCount(r.bytes) && isCount(r.chunks) && r.chunks >= 1 && isCount(r.chunkBytes) && r.chunkBytes >= 1 && typeof r.seconds === "number") {
    return { upload: r.upload, bytes: r.bytes, chunks: r.chunks, chunkBytes: r.chunkBytes, seconds: r.seconds };
  }
  throw new AudioLinkError("broken", `${method}'s reply isn't an upload`);
}

function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === "string" ? r : r instanceof Error ? r.message : "the upload was aborted";
}

/** What reassembling an upload says of the next chunk. */
type ReceiveStep = { readonly status: "more"; readonly received: number } | { readonly status: "done"; readonly bytes: Uint8Array } | { readonly status: "error"; readonly error: string };

/**
 * Reassembles one upload (`reply` is the request's answer): the chunks in order, the file's bytes when the last arrives.
 * Any chunk that isn't the next one, a wrong upload or total, or more bytes than the reply promised fails it for good.
 */
function uploadReceiver(reply: TakeUploadReply): (chunk: TakeChunk) => ReceiveStep {
  const out = new Uint8Array(reply.bytes);
  let next = 0;
  let received = 0;
  let failure: string | null = null;
  let done = false;
  const fail = (error: string): ReceiveStep => {
    failure = error;
    return { status: "error", error };
  };
  return (chunk) => {
    if (failure) return { status: "error", error: failure };
    if (done) return fail("the upload already finished");
    if (chunk.upload !== reply.upload) return fail(`chunk of upload ${chunk.upload}, expected upload ${reply.upload}`);
    if (chunk.total !== reply.chunks) return fail(`chunk says ${chunk.total} chunks in all, the upload has ${reply.chunks}`);
    // A chunk delivered again (a repeated message) holds the bytes already kept: it is skipped. Different bytes under an
    // index already taken would corrupt the file, so that fails.
    if (chunk.index < next) {
      const at = chunk.index * reply.chunkBytes;
      const same = at + chunk.bytes.byteLength <= received && chunk.bytes.every((b, i) => out[at + i] === b);
      return same ? { status: "more", received } : fail(`chunk ${chunk.index} arrived twice with different bytes`);
    }
    if (chunk.index > next) return fail(`chunk ${next} is missing (got ${chunk.index})`);
    const n = chunk.bytes.byteLength;
    const last = chunk.index === reply.chunks - 1;
    if (received + n > reply.bytes) return fail(`more bytes than the ${reply.bytes} the upload promised`);
    if (!last && n !== reply.chunkBytes) return fail(`chunk ${chunk.index} holds ${n} bytes, expected ${reply.chunkBytes}`);
    out.set(chunk.bytes, received);
    received += n;
    next++;
    if (!last) return { status: "more", received };
    if (received !== reply.bytes) return fail(`the upload ended at ${received} of ${reply.bytes} bytes`);
    done = true;
    return { status: "done", bytes: out };
  };
}

/** Joins capture pieces of one part (the head, or a segment) back together; null until a part's last piece arrives. */
class Pieces {
  private part = -1;
  private type = -1;
  private count = 0;
  private chunks: Uint8Array[] = [];

  /** The whole part once its last piece is in, null while more are due; throws on a piece out of order. */
  push(type: number, payload: Uint8Array): { part: number; bytes: Uint8Array } | null {
    const piece = decodeCapturePiece(payload);
    if ("refused" in piece) throw new Error(piece.refused);
    if (piece.index === 0) {
      if (this.chunks.length > 0) throw new Error(`part ${this.part} ended after ${this.chunks.length} of ${this.count} pieces`);
      this.part = piece.part;
      this.type = type;
      this.count = piece.count;
    } else if (piece.part !== this.part || type !== this.type || piece.count !== this.count || piece.index !== this.chunks.length) {
      throw new Error(`piece ${piece.index} of part ${piece.part} arrived out of order`);
    }
    this.chunks.push(piece.bytes.slice());
    if (this.chunks.length < this.count) return null;
    const bytes = new Uint8Array(this.chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of this.chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    this.chunks = [];
    return { part: this.part, bytes };
  }
}

/** The audio link client of `peer`. Cheap: it holds nothing until an operation or a follow runs. */
export function audioLinkClient(peer: AudioLinkPeer): AudioLinkClient {
  /** Why the link closed (`linkClosed`); null while it is open. */
  let gone: string | null = null;
  /** What `linkClosed` cuts: running requests, uploads and follows. */
  const cuts = new Set<(reason: string) => void>();

  const closedError = (): AudioLinkError | null => {
    if (gone !== null) return new AudioLinkError("closed", gone);
    if (peer.state === "closed") return new AudioLinkError("closed", `The build is gone (${peer.closedReason || "the link closed"}).`);
    return null;
  };

  const ask = (method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const closed = closedError();
    if (closed) return Promise.reject(closed);
    if (signal?.aborted) return Promise.reject(new AudioLinkError("aborted", abortReason(signal)));
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cuts.delete(cut);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const cut = (reason: string): void => settle(() => reject(new AudioLinkError("closed", reason)));
      const onAbort = (): void => settle(() => reject(new AudioLinkError("aborted", abortReason(signal!))));
      cuts.add(cut);
      signal?.addEventListener("abort", onAbort, { once: true });
      peer.request(AUDIO_TOPIC, method, params).then(
        (value) => settle(() => resolve(value)),
        (e: unknown) => settle(() => reject(new AudioLinkError(peer.state === "closed" ? "closed" : "refused", messageOf(e)))),
      );
    });
  };

  /** The upload `reply` names, reassembled. */
  const receive = (reply: TakeUploadReply, options: UploadOptions): Promise<Uint8Array> => {
    const { signal, onProgress } = options;
    return new Promise<Uint8Array>((resolve, reject) => {
      const push = uploadReceiver(reply);
      let settled = false;
      let sub: { unsubscribe(): void } | null = null;
      const finish = (error: AudioLinkError | null, bytes?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        cuts.delete(cut);
        signal?.removeEventListener("abort", onAbort);
        sub?.unsubscribe();
        if (error === null) resolve(bytes!);
        else reject(error);
      };
      const cut = (reason: string): void => finish(new AudioLinkError("closed", reason));
      const onAbort = (): void => finish(new AudioLinkError("aborted", abortReason(signal!)));
      const closed = closedError();
      if (closed) return finish(closed);
      if (signal?.aborted) return onAbort();
      cuts.add(cut);
      signal?.addEventListener("abort", onAbort, { once: true });
      onProgress?.({ received: 0, chunks: reply.chunks, bytes: 0, total: reply.bytes });
      const params: AudioSubscriptionParams = { kind: "upload", upload: reply.upload };
      sub = peer.subscribe(
        AUDIO_TOPIC,
        params,
        (records) => {
          for (const r of records) {
            if (settled) return;
            if (r.type !== AudioLinkRecord.takeChunk) continue;
            const chunk = decodeTakeChunk(r.payload);
            if ("refused" in chunk) return finish(new AudioLinkError("broken", chunk.refused));
            const step = push(chunk);
            if (step.status === "error") return finish(new AudioLinkError("broken", step.error));
            if (step.status === "done") return finish(null, step.bytes);
            // A chunk delivered again is skipped, not counted.
            onProgress?.({ received: Math.ceil(step.received / reply.chunkBytes), chunks: reply.chunks, bytes: step.received, total: reply.bytes });
          }
        },
        (message) => finish(new AudioLinkError(peer.state === "closed" ? "closed" : "refused", message)),
      );
      if (settled) sub.unsubscribe();
    });
  };

  const upload = async (method: string, params: unknown, options: UploadOptions = {}): Promise<Uint8Array> =>
    receive(readUploadReply(await ask(method, params, options.signal), method), options);

  /** A subscription that `linkClosed` ends with its reason; answers the stop. */
  const follow = (params: AudioSubscriptionParams, onSample: (records: readonly LinkRecord[]) => void, ended: (reason: string, kind: "refused" | "closed") => void): (() => void) => {
    const closed = closedError();
    if (closed) {
      ended(closed.reason, "closed");
      return () => {};
    }
    let over = false;
    const stop = (): void => {
      if (over) return;
      over = true;
      cuts.delete(cut);
      sub.unsubscribe();
    };
    const cut = (reason: string): void => {
      if (over) return;
      stop();
      ended(reason, "closed");
    };
    cuts.add(cut);
    const sub = peer.subscribe(
      AUDIO_TOPIC,
      params,
      (records) => {
        if (!over) onSample(records);
      },
      (message) => {
        if (over) return;
        over = true;
        cuts.delete(cut);
        ended(message, peer.state === "closed" ? "closed" : "refused");
      },
    );
    return stop;
  };

  return {
    start: async () => readStateReply(await ask(AudioRequest.start), AudioRequest.start),
    stop: async () => readStateReply(await ask(AudioRequest.stop), AudioRequest.stop),
    mark: async (text) => {
      const params: TakeMarkParams = { text };
      return readStateReply(await ask(AudioRequest.mark, params), AudioRequest.mark);
    },
    frames: async (width) => {
      const params: TakeFramesParams = { width };
      const reply = (await ask(AudioRequest.frames, params)) as { width?: unknown } | null;
      if (typeof reply?.width !== "number") throw new AudioLinkError("broken", `${AudioRequest.frames}'s reply isn't a width`);
      return reply.width;
    },
    uploadTake: (options) => upload(AudioRequest.upload, {}, options),
    buildAudio: async (options) => {
      const bytes = await upload(AudioRequest.buildAudio, undefined, options);
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as BuildAudioIndex;
      } catch (e) {
        throw new AudioLinkError("broken", `the build's audio index doesn't read: ${messageOf(e)}`);
      }
    },
    buildFile: (file, options) => {
      const params: BuildFileParams = { kind: file.kind, path: file.path };
      return upload(AudioRequest.buildFile, params, options);
    },
    mixOp: (op) => (gone === null ? peer.command(AUDIO_TOPIC, MIX_OP_COMMAND, mixOpCommand(op)) : false),

    followTakeState(on, ended) {
      return follow(
        { kind: "take" },
        (records) => {
          for (const r of records) {
            if (r.type !== AudioLinkRecord.takeState) continue;
            const t = decodeTakeState(r.payload);
            if (!("refused" in t)) on(t);
          }
        },
        (reason) => ended?.(reason),
      );
    },

    followLiveTake(on, options = {}) {
      const publishMs = options.publishMs ?? LIVE_TAKE_PUBLISH_MS;
      const stream = new TakeLiveStream();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let last = -Infinity;
      let stopped = false;
      let state = stream.state;
      let feedError: string | null = null;
      const publish = (): void => {
        timer = null;
        if (stopped) return;
        last = Date.now();
        const take = stream.take();
        const facts = stream.facts;
        if (!take || !facts) return on(null);
        on({
          state: stream.state === "stopped" ? "stopped" : "recording", take, id: facts.take, pictures: facts.pictures, pictureWidth: facts.pictureWidth,
          message: feedError ?? stream.error ?? stream.stopMessage,
        });
      };
      const schedule = (now: boolean): void => {
        if (stopped) return;
        const wait = publishMs - (Date.now() - last);
        if (now || wait <= 0) {
          if (timer !== null) clearTimeout(timer);
          publish();
        } else if (timer === null) {
          timer = setTimeout(publish, wait);
        }
      };
      const stop = follow(
        { kind: "takeLive" },
        (records) => {
          let changed = false;
          for (const r of records) changed = stream.push(r) || changed;
          if (!changed) return;
          // A take starting or stopping shows at once; its growth a few times a second.
          const was = state;
          state = stream.state;
          schedule(state !== was);
        },
        (reason) => {
          // An older build without the feed, or the link closed: what was handed out stays, with why it stopped.
          feedError = reason;
          if (stream.facts) schedule(true);
        },
      );
      return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        stop();
      };
    },

    followCapture(follower) {
      const pieces = new Pieces();
      let head = false;
      let over = false;
      let stop: (() => void) | null = null;
      const end = (e: CaptureFollowEnd): void => {
        if (over) return;
        over = true;
        stop?.();
        follower.ended(e);
      };
      stop = follow(
        { kind: "capture" },
        (records) => {
          for (const r of records) {
            if (over) return;
            if (r.type === AudioLinkRecord.captureLost) return end({ kind: "lost", reason: "the build's capture ring dropped a segment before it was sent" });
            if (r.type !== AudioLinkRecord.captureHead && r.type !== AudioLinkRecord.captureSegment) continue;
            let whole: { part: number; bytes: Uint8Array } | null;
            try {
              whole = pieces.push(r.type, r.payload);
            } catch (e) {
              return end({ kind: "broken", reason: messageOf(e) });
            }
            if (!whole) continue;
            if (r.type === AudioLinkRecord.captureHead) {
              if (head) return end({ kind: "broken", reason: "it sent a second head" });
              head = true;
              follower.head(whole.bytes);
            } else if (!head) return end({ kind: "broken", reason: "it sent a segment before its head" });
            else follower.segment(whole.part, whole.bytes);
          }
        },
        (reason, kind) => end({ kind, reason }),
      );
      return () => {
        over = true;
        stop?.();
      };
    },

    linkClosed(reason) {
      if (gone !== null) return;
      gone = reason;
      for (const cut of [...cuts]) cut(reason);
      cuts.clear();
    },
  };
}
