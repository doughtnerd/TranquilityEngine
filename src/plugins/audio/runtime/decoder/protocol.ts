// The decoder worker's message protocol (ADR 0157; architecture sections 1 and 3; contract K7). Every message is a
// plain object with a `type`; PCM and encoded bytes travel as transferred ArrayBuffers. The worker routes `decodeClip`
// and `cancel` to `clips.ts` and every `stream*` message to `streams.ts`; B3 fills `streams.ts` without touching
// the clip path, and B5 calls `decodeClip` through `decoderClient.ts`.
//
// B3: a stream's PCM never comes back here. `connectWorklet` hands the worker one end of a `MessageChannel` whose other
// end the host gave the worklet; STREAM_OPEN, STREAM_CHUNK and STREAM_CLOSE (wire kinds 5–7) go over it to the worklet,
// and STREAM_CREDIT (kind 11) comes back with the emptied chunk buffers (architecture §1: "Main is never on a stream's
// PCM path"). Main only opens, seeks and closes, and hears `streamOpened`, `streamClosed` and errors.

/** The container hint of the decoder ABI (`myco_decode_open`'s `hint`): 0 probe alone, 1 wav, 2 flac, 3 mp3, 4 ogg, 5 mp4/m4a, 6 aac (ADTS). */
export type DecodeHint = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * ADR 0162 §2.4 (contract K0): an ambisonic file's channel convention. "ambix" (ACN order, SN3D) is the engine's own;
 * "fuma" is converted in the decoder (B2's Rust, before int16 rounding). Absent: not ambisonic.
 */
export type AmbisonicConvention = "ambix" | "fuma";

/** What a decoder reports about a file, from the wasm's 32-byte info record. */
export interface ClipInfo {
  readonly rate: number;
  /** 1 or 2; ADR 0162 (K0): also 4, 9 or 16 for an ambisonic file (B2 lifts the decoder's limit). */
  readonly channels: number;
  /** Frames actually decoded (clip replies) or declared by the container (stream replies; -1 when unknown, an MP3 without a length header). */
  readonly frames: number;
  /** The container's estimate (exact when `lengthKnown`), -1 when none. */
  readonly framesEstimate: number;
  /** 0 other, 1 PCM, 2 FLAC, 3 MP3, 4 Vorbis, 5 AAC. */
  readonly codec: number;
  /** Whether the container stated the length exactly. */
  readonly lengthKnown: boolean;
  /**
   * ADR 0158 §4 (contract C2, filled by E4.1): the file's own loop region in frames, from a WAV `smpl` chunk or
   * Ogg/Opus `LOOPSTART`/`LOOPLENGTH` comments; `loopEndFrame` is exclusive. Absent when the file has none.
   */
  readonly loopStartFrame?: number;
  readonly loopEndFrame?: number;
  /**
   * ADR 0162 §2.4 (B2): set when the decoder converted a FuMa file to AmbiX. The converted samples are scaled down
   * into int16 headroom by this factor (√2 for orders 1-3), so main multiplies the clip's import volume by it. Absent
   * (meaning 1) for every other clip.
   */
  readonly importGain?: number;
}

// --- Main to worker ----------------------------------------------------------------------------

/** First message: where to fetch `myco_audio_decode.wasm` (absolute URL), or its bytes (tests, hosts that fetched it already). */
export interface InitMessage {
  readonly type: "init";
  readonly wasmUrl?: string;
  readonly wasmBytes?: ArrayBuffer;
}

/** Decode a whole clip. `bytes` is transferred. The worker answers with `clipChunk`s then one `clipDone`, or `error`. */
export interface DecodeClipMessage {
  readonly type: "decodeClip";
  readonly id: number;
  readonly asset?: string;
  readonly bytes: ArrayBuffer;
  readonly hint: DecodeHint;
  /** ADR 0162 §2.4 (K0; B1 sends it, B2's decoder applies it): the sidecar's convention, so FuMa is converted while decoding. */
  readonly convention?: AmbisonicConvention;
}

/** Stops the decode `id` (clip) at its next chunk boundary; it then answers `cancelled`. Unknown ids are ignored. */
export interface CancelMessage {
  readonly type: "cancel";
  readonly id: number;
}

/** B3: open a stream over `bytes` (transferred) and start at `startFrame`. `epoch` tags every chunk until the next seek. */
export interface StreamOpenMessage {
  readonly type: "streamOpen";
  readonly streamId: number;
  readonly asset: string;
  readonly bytes: ArrayBuffer;
  readonly hint: DecodeHint;
  readonly startFrame: number;
  readonly epoch: number;
  /** B3 (added): wrap to the start at the end, so the worklet's ring sees one continuous signal (B4 trims the seam). */
  readonly loop?: boolean;
  /** ADR 0158 §4 (contract C2, filled by E4.4): with `loop`, wrap from `loopEndFrame` (exclusive; 0 = the end) back to `loopStartFrame`. */
  readonly loopStartFrame?: number;
  readonly loopEndFrame?: number;
  /**
   * ADR 0162 §2.4 (K0; filled by B4): the sidecar's convention, so FuMa is converted per chunk. With it, a stream may have
   * 4, 9 or 16 channels (the wire's STREAM_OPEN `channels` 1–16 and `convention`).
   */
  readonly convention?: AmbisonicConvention;
}

/**
 * ADR 0158 §4 (contract C2, filled by E4.4): change a stream's loop. `looping: false` is a release: finish the current
 * pass and play on to the end. With `looping: true`, `loopStartFrame`/`loopEndFrame` set the region (0/0 = whole file).
 */
export interface StreamLoopMessage {
  readonly type: "streamLoop";
  readonly streamId: number;
  readonly looping: boolean;
  readonly loopStartFrame?: number;
  readonly loopEndFrame?: number;
  /**
   * E4.4: the stream frame the change lands on (the end of the voice's current pass, predicted on main from its playhead).
   * The worker stops wrapping (or changes region) there, or splices a new epoch from it if it already sent past it.
   * Absent: at the next seam the worker reaches.
   */
  readonly atStreamFrame?: number;
}

/** B3: the ring buffer has room for `frames` more frames (credit-based flow control). */
export interface StreamCreditMessage {
  readonly type: "streamCredit";
  readonly streamId: number;
  readonly frames: number;
}

/** B3: sample-accurate seek; chunks of the old epoch still in flight are dropped by the consumer. */
export interface StreamSeekMessage {
  readonly type: "streamSeek";
  readonly streamId: number;
  readonly frame: number;
  readonly epoch: number;
}

export interface StreamCloseMessage {
  readonly type: "streamClose";
  readonly streamId: number;
}

/** What a stream port needs: a `MessagePort`, or an in-process stand-in in tests. */
export interface StreamPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * B3 (added): the worker's end of the channel to the worklet (`port` transferred). A later one replaces it (a hard
 * rebuild made a new worklet); streams opened on the old one are closed by main.
 */
