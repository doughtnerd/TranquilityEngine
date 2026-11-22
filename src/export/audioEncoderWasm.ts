/**
 * Internal (ADR 0337 §4, 0345 §1): one instance of `myco_audio_encode.wasm`, a WASI reactor, driven through its C ABI
 * (the header of `native/audio/crates/audio-encode/src/lib.rs`). Bytes cross through linear memory, never WASI file
 * descriptors, so no WASI runtime is needed: the shim below answers the six imports the module may call (Node's
 * `node:wasi` isn't used, which also avoids its crash on large reads in Node 22). Runs in a browser Worker, a
 * `worker_threads` thread or in-process alike.
 */
import type { ShippedCodec } from "../engine/audio/encoding/types";
import { AudioEncodeError, type EncodeErrorKind, type EncodeRequest, type EncodedAudio } from "./audioEncoder";

/** The ABI major this wrapper speaks. */
const ABI_MAJOR = 1;
const CODECS: Record<ShippedCodec, number> = { pcm: 0, adpcm: 1, vorbis: 2, opus: 3 };
const ERRORS: Record<number, EncodeErrorKind> = { [-2]: "arg", [-3]: "refused", [-4]: "encode" };

interface EncodeExports {
  readonly memory: WebAssembly.Memory;
  _initialize?(): void;
  myco_encode_abi_version(): number;
  myco_encode_source_hash(): number;
  myco_encode_vendor_ptr(): number;
  myco_encode_vendor_len(): number;
  myco_encode_alloc(bytes: number): number;
  myco_encode_free(ptr: number, bytes: number): void;
  myco_encode_run(pcm: number, frames: number, channels: number, rate: number, codec: number, quality: number, rateCeiling: number, flags: number): number;
  myco_encode_output_ptr(): number;
  myco_encode_output_len(): number;
  myco_encode_output_rate(): number;
  myco_encode_output_channels(): number;
  myco_encode_output_frames(): number;
  myco_encode_output_pre_skip(): number;
  myco_encode_output_free(): void;
  myco_encode_error_ptr(): number;
  myco_encode_error_len(): number;
}

/** The WASI preview 1 imports the encoder may call: stderr to `log`, randomness, a clock, an empty environment. */
export function encoderWasiImports(memory: () => WebAssembly.Memory, log: (line: string) => void = (l) => console.error(l)): WebAssembly.Imports {
  const view = () => new DataView(memory().buffer);
  const text = new TextDecoder();
  return {
    wasi_snapshot_preview1: {
      fd_write(_fd: number, iovs: number, count: number, written: number): number {
        const v = view();
        let n = 0;
        let s = "";
        for (let i = 0; i < count; i++) {
          const ptr = v.getUint32(iovs + i * 8, true);
          const len = v.getUint32(iovs + i * 8 + 4, true);
          s += text.decode(new Uint8Array(memory().buffer, ptr, len));
          n += len;
        }
        if (s.trim()) log(`[audio encoder] ${s.trimEnd()}`);
        v.setUint32(written, n, true);
        return 0;
      },
      random_get(ptr: number, len: number): number {
        const bytes = new Uint8Array(memory().buffer, ptr, len);
        for (let at = 0; at < len; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(len, at + 65536)));
        return 0;
      },
      clock_time_get(_id: number, _precision: bigint, at: number): number {
        view().setBigUint64(at, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true);
        return 0;
      },
      environ_sizes_get(count: number, size: number): number {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);
        return 0;
      },
      environ_get: (): number => 0,
      proc_exit(code: number): never {
        throw new Error(`the audio encoder exited (${code})`);
      },
    },
  };
}

/** One encoder instance. */
export interface EncoderInstance {
  /** The source hash the module embeds (its version). */
  readonly sourceHash: string;
  /** The vendor string it writes into Ogg files. */
  readonly vendor: string;
  /** Encodes synchronously (the caller is a thread). */
  encode(request: EncodeRequest): EncodedAudio;
}

/** Instantiates the encoder from its bytes or a compiled module. */
export async function instantiateEncoder(wasm: BufferSource | WebAssembly.Module, log?: (line: string) => void): Promise<EncoderInstance> {
  let x: EncodeExports | null = null;
  const imports = encoderWasiImports(() => x!.memory, log);
  const instance = wasm instanceof WebAssembly.Module ? await WebAssembly.instantiate(wasm, imports) : (await WebAssembly.instantiate(wasm, imports)).instance;
  x = instance.exports as unknown as EncodeExports;
  x._initialize?.();
  const major = x.myco_encode_abi_version() >> 8;
  if (major !== ABI_MAJOR) throw new Error(`myco_audio_encode.wasm speaks ABI ${major}, this build ${ABI_MAJOR}; run npm run build:audio`);
  const e = x;
  const hex = (ptr: number, n: number) => [...new Uint8Array(e.memory.buffer, ptr, n)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const str = (ptr: number, n: number) => new TextDecoder().decode(new Uint8Array(e.memory.buffer, ptr, n));
  return {
    sourceHash: hex(e.myco_encode_source_hash(), 16),
    vendor: str(e.myco_encode_vendor_ptr(), e.myco_encode_vendor_len()),
    encode(req) {
      const channels = Math.floor(req.channels);
      if (!(channels >= 1) || !(req.pcm.length >= channels)) throw new AudioEncodeError("arg", `${req.pcm.length} samples of ${req.channels} channels`);
      const frames = Math.floor(req.pcm.length / channels);
      const bytes = frames * channels * 4;
      const p = e.myco_encode_alloc(bytes);
      if (!p) throw new AudioEncodeError("encode", "the encoder is out of memory");
      try {
        // Views are made after each call that may grow memory.
        new Float32Array(e.memory.buffer, p, frames * channels).set(req.pcm.subarray(0, frames * channels));
        const r = e.myco_encode_run(p, frames, channels, req.sampleRate, CODECS[req.codec], req.quality, req.rateCeiling ?? 0, req.mono ? 1 : 0);
        if (r !== 0) throw new AudioEncodeError(ERRORS[r] ?? "encode", str(e.myco_encode_error_ptr(), e.myco_encode_error_len()));
      } finally {
        e.myco_encode_free(p, bytes);
      }
      try {
        return {
          bytes: new Uint8Array(e.memory.buffer, e.myco_encode_output_ptr(), e.myco_encode_output_len()).slice(),
          codec: req.codec,
          sampleRate: e.myco_encode_output_rate(),
          channels: e.myco_encode_output_channels(),
          frames: e.myco_encode_output_frames(),
          preSkip: e.myco_encode_output_pre_skip(),
        };
      } finally {
        e.myco_encode_output_free();
      }
    },
  };
}
