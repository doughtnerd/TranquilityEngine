// Whole-clip decode (K7, `clips.ts` half): encoded bytes in, interleaved int16 PCM out in chunks of
// `CLIP_CHUNK_FRAMES` frames, so a long clip is never one huge message and the worker's memory holds one chunk of
// PCM at a time (the encoded file lives in the module until the decode ends). Between chunks the worker yields to its
// event loop, which is how a `cancel` gets through. int16 is the core's clip format (CLIP_BEGIN `format` 1).
import { CLIP_CHUNK_FRAMES, type ClipInfo, type DecodeHint } from "./protocol";
import { DecoderError, type DecoderWasm, type RawInfo } from "./wasm";

export interface ClipDecodeOptions {
  /** Called once, before the first chunk, with what the container declares (`frames` -1 when unknown; B5 sizes CLIP_BEGIN from it). */
  readonly onInfo?: (info: ClipInfo) => void;
  /** Called with each chunk, in order; the array is a copy the callee owns (its buffer is transferable). */
  readonly onChunk: (index: number, pcm: Int16Array) => void;
  /** Checked after each chunk; true stops the decode (the result is `null`). */
  readonly cancelled?: () => boolean;
  /** Awaited after each chunk; the worker passes a task-queue yield so messages (cancel) are seen. Default: none. */
  readonly yieldToEvents?: () => Promise<void>;
}

/** The ClipInfo loop fields, present only when the file states a loop. */
function loopFields(raw: RawInfo): Pick<ClipInfo, "loopStartFrame" | "loopEndFrame"> {
  return raw.loopStartFrame !== undefined && raw.loopEndFrame !== undefined ? { loopStartFrame: raw.loopStartFrame, loopEndFrame: raw.loopEndFrame } : {};
}

/**
 * Decodes `bytes` completely. Returns the info (`frames` = frames actually decoded) or `null` when cancelled.
 * Throws `DecoderError` on a format error, a decode error, or a file shorter than its container stated.
 */
export async function decodeClip(wasm: DecoderWasm, bytes: Uint8Array, hint: DecodeHint, options: ClipDecodeOptions): Promise<ClipInfo | null> {
  const handle = wasm.open(bytes, hint);
  let scratch = 0;
  let scratchBytes = 0;
  try {
    const raw = wasm.info(handle);
    if (raw.channels < 1 || raw.rate < 1) throw new DecoderError("audio decoder: the file reports no channels or rate");
    // A known length smaller than a chunk needs no bigger scratch.
    const chunkFrames = raw.frames >= 0 && raw.frames < CLIP_CHUNK_FRAMES ? Math.max(1, raw.frames) : CLIP_CHUNK_FRAMES;
    options.onInfo?.({ rate: raw.rate, channels: raw.channels, frames: raw.frames, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact, ...loopFields(raw) });
    scratchBytes = chunkFrames * raw.channels * 2;
    scratch = wasm.alloc(scratchBytes);
    let total = 0;
    for (let index = 0; ; index++) {
      const n = wasm.readI16(handle, scratch, chunkFrames);
      if (n === 0) break;
      options.onChunk(index, wasm.i16(scratch, n * raw.channels).slice());
      total += n;
      if (options.cancelled?.()) return null;
      if (options.yieldToEvents) {
        await options.yieldToEvents();
        if (options.cancelled?.()) return null;
      }
    }
    if (raw.exact && total < raw.frames) throw new DecoderError(`audio decoder: the file ended after ${total} of ${raw.frames} frames (truncated?)`);
    if (total === 0) throw new DecoderError("audio decoder: the file holds no audio");
    return { rate: raw.rate, channels: raw.channels, frames: total, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact, ...loopFields(raw) };
  } finally {
    wasm.close(handle);
    if (scratch !== 0) wasm.free(scratch, scratchBytes);
  }
}
