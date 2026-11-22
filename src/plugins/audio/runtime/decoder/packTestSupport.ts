// Test support for ADR 0337 A4 (packages and IMA ADPCM): a reference IMA ADPCM encoder in the engine's block layout (the
// shipped one is `audio-encode`'s, in Rust; this is the same public algorithm), the decoder fixtures the tests read, and a
// `.mycopak` built with the A1 writer. Imported only by tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeAudioPack, type PackInput } from "../../../../engine/audio/packaging/format";
import { ADPCM_BLOCK_FRAMES, ADPCM_CHANNEL_BYTES } from "../wire.generated";

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/** Encodes interleaved int16 (`channels` 1 or 2) into the engine's IMA ADPCM blocks (the greedy quantiser `audio-encode` uses). */
export function encodeAdpcm(pcm: Int16Array, channels: number): Uint8Array {
  const frames = pcm.length / channels;
  const blocks = Math.ceil(frames / ADPCM_BLOCK_FRAMES);
  const blockBytes = channels * ADPCM_CHANNEL_BYTES;
  const out = new Uint8Array(blocks * blockBytes);
  const index = new Array<number>(channels).fill(0);
  for (let b = 0; b < blocks; b++) {
    const at = b * blockBytes;
    for (let c = 0; c < channels; c++) {
      const first = pcm[b * ADPCM_BLOCK_FRAMES * channels + c]!;
      out[at + c * 4] = first & 0xff;
      out[at + c * 4 + 1] = (first >> 8) & 0xff;
      out[at + c * 4 + 2] = index[c]!;
      let predictor = first;
      let idx = index[c]!;
      for (let i = 0; i < ADPCM_BLOCK_FRAMES; i++) {
        const f = b * ADPCM_BLOCK_FRAMES + i;
        const s = f < frames ? pcm[f * channels + c]! : 0;
        const step = STEPS[idx]!;
        let diff = s - predictor;
        let code = 0;
        if (diff < 0) {
          code = 8;
          diff = -diff;
        }
        if (diff >= step) {
          code |= 4;
          diff -= step;
        }
        if (diff >= step >> 1) {
          code |= 2;
          diff -= step >> 1;
        }
        if (diff >= step >> 2) code |= 1;
        let d = step >> 3;
        if (code & 4) d += step;
        if (code & 2) d += step >> 1;
        if (code & 1) d += step >> 2;
        predictor = Math.max(-32768, Math.min(32767, code & 8 ? predictor - d : predictor + d));
        idx = Math.max(0, Math.min(88, idx + INDEX_ADJUST[code]!));
        const k = at + channels * 4 + c * 512 + (i >> 1);
        out[k] = out[k]! | (code << ((i & 1) * 4));
      }
      index[c] = idx;
    }
  }
  return out;
}

/** A fixture of `audio-decode`'s tests (`native/audio/crates/audio-decode/tests/fixtures/`), as an ArrayBuffer of its own. */
export function decoderFixture(name: string): ArrayBuffer {
  const bytes = readFileSync(fileURLToPath(new URL(`../../../../../native/audio/crates/audio-decode/tests/fixtures/${name}`, import.meta.url)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A `.mycopak` holding `inputs` (the A1 writer), as an ArrayBuffer of its own. */
export function makePack(inputs: readonly PackInput[]): ArrayBuffer {
  const bytes = writeAudioPack("Test", "web", inputs);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** SNR in dB of `got` against `want` over `[from, to)`. */
export function snrDb(want: ArrayLike<number>, got: ArrayLike<number>, from: number, to: number): number {
  let sig = 0;
  let err = 0;
  for (let i = from; i < to; i++) {
    sig += want[i]! * want[i]!;
    err += (want[i]! - got[i]!) ** 2;
  }
  return 10 * Math.log10(sig / Math.max(err, 1e-30));
}
