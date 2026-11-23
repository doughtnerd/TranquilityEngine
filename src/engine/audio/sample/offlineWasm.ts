/**
 * Internal (ADR 0342): loads the offline sample render, `myco_audio_offline.wasm` (`native/audio/crates/audio-offline`,
 * built into ./wasm by `npm run build:audio`), the first time a render is asked for, and runs one render through its C
 * ABI (the header of the crate's `lib.rs`). Browsers fetch the file (Vite bundles it as an asset); Node (tests, the
 * export) reads it from disk. The module exports its memory and owns its allocator; nothing else shares it.
 *
 * ABI 1.1 (ADR 0352 §7): the module imports `myco_ext`, the plugin effect calls the core's chains make. One instance
 * serves every render, so its import is a trampoline to the current render's plugin session (`offlinePlugins.ts`, the
 * plugin glue a caller opened); with none, the stubs give no instance and plugin effects pass through dry.
 */
import type { MycoExtCalls, OfflinePluginSession } from "./offlinePlugins";

interface OfflineExports {
  readonly memory: WebAssembly.Memory;
  myco_offline_abi_version(): number;
  myco_offline_alloc(bytes: number): number;
  myco_offline_free(ptr: number, bytes: number): void;
  myco_offline_render(pcm: number, frames: number, channels: number, rate: number, spec: number, specLen: number): number;
  myco_offline_output_pcm(h: number): number;
  myco_offline_output_frames(h: number): number;
  myco_offline_output_warnings(h: number): number;
  myco_offline_output_free(h: number): void;
}

/** The ABI major this wrapper speaks. */
const ABI_MAJOR = 1;

/** One render's raw result: interleaved PCM (the input's channels), its frames and the warning bits. */
export interface RawRender {
  readonly pcm: Float32Array;
  readonly frames: number;
  readonly warnings: number;
}

let loading: Promise<OfflineExports> | null = null;

/** The plugin session of the render running now (renders are synchronous in the module, so one at a time). */
let current: MycoExtCalls | null = null;

/** The `myco_ext` import: the current session's calls, else no plugin (no instance, every block dry). */
const trampoline: MycoExtCalls = {
  acquire: (e) => (current ? current.acquire(e) : 0),
  release: (h) => current?.release(h),
  describe: (e, what) => (current ? current.describe(e, what) : 0),
  process: (h, l, r, frames, p0, p1, flags, fuel) => (current ? current.process(h, l, r, frames, p0, p1, flags, fuel) : -1),
  sweep: (ptr, n, last) => current?.sweep(ptr, n, last),
};

async function instantiate(): Promise<OfflineExports> {
  const url = new URL("./wasm/myco_audio_offline.wasm", import.meta.url);
  let bytes: BufferSource;
  if (url.protocol === "file:") {
    // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
    bytes = (await readFile(url)) as Uint8Array<ArrayBuffer>;
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`offline render: myco_audio_offline.wasm didn't load (${res.status})`);
    bytes = await res.arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(bytes, { myco_ext: trampoline as unknown as WebAssembly.ModuleImports });
  const x = instance.exports as unknown as OfflineExports;
  const major = x.myco_offline_abi_version() >> 8;
  if (major !== ABI_MAJOR) throw new Error(`offline render: myco_audio_offline.wasm speaks ABI ${major}, this build ${ABI_MAJOR}; run npm run build:audio`);
  return x;
}

function load(): Promise<OfflineExports> {
  loading ??= instantiate().catch((err: unknown) => {
    loading = null; // a failed fetch or compile is tried again next time
    throw err;
  });
  return loading;
}

/**
 * Renders `pcm` (`channels` interleaved at `rate`) through `spec` (the crate's `spec.rs` layout); plugin effects in it
 * run through `plugins` (opened for this render; absent: they pass through dry).
 */
export async function renderOffline(pcm: Float32Array, channels: number, rate: number, spec: Float64Array, plugins?: OfflinePluginSession): Promise<RawRender> {
  const x = await load();
  if (plugins) plugins.attach(x.memory);
  current = plugins?.imports ?? null;
  const frames = Math.floor(pcm.length / channels);
  const pcmBytes = Math.max(4, frames * channels * 4);
  const specBytes = Math.max(8, spec.length * 8);
  const p = x.myco_offline_alloc(pcmBytes);
  const s = x.myco_offline_alloc(specBytes);
  try {
    if (!p || !s) throw new Error("offline render: out of memory");
    // Views are taken after every allocation: memory growth detaches the old buffer.
    new Float32Array(x.memory.buffer, p, frames * channels).set(pcm.subarray(0, frames * channels));
    new Float64Array(x.memory.buffer, s, spec.length).set(spec);
    const h = x.myco_offline_render(p, frames, channels, rate, s, spec.length);
    if (!h) throw new Error("offline render: the render spec was refused");
    try {
      const n = x.myco_offline_output_frames(h);
      const out = new Float32Array(x.memory.buffer, x.myco_offline_output_pcm(h), n * channels).slice();
      return { pcm: out, frames: n, warnings: x.myco_offline_output_warnings(h) };
    } finally {
      x.myco_offline_output_free(h);
    }
  } finally {
    current = null;
    if (p) x.myco_offline_free(p, pcmBytes);
    if (s) x.myco_offline_free(s, specBytes);
  }
}