export interface ConnectWorkletMessage {
  readonly type: "connectWorklet";
  readonly port: StreamPortLike;
}

// --- ADR 0162 zone impulse responses (contract K0, C9; filled by C2b in `irPrepare.ts`) ---------------------------

/**
 * Prepare a zone kernel from an IR asset. The worker fetches and keeps the encoded bytes (for re-preparation on a rate
 * change or rebuild), prepares the kernel with `myco_ir_prepare`, sends it to the worklet as CLIP_BEGIN/CLIP_CHUNK format 3
 * over the worklet port, then posts `irPrepared` or `irFailed` to main. Main never holds the kernel.
 */
export interface PrepareIrMessage {
  readonly type: "prepareIr";
  readonly token: number;
  readonly kernelId: number;
  readonly assetUrl: string;
  readonly contextRate: number;
  readonly maxFrames: number;
}

/** As `prepareIr`, from a built-in preset (R10: "room", "corridor", "hall", "cave", "open") generated with `myco_ir_generate`. */
export interface GenerateIrMessage {
  readonly type: "generateIr";
  readonly token: number;
  readonly kernelId: number;
  readonly preset: string;
  readonly contextRate: number;
  readonly maxFrames: number;
}

/** Drop kernel `kernelId`'s kept bytes. Unknown ids are ignored. */
export interface ReleaseIrMessage {
  readonly type: "releaseIr";
  readonly kernelId: number;
}

export type IrRequest = PrepareIrMessage | GenerateIrMessage | ReleaseIrMessage;

// --- ADR 0166 interactive music (contract Q0; api-and-models §4.6, C8; D1a/D1b/D1c fill the worker side) -----------

