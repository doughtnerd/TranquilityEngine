// @internal test helpers for the audio plugin (api-and-models §6, "Fakes"). Contract K4 (coordinator, MS2 wave 2):
// the loopback host's signature. A1.7 owns this file; A1.4's loopback check runs on it at the wave review.
//
// `makeFakeBackend()` replaces the per-test fakes and the Howler mock: an `AudioBackend` that records what the
// engine tells it. `createLoopbackHost()` runs the real committed wasm in Node with no AudioContext.

import type { AudioBackend, Attenuation, AudioVoice, ListenerPose, PlayRequest } from "./backend";
import { mixer, type Mixer, type ResolvedBus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { CoreLink, type LinkPort } from "./core/context";
import { fakeHostClock, type FakeHostClock } from "./core/hostClock";
import { QUANTUM_FRAMES, type StatusBlock } from "./wire.generated";
import { CoreDriver, instantiateCore, type CoreInstance, type CorePreset } from "./worklet/coreDriver";

// --- The fake backend -----------------------------------------------------------------------------------------

/** One call a fake voice received, in order. */
export type FakeVoiceEvent =
  | { readonly kind: "volume"; readonly value: number }
  | { readonly kind: "pitch"; readonly value: number }
  | { readonly kind: "attenuation"; readonly value: Attenuation }
  | { readonly kind: "position"; readonly value: Vec3Like }
  | { readonly kind: "bus"; readonly value: string }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "stop"; readonly fadeSeconds?: number }
  | { readonly kind: "fade"; readonly to: number; readonly seconds: number }
  | { readonly kind: "priority"; readonly value: number };

/** A voice the fake handed out. Fields hold the latest value; `events` the whole history. */
export interface FakeVoice extends AudioVoice {
  readonly request: PlayRequest;
  readonly events: readonly FakeVoiceEvent[];
  readonly volume: number;
  readonly pitch: number;
  readonly attenuation: Attenuation | null;
  readonly position: Vec3Like | null;
  readonly bus: string;
  readonly paused: boolean;
  readonly stopped: boolean;
  /** Ends the voice the way a finished clip does: `playing` goes false and the bus count drops. */
  end(): void;
}

/** The fake backend: an `AudioBackend` plus what a test inspects. */
export interface FakeBackend extends AudioBackend {
  /** Every `play` request, in order (also those refused when `ready` is false). */
  readonly plays: PlayRequest[];
  /** Every voice handed out, in order. */
  readonly voices: FakeVoice[];
  /** Every `setListener` pose, in order. */
  readonly listeners: ListenerPose[];
  /** The newest listener pose, or null. */
  readonly listener: ListenerPose | null;
  /** When false, `play` returns null (a backend that isn't ready or doesn't know the clip). */
  ready: boolean;
  /** Forgets the recorded plays, voices and listener poses (not the voices' own state). */
  clear(): void;
}

/**
 * One `makeFakeBackend()` for every test that wants a backend without sound (api-and-models §6): `play` records the
 * request and counts the voice on its bus (`mixer.voiceStarted`; `stop` and `end` call `voiceEnded` once), the
 * voice records every call, and `setListener` records the pose. Pass it to `setAudioBackend`.
 */
export function makeFakeBackend(): FakeBackend {
  const plays: PlayRequest[] = [];
  const voices: FakeVoice[] = [];
  const listeners: ListenerPose[] = [];
  const backend: FakeBackend = {
    name: "fake",
    plays,
    voices,
    listeners,
    get listener() {
      return listeners.at(-1) ?? null;
    },
    ready: true,
    masterVolume: 1,
    muted: false,
    status: "running",
    time: 0,
    debug() {
      return {
        status: backend.status, sampleRate: 48_000, time: backend.time, background: "mute",
        counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, mixedCap: 0, logicalVoices: voices.length, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 },
        buses: [], voices: [], core: { backend: "fake" },
      };
    },
    setBackground() {},
    update() {},
    play(request) {
      plays.push(request);
      if (!backend.ready) return null;
      const voice = makeFakeVoice(request);
      voices.push(voice);
      return voice;
    },
    setListener(pose) {
      // Explicit copies: the engine passes Vector3s whose x/y/z are getters, which a spread would miss.
      const copy = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y, z: p.z });
      listeners.push({ position: copy(pose.position), forward: copy(pose.forward), up: copy(pose.up) });
    },
    applyMix(buses: readonly ResolvedBus[]) {
      void buses;
    },
    configureBuses(m: Mixer) {
      void m;
    },
    clear() {
      plays.length = 0;
      voices.length = 0;
      listeners.length = 0;
    },
  };
  return backend;
}

let nextFakeVoiceId = 1;

