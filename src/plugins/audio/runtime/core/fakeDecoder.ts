// Test support: a stand-in for the decoder worker's client that "decodes" to planar f32 a test supplies, so registry and
// backend tests need no wasm. It answers like the worker does: interleaved int16 at the clip's own rate, one chunk.
import type { DecodeClipOptions, DecodedClip, DecoderClient } from "../decoder/decoderClient";

/** What a fake decode produces: planar f32, one array per channel, each `frames` long. */
export interface PlanarClip {
  readonly frames: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly channelData: readonly Float32Array[];
}

/** f32 to int16 as the wire scales it: clamp to [-1, 1], `s < 0 ? s * 32768 : s * 32767`, round half away from zero, NaN to 0. */
export function interleaveI16(channels: readonly Float32Array[], start: number, frames: number, dst: Int16Array): void {
  const n = channels.length;
  for (let c = 0; c < n; c++) {
    const src = channels[c]!;
    for (let f = 0, d = c; f < frames; f++, d += n) {
      const v = src[start + f]!;
      if (Number.isNaN(v)) {
        dst[d] = 0;
        continue;
      }
      const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
      const s = clamped < 0 ? clamped * 32768 : clamped * 32767;
      dst[d] = Math.sign(s) * Math.round(Math.abs(s));
    }
  }
}

/**
 * A decoder client whose `decodeClip` calls `decode` with a copy of the encoded bytes and delivers the planar result as
 * the worker would (`onInfo` with the length known, one `onChunk`). `decode` may throw or reject to fail the clip.
 */
export function fakeDecoder(decode: (encoded: ArrayBuffer) => PlanarClip | Promise<PlanarClip>): Pick<DecoderClient, "decodeClip"> {
  return {
    async decodeClip(bytes: ArrayBuffer | Uint8Array, _hint?: number, options?: DecodeClipOptions): Promise<DecodedClip> {
      const copy = bytes instanceof ArrayBuffer ? bytes.slice(0) : (bytes.slice().buffer as ArrayBuffer);
      const clip = await decode(copy);
      const pcm = new Int16Array(clip.frames * clip.channels);
      interleaveI16(clip.channelData, 0, clip.frames, pcm);
      const info = { rate: clip.sampleRate, channels: clip.channels, frames: clip.frames, framesEstimate: clip.frames, codec: 1, lengthKnown: true };
      options?.onInfo?.(info);
      if (pcm.length > 0) options?.onChunk?.(pcm, 0);
      return { pcm: options?.collect === false ? new Int16Array(0) : pcm, rate: clip.sampleRate, channels: clip.channels, frames: clip.frames, info };
    },
  };
}
