// The decoder worker's message protocol (ADR 0157; architecture sections 1 and 3; contract K7). Every message is a
// plain object with a `type`; PCM and encoded bytes travel as transferred ArrayBuffers. The worker routes `decodeClip`
// and `cancel` to `clips.ts` and every `stream*` message to `streams.ts`; B3 fills `streams.ts` without touching
// the clip path, and B5 calls `decodeClip` through `decoderClient.ts`.

/** The container hint of the decoder ABI (`myco_decode_open`'s `hint`): 0 probe alone, 1 wav, 2 flac, 3 mp3, 4 ogg, 5 mp4/m4a, 6 aac (ADTS). */
export type DecodeHint = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** What a decoder reports about a file, from the wasm's 32-byte info record. */
export interface ClipInfo {
  readonly rate: number;
  readonly channels: number;
  /** Frames actually decoded (clip replies) or declared by the container (stream replies; -1 when unknown, an MP3 without a length header). */
  readonly frames: number;
  /** The container's estimate (exact when `lengthKnown`), -1 when none. */
  readonly framesEstimate: number;
  /** 0 other, 1 PCM, 2 FLAC, 3 MP3, 4 Vorbis, 5 AAC. */
  readonly codec: number;
  /** Whether the container stated the length exactly. */
  readonly lengthKnown: boolean;
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

export type StreamRequest = StreamOpenMessage | StreamCreditMessage | StreamSeekMessage | StreamCloseMessage;
export type DecoderRequest = InitMessage | DecodeClipMessage | CancelMessage | StreamRequest;

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

export type DecoderReply = ReadyMessage | ClipInfoMessage | ClipChunkMessage | ClipDoneMessage | CancelledMessage | StreamOpenedMessage | StreamChunkMessage | StreamClosedMessage | ErrorMessage;

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