function makeFakeVoice(request: PlayRequest): FakeVoice {
  const events: FakeVoiceEvent[] = [];
  let counted = true;
  const state = { volume: 1, pitch: 1, attenuation: null as Attenuation | null, position: null as Vec3Like | null, bus: request.bus, paused: false, stopped: false, playing: true };
  const uncount = (): void => {
    if (counted) mixer.voiceEnded(state.bus);
    counted = false;
  };
  mixer.voiceStarted(request.bus);
  // The request's initial values are recorded like the setters' calls, only for what the request carries.
  if (request.volume !== undefined) { state.volume = request.volume; events.push({ kind: "volume", value: request.volume }); }
  if (request.pitch !== undefined) { state.pitch = request.pitch; events.push({ kind: "pitch", value: request.pitch }); }
  if (request.attenuation) { state.attenuation = { ...request.attenuation }; events.push({ kind: "attenuation", value: state.attenuation }); }
  if (request.position) { state.position = { x: request.position.x, y: request.position.y, z: request.position.z }; events.push({ kind: "position", value: state.position }); }
  return {
    request,
    id: nextFakeVoiceId++,
    reason: null,
    fade(to, seconds) { events.push({ kind: "fade", to, seconds }); },
    setPriority(value) { events.push({ kind: "priority", value }); },
    events,
    get volume() { return state.volume; },
    get pitch() { return state.pitch; },
    get attenuation() { return state.attenuation; },
    get position() { return state.position; },
    get bus() { return state.bus; },
    get paused() { return state.paused; },
    get stopped() { return state.stopped; },
    get playing() { return state.playing; },
    setVolume(value) { state.volume = value; events.push({ kind: "volume", value }); },
    setPitch(value) { state.pitch = value; events.push({ kind: "pitch", value }); },
    setAttenuation(a) {
      state.attenuation = { minDistance: a.minDistance, maxDistance: a.maxDistance, rolloff: a.rolloff };
      events.push({ kind: "attenuation", value: state.attenuation });
    },
    setPosition(p) {
      state.position = { x: p.x, y: p.y, z: p.z };
      events.push({ kind: "position", value: state.position });
    },
    setBus(bus) {
      if (counted) {
        mixer.voiceEnded(state.bus);
        mixer.voiceStarted(bus);
      }
      state.bus = bus;
      events.push({ kind: "bus", value: bus });
    },
    pause() { state.paused = true; events.push({ kind: "pause" }); },
    resume() { state.paused = false; events.push({ kind: "resume" }); },
    stop(fadeSeconds) { state.stopped = true; state.playing = false; events.push(fadeSeconds ? { kind: "stop", fadeSeconds } : { kind: "stop" }); uncount(); },
    end() { state.playing = false; uncount(); },
  };
}

// --- The loopback host ----------------------------------------------------------------------------------------

/** The real wasm core run in Node with no AudioContext (architecture §4.6). */
export interface LoopbackHost {
  /** The injected clock; `renderQuanta` advances it by 128 frames per quantum. */
  readonly clock: FakeHostClock;
  /**
   * Renders `n` quanta through the real wasm and delivers the STATUS blocks synchronously at their 6-quantum points
   * (and every 48 when no batch arrived for 250 ms). Returns the rendered audio, planar: [L of all quanta, R of all quanta].
   */
  renderQuanta(n: number): { readonly left: Float32Array; readonly right: Float32Array };
  /** The main side's link: ping, status listeners, `lastStatus`, the BATCH pool. (Addition to K4.) */
  readonly link: CoreLink;
  /** The shell's driver: stats, the STATUS pool, the probe. (Addition to K4.) */
  readonly driver: CoreDriver;
  /** The instantiated core. (Addition to K4.) */
  readonly core: CoreInstance;
  /** Every STATUS block received, in order. (Addition to K4.) */
  readonly statuses: StatusBlock[];
  /** Hands a wire buffer (BATCH, REPLAY, TIME_PING...) to the shell at the current frame, as `port.postMessage` would; buffers it returns reach the link. (Addition to K4.) */
  send(buffer: ArrayBuffer): void;
  /** The first frame of the next quantum. (Addition to K4.) */
  readonly frame: number;
}

/** The default preset: roomy enough for the §8 loopback cases. */
export const LOOPBACK_PRESET: CorePreset = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20 };
/** The loopback rate (the shell's `sampleRate`). */
export const LOOPBACK_RATE = 48_000;

const QUANTUM_MS = (QUANTUM_FRAMES / LOOPBACK_RATE) * 1000;

/** Builds a loopback host on the committed wasm, with the given (or a new) fake clock and preset. */
export async function createLoopbackHost(options: { clock?: FakeHostClock; preset?: CorePreset } = {}): Promise<LoopbackHost> {
  // A variable specifier: the engine's declaration build (tsconfig.engine.json) has no Node types, and this file only runs in Node tests.
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
  const wasm = await readFile(new URL("./wasm/myco_audio.wasm", import.meta.url));
  const clock = options.clock ?? fakeHostClock();
  const core = instantiateCore(wasm, options.preset ?? LOOPBACK_PRESET, LOOPBACK_RATE);
  const toMain: unknown[] = [];
  const toWorklet: unknown[] = [];
  const driver = new CoreDriver(core, (message) => toMain.push(message), clock.dateNow());
  const port: LinkPort = { onmessage: null, postMessage: (message) => toWorklet.push(message) };
  const link = new CoreLink(port);
  const statuses: StatusBlock[] = [];
  link.onStatus((s) => statuses.push(s));
  let frame = 0;

  // Both directions drain synchronously, so a STATUS is received (and RECYCLEd) inside the quantum that posted it.
  const flush = (): void => {
    while (toMain.length || toWorklet.length) {
      for (const message of toMain.splice(0)) port.onmessage?.({ data: message });
      for (const message of toWorklet.splice(0)) {
        if (message instanceof ArrayBuffer) driver.onMessage(message, frame, clock.dateNow());
        else driver.onControl(message as never);
      }
    }
  };

  return {
    clock,
    link,
    driver,
    core,
    statuses,
    get frame() {
      return frame;
    },
    send(buffer) {
      port.postMessage(buffer, [buffer]);
      flush();
    },
    renderQuanta(n) {
      const left = new Float32Array(n * QUANTUM_FRAMES);
      const right = new Float32Array(n * QUANTUM_FRAMES);
      for (let i = 0; i < n; i++) {
        driver.process(frame, clock.dateNow());
        left.set(driver.left, i * QUANTUM_FRAMES);
        right.set(driver.right, i * QUANTUM_FRAMES);
        frame += QUANTUM_FRAMES;
        clock.advance(QUANTUM_MS);
        flush();
      }
      return { left, right };
    },
  };
}