/**
 * One stem of a `primeGroup`. The worker opens it as a stream on the music pool (STREAM_OPEN `music` flag, §4.3) under
 * `epoch`, starting at `startFrame` (file frames).
 *
 * **Encoded bytes and the cache miss rule (Q0):** main sends `bytes` (transferred) when it doesn't know the worker holds
 * this path for this instance. A member without `bytes` whose path the worker doesn't hold (never sent, or evicted) is
 * not opened: the worker answers `needBytes` for it, and main resends a `primeGroup` with `retarget: false` carrying
 * only those members, with `bytes`. The worker never fetches.
 */
export interface PrimeGroupMember {
  readonly streamId: number;
  readonly epoch: number;
  readonly asset: string;
  readonly bytes?: ArrayBuffer;
  readonly hint: DecodeHint;
  readonly startFrame: number;
  readonly loop: boolean;
  /** With `loop`: the region in file frames (`loopEndFrame` exclusive; 0 = the end). */
  readonly loopStartFrame?: number;
  readonly loopEndFrame?: number;
  /** Always true here: the ring comes from the music pool. */
  readonly music: true;
  readonly convention?: AmbisonicConvention;
}

/**
 * Prime a music group (§4.6, C8): every member's STREAM_OPEN and first chunk go to the worklet before any member's
 * second chunk, then top-ups go round-robin. With `retarget`, members already open restart at their new `startFrame`
 * under their new `epoch`, in the same breadth-first order. `protect` (optional) replaces the instance's protected
 * paths for the encoded cache (playing, primed, candidate successors).
 */
export interface PrimeGroupMessage {
  readonly type: "primeGroup";
  readonly instance: number;
  readonly group: number;
  readonly retarget: boolean;
  readonly members: readonly PrimeGroupMember[];
  readonly protect?: readonly string[];
}

/** Cancel a group: close every member stream it opened (each answers `streamClosed`). Unknown ids are ignored. */
export interface CancelGroupMessage {
  readonly type: "cancelGroup";
  readonly group: number;
}

/** Replace a music instance's protected paths (C8: on each planner change of candidates). */
export interface ProtectMusicMessage {
  readonly type: "protectMusic";
  readonly instance: number;
  readonly paths: readonly string[];
}

/** The music instance ended: drop its refcounts on the encoded cache (R16). Unknown ids are ignored. */
export interface ReleaseMusicMessage {
  readonly type: "releaseMusic";
  readonly instance: number;
}

export type MusicRequest = PrimeGroupMessage | CancelGroupMessage | ProtectMusicMessage | ReleaseMusicMessage;

/**
 * Editor waveform peaks (Ed1; api-and-models §7): decode `bytes` (transferred) and reduce it to one min/max pair per
 * `binFrames` frames per channel, the base level the editor's mip levels are built from (`editor/music/peaksMip.ts`).
 * Answered with `peaks`, or `error` with this `id`. Cancelled with `cancel` like a clip decode.
 */
export interface ComputePeaksMessage {
  readonly type: "computePeaks";
  readonly id: number;
  readonly asset?: string;
  readonly bytes: ArrayBuffer;
  readonly hint: DecodeHint;
  /** Frames per bin, >= 1 (the editor asks 256). */
  readonly binFrames: number;
}

export type StreamRequest = StreamOpenMessage | StreamCreditMessage | StreamSeekMessage | StreamCloseMessage | StreamLoopMessage | ConnectWorkletMessage;
export type DecoderRequest = InitMessage | DecodeClipMessage | CancelMessage | StreamRequest | IrRequest | MusicRequest | ComputePeaksMessage;

// --- Worker to main ----------------------------------------------------------------------------

/** The wasm loaded and passed its checks; requests sent before it are queued, so waiting for it is optional. */
export interface ReadyMessage {
  readonly type: "ready";
  readonly abiVersion: number;
}

/**
 * B5: sent once per clip decode before its first chunk: what the file says about itself. `frames` is the container's
 * length (-1 when unknown, an MP3 without a length header) and `lengthKnown` says whether it is exact, so a caller can
 * size CLIP_BEGIN and start uploading while the rest decodes.
 */
export interface ClipInfoMessage {
  readonly type: "clipInfo";
  readonly id: number;
  readonly info: ClipInfo;
}

/** A piece of a clip, interleaved int16 (`pcm` transferred), `index` counting from 0. All chunks but the last hold `CLIP_CHUNK_FRAMES` frames. */
export interface ClipChunkMessage {
  readonly type: "clipChunk";
  readonly id: number;
  readonly index: number;
  readonly pcm: ArrayBuffer;
}

/** The clip is complete; `info.frames` is the total decoded. */
export interface ClipDoneMessage {
  readonly type: "clipDone";
  readonly id: number;
  readonly info: ClipInfo;
}

