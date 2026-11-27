// @internal Soaks only (ADR 0171 amended by 0172, M5d task So1): the shared rig of the capture soaks
// (`ringWrap.bench.ts`, `openAt1024.bench.ts`, `realScenes.bench.ts`, `loudnessDrift.bench.ts`), run with
// `tools/audio-bench/capture.vitest.config.mts`. Never imported by runtime code.
//
// - `s3Rig`: spike S3's capture scene (Bn2's `realCore.bench.ts`) through the REAL core on the loopback, assembled as production
//   assembles it (`loopbackAudio`, ADR 0221 and 0234), on the global mixer and set as the audio backend, so `Audio.capture`
//   (`capture.ts`) records it exactly as it records a game.
// - `AllocationCounter`: Bn2's constructor count (a `Proxy` over each allocating global), swapped in only around the calls
//   it measures, so the core and the loopback host run on the real constructors.
// - `threadWorker`: the capture Worker (`worker.ts`) bundled with esbuild-wasm onto a `node:worker_threads` thread
//   (Rc5's `profilerSource.thread.test.ts`), as `CaptureSource` drives the browser's.
// - `memorySaveEnv`: `save.ts`'s environment with the web download kept in memory and deflate-raw from `node:zlib`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { defaultAudioSettings, type AudioSettings, type BusSettings } from "../../../../engine/audio/settings";
import type { CoreBackend } from "../core/coreBackend";
import { loopbackAudio, type LoopbackAudio } from "../testing";
import type { CorePreset } from "../worklet/coreDriver";
import type { SaveEnv } from "./save";
import type { CaptureRequest, CaptureResponse } from "./worker";

export const RATE = 48_000;
export const QUANTUM = 128;
/** Quanta per main-thread frame: one STATUS block (768 frames) per frame, as Bn2's scene. */
export const FRAME_QUANTA = 6;
export const FRAME_SECONDS = (FRAME_QUANTA * QUANTUM) / RATE;
export const MiB = 1024 * 1024;

/** Spike S3's scenes (`spikes/audio-mix/capture/sim.mjs` `SCENES`, Bn2's table). */
export interface S3Scene {
  name: string;
  live: number;
  mixed: number;
  buses: number;
  life: number;
  loopFrac: number;
}
export const S3_1024: S3Scene = { name: "1,024 live", live: 1024, mixed: 256, buses: 16, life: 2, loopFrac: 0.3 };

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export interface S3Rig {
  audio: LoopbackAudio;
  backend: CoreBackend;
  /** Audio seconds stepped so far (the loopback's rendered frames / rate). */
  readonly audioSeconds: number;
  countLive(): number;
  /** The scene's voices stopped and fading out (their handles alive but no longer `playing`), by id. */
  fading(): Set<number>;
  /** One main-thread frame (mixer, backend, the scene's replacements) then `FRAME_QUANTA` quanta. `afterMain` runs between the two. */
  frame(afterMain?: () => void): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * S3's scene through the real core (Bn2's `runScene`, without its timers): `scene.live` voices topped up every frame, one-shots
 * ending with their clip and loopers stopped at a deadline, on `scene.buses` buses. The backend is the global audio backend
 * on the global mixer (configured here), so `Audio.capture` records it. Null when the wasm isn't built.
 */
