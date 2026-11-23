/**
 * Internal (ADR 0351 §5): decoding a build's audio sources to PCM for the encoder. WAV is read in TypeScript
 * (`decodeWavPcm`, every PCM and float layout); every other format the game decodes (FLAC, MP3, Ogg Vorbis, AAC in the AAC
 * build) goes through the game's own decoder, `myco_audio_decode.wasm` (`DecoderWasm`), compiled once and given to this
 * module by the caller (Node reads the file, the editor fetches it), so conversion reads exactly what the game would.
 */
import { decodeWavPcm } from "../engine/audio/sample/wavPcm";
import { DecoderWasm } from "../plugins/audio/runtime/decoder/wasm";
import { hintFromName } from "../plugins/audio/runtime/decoder/protocol";
import type { DecodeAudio, DecodedAudio } from "./audio";

/** The decoder module's URL (beside the audio runtime), for the caller to read or fetch. */
export const DECODER_WASM_URL = new URL("../plugins/audio/runtime/wasm/myco_audio_decode.wasm", import.meta.url);

/** Frames read per call. */
const BLOCK = 8192;

/** Decodes with `wasm` (one instance; calls run one at a time). */
function decodeWith(wasm: DecoderWasm, bytes: Uint8Array, path: string): DecodedAudio {
  const handle = wasm.open(bytes, hintFromName(path));
  try {
    const info = wasm.info(handle);
    const channels = info.channels;
    const scratch = wasm.alloc(BLOCK * channels * 4);
    const parts: Float32Array[] = [];
    let total = 0;
    try {
      for (let n = wasm.readF32(handle, scratch, BLOCK); n > 0; n = wasm.readF32(handle, scratch, BLOCK)) {
        parts.push(wasm.f32(scratch, n * channels).slice());
        total += n * channels;
      }
    } finally {
      wasm.free(scratch, BLOCK * channels * 4);
    }
    const pcm = new Float32Array(total);
    let at = 0;
    for (const p of parts) (pcm.set(p, at), (at += p.length));
    return { pcm, channels, sampleRate: info.rate };
  } finally {
    wasm.close(handle);
  }
}

/**
 * A `DecodeAudio` over the decoder module `wasm` gives (its bytes or compiled module; asked for on the first non-WAV
 * file only). A trap resets the instance, so one bad file doesn't take the next with it.
 */
export function createAudioDecoder(wasm: () => Promise<BufferSource | WebAssembly.Module>): DecodeAudio {
  let instance: Promise<DecoderWasm> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  return async (bytes, path) => {
    const wav = decodeWavPcm(bytes);
    if (wav) return { pcm: wav.pcm, channels: wav.channels, sampleRate: wav.rate };
    instance ??= wasm().then((source) => DecoderWasm.load(source));
    const d = await instance;
    const run = queue.then(() => {
      try {
        return decodeWith(d, bytes, path);
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError) d.reset();
        throw err;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}
