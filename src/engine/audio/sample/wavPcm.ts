/**
 * A WAV file's audio as interleaved float PCM, without a decoder module: integer PCM of 8, 16, 24 or 32 bits and IEEE
 * float of 32 or 64 bits, plain or `WAVE_FORMAT_EXTENSIBLE`. The export renders baked samples with it in Node, where the
 * page's decoder worker doesn't run (ADR 0342 "`npm run export` renders and ships the result").
 *
 * Total: anything it can't read (not a WAV, a compressed format, a truncated header) gives null; a data chunk that runs
 * past the end of the file is read as far as it goes.
 *
 * Pure; no plugin, no DOM.
 */
import type { SamplePcm } from "./sampleRender";
import { u16At, u32At, walkWavChunks } from "./wavChunks";

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/** The audio of `bytes`, or null when it isn't a WAV this reads. */
export function decodeWavPcm(bytes: Uint8Array): (SamplePcm & { pcm: Float32Array }) | null {
  const walk = walkWavChunks(bytes);
  if (!walk) return null;
  const fmt = walk.chunks.find((c) => c.id === "fmt ");
  if (!fmt || fmt.body.length < 16) return null;
  let tag = u16At(fmt.body, 0);
  const channels = u16At(fmt.body, 2);
  const rate = u32At(fmt.body, 4);
  const blockAlign = u16At(fmt.body, 12);
  const bits = u16At(fmt.body, 14);
  if (tag === EXTENSIBLE && fmt.body.length >= 26) tag = u16At(fmt.body, 24); // the sub-format GUID's first two bytes
  if (channels < 1 || rate < 1 || blockAlign < 1) return null;
  const bytesPer = bits / 8;
  if (!Number.isInteger(bytesPer) || bytesPer * channels > blockAlign) return null;
  if (tag === PCM ? ![1, 2, 3, 4].includes(bytesPer) : tag === FLOAT ? ![4, 8].includes(bytesPer) : true) return null;

  let data = walk.chunks.find((c) => c.id === "data")?.body;
  if (!data && walk.overrun?.id === "data") data = bytes.subarray(walk.overrun.offset + 8);
  if (!data) return null;
  const frames = Math.floor(data.length / blockAlign);
  const out = new Float32Array(frames * channels);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const at = f * blockAlign + c * bytesPer;
      let v: number;
      if (tag === FLOAT) v = bytesPer === 4 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      else if (bytesPer === 1) v = (view.getUint8(at) - 128) / 128;
      else if (bytesPer === 2) v = view.getInt16(at, true) / 32768;
      else if (bytesPer === 3) v = ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16))) / 8388608;
      else v = view.getInt32(at, true) / 2147483648;
      out[f * channels + c] = v;
    }
  }
  return { pcm: out, channels, rate };
}
