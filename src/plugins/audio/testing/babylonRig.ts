// @internal The one rig of the Babylon fallback's tests (`runtime/babylonBackend*.test.ts`, the clip loader's): a
// `BabylonBackend` made through its constructor options on a fake `AudioContext` (`babylonMocks.ts`), with the page's
// unlock target and visibility kept out of the way. Each test file still mocks Babylon's engine module itself (a
// `vi.mock` is hoisted per file):
//
//   vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);
//
// Call `babylonMock.reset()` in `beforeEach` and `disposeBabylonRigs()` in `afterEach`.
import { vi, type Mock } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import type { PlayRequest } from "../runtime/backend";
import { BabylonBackend, type BabylonBackendOptions } from "../runtime/babylonBackend";
import { babylonMock, makeFakeContext, type FakeContext, type MockEngine, type MockSound } from "./babylonMocks";

export interface BabylonRigOptions<C extends object> extends Omit<BabylonBackendOptions, "unlockTarget"> {
  /** Where the unlock layer listens. Default: a fresh target. */
  unlockTarget?: EventTarget;
  /** The fake context's starting state (when `context` isn't given). Default "running". */
  state?: string;
  /** The test's own context (sink ids, decoding), instead of `makeFakeContext(state)`. */
  context?: C;
  /** A core host's context the backend plays on instead of making its own (the `hostContext` option). */
  host?: object;
  /** Give the backend the mixer's buses and gains at once (`configureBuses`, `applyMix`). Default true. */
  wire?: boolean;
}

export interface BabylonRig<C extends object = FakeContext> {
  readonly backend: BabylonBackend;
  readonly context: C;
  /** Where the unlock layer listens (a fresh target unless the options name one). */
  readonly target: EventTarget;
  /** The `createContext` option: how often the backend made its context. */
  readonly createContext: Mock<() => AudioContext>;
}

const rigs: BabylonBackend[] = [];

/**
 * A backend on a fake context: no core host (`hostContext` null), a fresh unlock target, no page visibility; any option
 * the test passes wins. The backend is disposed by `disposeBabylonRigs`.
 */
export function babylonRig<C extends object = FakeContext>(options: BabylonRigOptions<C> = {}): BabylonRig<C> {
  const { state, context: given, host, wire = true, ...backendOptions } = options;
  const context = (given ?? makeFakeContext(state ?? "running")) as C;
  const target = backendOptions.unlockTarget ?? new EventTarget();
  // The one place a fake stands in for the context's type.
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const hostContext = (): AudioContext | null => (host ? (host as unknown as AudioContext) : null);
  const backend = new BabylonBackend({ createContext, hostContext, visibility: null, ...backendOptions, unlockTarget: target });
  rigs.push(backend);
  if (wire) {
    backend.configureBuses(mixer);
    backend.applyMix(mixer.resolveAll());
  }
  return { backend, context, target, createContext };
}

/** Disposes every rig's backend (`afterEach`). */
export function disposeBabylonRigs(): void {
  for (const b of rigs.splice(0)) b.dispose();
}

/** Lets pending promise callbacks (the dynamic import, the mock engine's awaits, the voice's load) run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** A plain one-shot of `a.wav` on SFX, with `extra` over it. */
export const playRequest = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "SFX", ...extra });

/** The newest mock engine. */
export const engine = (): MockEngine => babylonMock.engine;
/** The newest engine's sound `i`, in the order they were made. */
export const sound = (i = 0): MockSound => engine().sounds[i]!;

/** A buffer the fake context made (`createBuffer`), with the channel data copied into it. */
export interface CreatedBuffer {
  channels: number;
  length: number;
  rate: number;
  copied: Float32Array | null;
  duration: number;
}

/** A decoded clip as `decodeAudioData` returns it: `channels` channels of `frames` frames, channel c filled with c + 1. */
export function fakeDecoded(channels: number, frames: number, rate = 48_000) {
  const data = Array.from({ length: channels }, (_, c) => new Float32Array(Math.min(frames, 16)).fill(c + 1));
  return { numberOfChannels: channels, length: frames, sampleRate: rate, duration: frames / rate, getChannelData: (c: number) => data[c]! };
}

/**
 * A running fake context that decodes any bytes to `decoded` and records the buffers it makes (`created`), with `fetch`
 * stubbed to answer every URL (`fetched`; undo with `vi.unstubAllGlobals()`).
 */
export function decodingContext(decoded: ReturnType<typeof fakeDecoded> = fakeDecoded(4, 48_000)) {
  const context = makeFakeContext("running");
  const created: CreatedBuffer[] = [];
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  const decoding = Object.assign(context, {
    decodeAudioData: async () => decoded,
    createBuffer: (channels: number, length: number, rate: number) => {
      const c: CreatedBuffer = { channels, length, rate, copied: null, duration: length / rate };
      created.push(c);
      return Object.assign(c, { copyToChannel: (data: Float32Array) => { c.copied = data.slice(); } });
    },
  });
  return { context: decoding, created, fetched };
}

/** The console warnings so far that contain `text` (with `console.warn` spied on). */
export function warningsOf(warn: { mock: { calls: unknown[][] } }, text = ""): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(text));
}