export interface CancelledMessage {
  readonly type: "cancelled";
  readonly id: number;
}

/** B3: the stream is open (answer to `streamOpen`). */
export interface StreamOpenedMessage {
  readonly type: "streamOpened";
  readonly streamId: number;
  readonly epoch: number;
  readonly info: ClipInfo;
}

/** B3: decoded frames of `epoch` starting at `startFrame`; `ended` marks the last chunk before the end of the file. */
export interface StreamChunkMessage {
  readonly type: "streamChunk";
  readonly streamId: number;
  readonly epoch: number;
  readonly startFrame: number;
  readonly format: "i16" | "f32";
  readonly pcm: ArrayBuffer;
  readonly ended: boolean;
}

export interface StreamClosedMessage {
  readonly type: "streamClosed";
  readonly streamId: number;
}

/**
 * A failure (architecture section 3): `id` names the clip decode it fails, `streamId` and `asset` the stream.
 * Neither means the worker itself is unusable (the wasm didn't load or didn't match), and `fatal` is true.
 */
export interface ErrorMessage {
  readonly type: "error";
  readonly id?: number;
  readonly streamId?: number;
  readonly asset?: string;
  readonly message: string;
  /** The decoder's negative `ERR_*` code, when the failure came from it. */
  readonly code?: number;
  readonly fatal?: boolean;
}

/** ADR 0162 C9 (K0): kernel `kernelId` reached the worklet. `truncated`: the IR was cut to `maxFrames` with a 50 ms fade. */
export interface IrPreparedMessage {
  readonly type: "irPrepared";
  readonly token: number;
  readonly kernelId: number;
  readonly frames: number;
  readonly truncated: boolean;
  readonly prepareMs: number;
}

/** ADR 0162 C9 (K0): preparing failed; the zone reads "IR failed: <message>". `code` is the decoder's `ERR_*`, or 0. */
export interface IrFailedMessage {
  readonly type: "irFailed";
  readonly token: number;
  readonly kernelId: number;
  readonly code: number;
  readonly message: string;
}

/**
 * ADR 0166 §4.6 (Q0): a group's members were opened (or failed). **Diagnostics only**, never the primed signal: that is
 * the core's STATUS `musicRings` primed bit for the current epoch (R7). `openMs` is from the message's arrival to the
 * member's first chunk posted.
 */
export interface GroupOpenedMessage {
  readonly type: "groupOpened";
  readonly group: number;
  readonly members: readonly { readonly streamId: number; readonly openMs: number; readonly error?: string }[];
}

/** ADR 0166 (Q0's miss rule): these members of `group` came without `bytes` and the worker doesn't hold their paths. */
export interface NeedBytesMessage {
  readonly type: "needBytes";
  readonly group: number;
  readonly members: readonly { readonly streamId: number; readonly asset: string }[];
}

/**
 * Ed1 (Q0): the base peaks level of a `computePeaks`. `peaks` (transferred) is int16 pairs `[min, max]` per bin,
 * channel-major (every bin of channel 0, then channel 1, ...): `channels × bins × 2` values. `bins` is
 * `ceil(frames / binFrames)`.
 */
export interface PeaksMessage {
  readonly type: "peaks";
  readonly id: number;
  readonly rate: number;
  readonly channels: number;
  readonly frames: number;
  readonly binFrames: number;
  readonly bins: number;
  readonly peaks: ArrayBuffer;
}

export type MusicReply = GroupOpenedMessage | NeedBytesMessage;

export type DecoderReply = ReadyMessage | ClipInfoMessage | ClipChunkMessage | ClipDoneMessage | CancelledMessage | StreamOpenedMessage | StreamChunkMessage | StreamClosedMessage | ErrorMessage | IrPreparedMessage | IrFailedMessage | MusicReply | PeaksMessage;

/** Frames per `clipChunk`: 65,536 (1.5 s at 44.1 kHz), 128 KiB per channel, so a long clip is never one huge message. */
export const CLIP_CHUNK_FRAMES = 65536;

/** The hint for a file extension (case-insensitive) or file name; 0 when unknown. */
export function hintFromName(name: string): DecodeHint {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "wav":
    case "wave":
      return 1;
    case "flac":
      return 2;
    case "mp3":
      return 3;
    case "ogg":
    case "oga":
      return 4;
    case "m4a":
    case "mp4":
      return 5;
    case "aac":
      return 6;
    default:
      return 0;
  }
}