export async function s3Rig(scene: S3Scene, seed = 1): Promise<S3Rig | null> {
  const preset: Partial<CorePreset> = { maxLogical: scene.live + 32, maxMixed: scene.mixed, maxBuses: Math.max(8, scene.buses), arenaInitialBytes: 4 * MiB, clipCeilingBytes: 96 * MiB };
  const rand = rng(seed);
  const ONE_SHOTS = 40;
  const LOOPS = 8;
  const frames = new Map<string, number>();
  const oneShot = (i: number) => `shot${i}.wav`;
  const loopClip = (i: number) => `loop${i}.wav`;
  for (let i = 0; i < ONE_SHOTS; i++) frames.set(oneShot(i), Math.round((0.25 + (i / (ONE_SHOTS - 1)) * (2 * scene.life - 0.5)) * RATE));
  for (let i = 0; i < LOOPS; i++) frames.set(loopClip(i), Math.round((0.6 + i * 0.15) * RATE));
  const settings: AudioSettings = defaultAudioSettings();
  const buses: BusSettings[] = [{ name: "Master", volume: 1, mute: false, effects: [] }];
  for (let i = 1; i < scene.buses; i++) buses.push({ name: `Bus${i}`, parent: "Master", volume: 1, mute: false, effects: [] });
  settings.buses = buses;
  settings.voices = { mixed: scene.mixed, logical: scene.live + 32, hrtf: 8 };
  // The global mixer, the backend registered on it (`Audio.capture` records it), one World's share; each clip's length is its path's.
  const audio = await loopbackAudio({
    settings,
    preset,
    decode: (path) => {
      const n = frames.get(path) ?? RATE;
      return { channelData: [new Float32Array(n).fill(0.1)] };
    },
  });
  if (!audio) return null;
  const backend = audio.backend;
  const capacity = preset.maxLogical!;
  const names = backend.busNames;
  const deadline = new Float64Array(capacity).fill(Infinity);
  const handles: ({ readonly id: number; readonly playing: boolean; readonly alive?: boolean; stop(fade?: number): void } | null)[] = new Array(capacity).fill(null);
  let audioSeconds = 0;
  const countLive = (): number => {
    let n = 0;
    // A slot's newest handle (a reused slot's is replaced at spawn): playing covers locked, virtual and waiting voices.
    for (let i = 0; i < capacity; i++) if (handles[i]?.playing) n++;
    return n;
  };
  const spawn = (): void => {
    const looping = rand() < scene.loopFrac;
    const path = looping ? loopClip((rand() * LOOPS) | 0) : oneShot((rand() * ONE_SHOTS) | 0);
    const bus = names[1 + ((rand() * (names.length - 1)) | 0)] ?? "Master";
    const v = backend.play({
      path, url: path, loop: looping, stream: false, bus, volume: 0.2 + rand() * 0.8,
      pitch: rand() < 0.9 ? 1 : 0.8 + rand() * 0.4, priority: (rand() * 128) | 0,
    });
    if (v) {
      const slot = v.id & 0xffff;
      handles[slot] = v;
      deadline[slot] = looping ? audioSeconds + 0.5 + rand() * (2 * scene.life - 0.5) : Infinity;
    }
  };
  return {
    audio, backend, countLive,
    fading() {
      const out = new Set<number>();
      for (const h of handles) if (h && h.alive === true && !h.playing) out.add(h.id);
      return out;
    },
    get audioSeconds() {
      return audioSeconds;
    },
    async frame(afterMain) {
      audio.mainFrame(FRAME_SECONDS); // ADR 0434: the frame a game runs
      for (let i = 0; i < capacity; i++) {
        if (deadline[i]! <= audioSeconds) {
          handles[i]?.stop(0.005);
          deadline[i] = Infinity;
        }
      }
      for (let n = countLive(); n < scene.live; n++) spawn();
      afterMain?.();
      await Promise.resolve();
      audio.render(FRAME_QUANTA);
      audioSeconds += FRAME_SECONDS;
    },
    dispose: () => audio.close(),
  };
}

// --- allocation counting ----------------------------------------------------------------------------------------------

const ALLOCATING = ["ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "Map", "Set"] as const;

/**
 * Counts constructions of the allocating globals (Bn2's structural check: never a heap delta) while `during(fn)` runs.
 * The proxies are made once; `during` only swaps the globals' bindings, so the counter itself allocates nothing per call.
 */
export class AllocationCounter {
  count = 0;
  /** Constructions per constructor name, and the first stack seen for each (what allocated, for a report). */
  readonly byName: Record<string, number> = {};
  readonly firstStack: Record<string, string> = {};
  private readonly originals: [string, unknown][] = [];
  private readonly proxies: [string, unknown][] = [];

  constructor() {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const name of ALLOCATING) {
      const ctor = g[name];
      if (typeof ctor !== "function") continue;
      this.originals.push([name, ctor]);
      const proxy: unknown = new Proxy(ctor as new (...a: unknown[]) => unknown, {
        construct: (target, args, newTarget) => {
          this.count++;
          this.byName[name] = (this.byName[name] ?? 0) + 1;
          this.firstStack[name] ??= (new Error().stack ?? "").split("\n").slice(2, 9).join("\n");
          return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
        },
      });
      this.proxies.push([name, proxy]);
    }
  }

  during<T>(fn: () => T): T {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [name, p] of this.proxies) g[name] = p;
    try {
      return fn();
    } finally {
      for (const [name, c] of this.originals) g[name] = c;
    }
  }
}

// --- the capture Worker on a thread -----------------------------------------------------------------------------------

/** `profilerSource.ts`'s `CaptureWorkerLike`, restated (a runtime file never imports the editor half, ADR 0133). */
export interface ThreadWorkerLike {
  onmessage: ((e: { data: CaptureResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage(message: CaptureRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
}

const WORKER_ENTRY = `
import { parentPort } from "node:worker_threads";
import { bindCaptureWorker } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};
let listener = null;
parentPort.on("message", (data) => listener?.({ data }));
bindCaptureWorker({
  set onmessage(f) { listener = f; },
  get onmessage() { return listener; },
  postMessage: (m, t) => parentPort.postMessage(m, t),
});
`;

/** Bundles `worker.ts` for a `node:worker_threads` Worker; `make()` starts one, `close()` removes the bundle. */
export async function threadWorkerFactory(): Promise<{ make(): ThreadWorkerLike; close(): void }> {
  const mod = (await import("esbuild-wasm")) as unknown as EsbuildLike & { default?: EsbuildLike };
  const esbuild = mod.default ?? mod;
  const out = await esbuild.build({
    stdin: { contents: WORKER_ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), loader: "ts", sourcefile: "so1-thread-entry.ts" },
    bundle: true, format: "esm", platform: "node", target: "node20", write: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "so1-capture-worker-"));
  const script = join(dir, "worker.mjs");
  writeFileSync(script, out.outputFiles[0]!.text);
  return {
    make(): ThreadWorkerLike {
      const w = new Worker(script);
      const like: ThreadWorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (m, t) => w.postMessage(m, t as never),
        terminate: () => void w.terminate(),
      };
      w.on("message", (data: CaptureResponse) => like.onmessage?.({ data }));
      w.on("error", (e) => like.onerror?.(e));
      return like;
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- the save -------------------------------------------------------------------------------------------------------

/** The web save path with the download kept: `files` holds each saved file (deflate-raw by `node:zlib`, as `CompressionStream` writes it). */
export function memorySaveEnv(): SaveEnv & { files: { name: string; bytes: Uint8Array }[] } {
  const files: { name: string; bytes: Uint8Array }[] = [];
  return {
    files,
    tauri: false,
    fs: { mkdir: async () => {}, write: async () => {}, list: async () => [], remove: async () => {} },
    storageRoot: async () => "",
    download: (bytes, name) => void files.push({ name, bytes: bytes.slice() }),
    compress: async (payload) => new Uint8Array(deflateRawSync(payload)),
    now: () => new Date(2026, 10, 14, 12, 0, 0),
  };
}

// --- main-side cost -------------------------------------------------------------------------------------------------

/**
 * `sink` behind a `Proxy` that times every method call into `timer.ms` (wrappers made once per method). The wrapper's own
 * cost per call is `timedCallOverheadUs()`; the soaks report it beside the sum so the reader can take it off.
 */
export function timedSink<T extends object>(sink: T, timer: { ms: number; calls: number }): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(sink, {
    get(target, key) {
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== "function") return v;
      let w = wrapped.get(key);
      if (!w) {
        w = (...args: unknown[]) => {
          const t0 = performance.now();
          try {
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          } finally {
            timer.ms += performance.now() - t0;
            timer.calls++;
          }
        };
        wrapped.set(key, w);
      }
      return w;
    },
  });
}

/** The timing wrapper's own cost per call, µs: a no-op method called through `timedSink` (median of 5 runs of 100,000). */
export function timedCallOverheadUs(): number {
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const timer = { ms: 0, calls: 0 };
    const s = timedSink({ f(_a: number): void {} }, timer);
    const n = 100_000;
    for (let i = 0; i < n; i++) s.f(i);
    runs.push((timer.ms * 1000) / n);
  }
  return stat(runs).median;
}

/** Record bytes (head included) by type name over an opened capture. */
export function bytesByType(c: { records: { count: number; type: Uint8Array; len: Uint32Array } }, names: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < c.records.count; i++) {
    const name = Object.entries(names).find(([, v]) => v === c.records.type[i])?.[0] ?? `0x${c.records.type[i]!.toString(16)}`;
    out[name] = (out[name] ?? 0) + c.records.len[i]! + 20;
  }
  return out;
}

/** Median / p95 / max of `values`. */
export function stat(values: ArrayLike<number>): { n: number; median: number; p95: number; max: number } {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  const at = (p: number) => s[Math.min(n - 1, Math.floor(p * n))] ?? 0;
  return { n, median: at(0.5), p95: at(0.95), max: s[n - 1] ?? 0 };
}
