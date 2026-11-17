// @internal test helpers for the audio plugin (api-and-models §6, "Fakes"). Contract K4 (coordinator, MS2 wave 2):
// the loopback host's signature. A1.7 owns this file; A1.4's loopback check runs on it at the wave review.
//
// `makeFakeBackend()` replaces the per-test fakes and the library mocks: an `AudioBackend` that records what the
// engine tells it. `createLoopbackHost()` runs the real committed wasm in Node with no AudioContext.
//
// ADR 0162 (K4 owns this file in M3; the coordinator afterwards): the fake implements every K0 member: fake voices take
// `setVelocity`, `setOcclusion` and `setDopplerRate` (recorded like the other setters, latest values readable), and
// `makeFakeZoneIrService()` is a `ZoneIrService` a test drives by hand.
//
// ADR 0166 (Q2 owns this file in W1; the coordinator afterwards): the fake has the music seam: `music` (a recording
// `MusicBackend`, `FakeMusicBackend`), a counting `beginFrame`, `timeAt` over `rafTime` and `latency` over `latencyValue`.
//
// ADR 0171 (K0 owns this file in M5 W1; the coordinator afterwards): the fake has every M5 member: `mixOpTarget.sendOp` (ADR
// 0175: the ops the Mixer checked and sent) records the op and answers `applyResult`, `flushNow` counts, `mixCaps` is
// settable, `recorderTap` and `setProfileSink` hold what they're given, and `keyframe` answers the recorder's empty one.
//
// ADR 0179: the fake has every capability (`clipCache`, `clock`, `music`, `mix`, `capture`; no `automation`, so the event
// runtime evaluates on main), each the fake itself, as on the core. Each is a plain property a test sets to undefined for a
// backend without it (the Babylon fallback has no `clock`; the pending backend has no `mix` or `capture`).

import type { AudioBackend, AudioCaptureSource, AudioClipCache, AudioClock, AudioLiveMix, AudioMixCaps, AudioPanner, Attenuation, AudioVoice, FadeLaw, ListenerPose, MusicAdmitResult, MusicBackend, MusicBackendCaps, MusicGroupEvent, MusicGroupRequest, MusicGroupStamp, PlayRequest, RecorderTap, VoiceSpatialOptions, ZoneIrService } from "./backend";
import type { AudioLatency } from "../../../engine/audio/musicTypes";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { CORE_LIVE_CAPS } from "../../../engine/audio/busCapability";
import type { KeyframePayload } from "./capture/format";
import type { ProfileSink } from "./mix/profileSink";
import { mixer, Mixer, type ResolvedBus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { CoreLink, type AudioHost, type LinkPort } from "./core/context";
import type { HostClock } from "./core/hostClock";
import { QUANTUM_FRAMES, type StatusBlock } from "./wire.generated";
import { DEFAULT_LIMITER_LOOKAHEAD_MS, defaultAudioSettings, type AudioSettings } from "../../../engine/audio/settings";
import { CoreDriver, instantiateCore, type CoreInstance, type CorePreset } from "./worklet/coreDriver";
import { notifyEngineLifecycle } from "../../../engine/core/engineLifecycle";
import { batchRecords, type PostedBatch } from "./core/batchRecords";
import type { CoreBackend, CoreBackendDeps } from "./core/coreBackend";
import type { RebuildOutcome, RebuildReason, RecoveryOptions } from "./core/recovery";
import type { UnlockContext } from "./core/unlock";

/** The controls a test has over a fake clock. */
export interface FakeHostClock extends HostClock {
  /** Moves every clock forward by `ms` (the context clock by `ms / 1000` seconds unless suspended). */
  advance(ms: number): void;
  /** Sets whether the context clock runs (a suspended context's `currentTime` stands still). */
  setRunning(running: boolean): void;
  /** A3.4c: a new context: its clock starts again at 0 (the page's clocks run on). */
  restartContext(): void;
}

/** A fake clock starting at the given times (defaults: rAF 1000 ms, context 0 s, wall clock 1,000,000 ms). */
export function fakeHostClock(start: { rafTime?: number; currentTime?: number; dateNow?: number } = {}): FakeHostClock {
  let raf = start.rafTime ?? 1_000;
  let current = start.currentTime ?? 0;
  let date = start.dateNow ?? 1_000_000;
  let running = true;
  return {
    rafTime: () => raf,
    outputTimestamp: () => (running ? { contextTime: current, performanceTime: raf } : null),
    currentTime: () => current,
    dateNow: () => date,
    fake: true,
    advance(ms) {
      raf += ms;
      date += ms;
      if (running) current += ms / 1000;
    },
    setRunning(value) {
      running = value;
    },
    restartContext() {
      current = 0;
    },
  };
}

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
  // ADR 0166 (G-1): a stamped gain and/or low-pass ramp.
  | { readonly kind: "paramsShaped"; readonly gain?: number; readonly lowpassHz?: number; readonly seconds: number; readonly law?: FadeLaw; readonly at?: number }
  | { readonly kind: "priority"; readonly value: number }
  | { readonly kind: "loop"; readonly start: number; readonly end: number; readonly looping: boolean }
  // ADR 0162 (K0 members).
  | { readonly kind: "velocity"; readonly value: Vec3Like }
  | { readonly kind: "occlusion"; readonly gain: number; readonly lpHz: number }
  | { readonly kind: "doppler"; readonly factor: number }
  | { readonly kind: "spatialOptions"; readonly options: VoiceSpatialOptions };

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
  /** E3.10: false once freed: `stop()` with no fade, or `end()`. A voice stopped with a fade is not `playing` but stays alive (and counted on its bus) until `end()`, like a core voice fading out. */
  readonly alive: boolean;
  /** Ends the voice the way a finished clip does: `playing` goes false and the bus count drops. */
  end(): void;
  // ADR 0162 (K0): the latest values main's passes handed over (defaults: no velocity, open, factor 1).
  /** The latest `setVelocity`, or null before one. */
  readonly velocity: Vec3Like | null;
  /** The latest `setOcclusion` gain (1 before one). */
  readonly occlusionGain: number;
  /** The latest `setOcclusion` cutoff, Hz (24000 before one). */
  readonly occlusionLpHz: number;
  /** The latest `setDopplerRate` (1 before one). */
  readonly dopplerRate: number;
  setVelocity(v: Vec3Like): void;
  setOcclusion(gain: number, lpHz: number): void;
  setDopplerRate(factor: number): void;
  /** ADR 0162 §1.2 (D5): Play edits of the source's M3 options, recorded as `spatialOptions` events. */
  setSpatialOptions(o: VoiceSpatialOptions): void;
  /** ADR 0162 D5: the panner the voice reports (the public handle's `panner`): "ambisonic", "equalPower" for a positioned play, else "flat", until `setPanner`. Null once freed. */
  readonly panner: AudioPanner | null;
  /** ADR 0162 D5: the smoothed dry occlusion gain (the public handle's `occlusion`): the latest `setOcclusion` gain. */
  readonly occlusion: number;
  /** Test hook: the panner pick's answer (a spatial voice moving to "hrtf" or "bed"). */
  setPanner(kind: AudioPanner): void;
}

/** The recorder's empty keyframe (`capture/recorder.ts` `EMPTY_KEYFRAME`, repeated so the fake doesn't load the recorder chunk). */
const FAKE_EMPTY_KEYFRAME: KeyframePayload = Object.freeze({
  voices: [], buses: [], metered: [], events: [], music: [],
  mix: Object.freeze({ slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 }),
});

/** The fake backend: an `AudioBackend` with every capability (each the fake itself), plus what a test inspects. */
export interface FakeBackend extends AudioBackend, AudioClipCache, AudioClock, AudioLiveMix, AudioCaptureSource {
  // ADR 0179: the capabilities, each the fake itself; set one to undefined for a backend without it.
  clipCache: AudioClipCache | undefined;
  clock: AudioClock | undefined;
  mix: AudioLiveMix | undefined;
  capture: AudioCaptureSource | undefined;
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
  /** ADR 0158: clip lengths `clipDuration` reports (seconds); unlisted clips are unknown (null). */
  readonly durations: Map<string, number>;
  /** ADR 0158: what `clock.horizon()` returns; null: unknown, so callers take their no-clock path (as on the Babylon fallback). */
  horizonTime: number | null;
  /** ADR 0166 (G-1): what `clipFacts` reports per path; unlisted clips are unknown (undefined). */
  readonly facts: Map<string, { frames: number; rate: number; channels: number; gapless: boolean }>;
  /** ADR 0166 (G-1): whether the fake's voices have `paramsShaped` (default false: like the Babylon fallback, stem gain goes on `fade`). */
  stampedRamps: boolean;
  /** ADR 0166 (G-1): what `clock.frameInterval()` returns, seconds; null (the default): unknown, so callers estimate it. */
  frameIntervalSeconds: number | null;

  // ADR 0166 (Q2): the music seam, so the P rows' loopback tests run on the fake.
  /** The fake's `MusicBackend`; set it to undefined for a backend without music. */
  music: FakeMusicBackend | undefined;
  /** `beginFrame` calls so far (the `engine.AudioMusic` safety net counts them). */
  beginFrameCalls: number;
  /** The rAF time (ms) `timeAt` maps to `time`: `timeAt(p) = time + (p - rafTime) / 1000`. Default 0. */
  rafTime: number;
  /** What `latency()` returns. */
  latencyValue: AudioLatency;

  // ADR 0171 (K0): the M5 mix members.
  /** Every op `mixOpTarget.sendOp` received (after the Mixer's checks), in order. */
  readonly ops: MixOp[];
  /** What `sendOp` answers (default `{ ok: true, class: "direct" }`). */
  applyResult: ApplyResult;
  /** `flushNow` calls so far. */
  flushes: number;
  /** The fake's capability record (default: a core-like backend, every flag true). */
  mixCaps: AudioMixCaps;
  recorderTap: RecorderTap | null;
  /** The sink `setProfileSink` was given (null: none). */
  profileSink: ProfileSink | null;
}

/** A group the fake music backend holds: the latest request for its id and which members are primed. */
interface FakeGroup {
  request: MusicGroupRequest;
  primed: number;
}

/**
 * ADR 0166 (Q2): the fake's `MusicBackend`. It records every call; `admitGroup` answers `admitResult`; a primed group is
 * whatever the test said with `setPrimed`; `stampGroup` plays each member through the fake backend (`play`, with the
 * stamp's `at`), so the voices show in `voices`; `emit` delivers a group event to `onGroupEvent`.
 */
export interface FakeMusicBackend extends MusicBackend {
  caps: MusicBackendCaps;
  /** ADR 0166 (G-1): the ring pool size (default 0: unknown, the planner's pool check is off); tests set it. */
  ringPool: number;
  /** What `admitGroup` answers (default `{ ok: true }`). */
  admitResult: MusicAdmitResult;
  primeEmaMs: number;
  /** Every call, in order. */
  readonly admitted: MusicGroupRequest[];
  readonly primes: { readonly request: MusicGroupRequest; readonly retarget: boolean; readonly protect: readonly string[] }[];
  readonly stamps: MusicGroupStamp[];
  readonly cancelled: number[];
  readonly released: number[];
  readonly protects: { readonly instance: number; readonly paths: readonly string[] }[];
  /** Test hook: `primed` members of `group` are primed (default: all of them). Unknown groups are ignored. */
  setPrimed(group: number, primed?: number): void;
  /** Test hook: deliver `e` to `onGroupEvent`. */
  emit(e: MusicGroupEvent): void;
  /** Forgets the recorded calls and groups. */
  clear(): void;
}

function makeFakeMusicBackend(backend: FakeBackend): FakeMusicBackend {
  const groups = new Map<number, FakeGroup>();
  const remember = (request: MusicGroupRequest): FakeGroup => {
    const g = groups.get(request.group);
    if (g) {
      g.request = request;
      return g;
    }
    const added = { request, primed: request.members.filter((m) => m.play.stream !== true).length };
    groups.set(request.group, added);
    return added;
  };
  const music: FakeMusicBackend = {
    caps: { primes: true, stampedFades: true, heardClock: true, rhythm: true },
    admitResult: { ok: true },
    ringPool: 0,
    primeEmaMs: 40,
    onGroupEvent: null,
    admitted: [],
    primes: [],
    stamps: [],
    cancelled: [],
    released: [],
    protects: [],
    admitGroup(req) {
      music.admitted.push(req);
      return music.admitResult;
    },
    primeGroup(req, options = {}) {
      music.primes.push({ request: req, retarget: options.retarget === true, protect: options.protect ?? [] });
      remember(req);
    },
    primedState(group) {
      const g = groups.get(group);
      if (!g) return null;
      const of = g.request.members.length;
      const primed = Math.min(of, g.primed);
      return { group, primed, of, ready: primed === of };
    },
    stampGroup(stamp) {
      music.stamps.push(stamp);
      const g = groups.get(stamp.group);
      if (!g) return [];
      return g.request.members.map((m) => backend.play({ ...m.play, at: stamp.at }));
    },
    cancelGroup(group) {
      music.cancelled.push(group);
      groups.delete(group);
    },
    releaseInstance(instance) {
      music.released.push(instance);
    },
    protect(instance, paths) {
      music.protects.push({ instance, paths: [...paths] });
    },
    setPrimed(group, primed) {
      const g = groups.get(group);
      if (g) g.primed = primed ?? g.request.members.length;
    },
    emit(e) {
      music.onGroupEvent?.(e);
    },
    clear() {
      for (const list of [music.admitted, music.primes, music.stamps, music.cancelled, music.released, music.protects] as unknown[][]) list.length = 0;
      groups.clear();
    },
  };
  return music;
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
    dispose() {},
    clipCache: undefined,
    clock: undefined,
    mix: undefined,
    capture: undefined,
    durations: new Map(),
    horizonTime: null,
    facts: new Map(),
    frameIntervalSeconds: null,
    stampedRamps: false,
    music: undefined,
    beginFrameCalls: 0,
    rafTime: 0,
    latencyValue: { base: 0, output: 0, limiter: 0, total: 0, reliable: false },
    beginFrame() { backend.beginFrameCalls++; },
    timeAt(performanceTime: number) { return backend.time + (performanceTime - backend.rafTime) / 1000; },
    latency() { return { ...backend.latencyValue }; },
    horizon() { return backend.horizonTime; },
    frameInterval() { return backend.frameIntervalSeconds; },
    clipDuration(path: string) { return backend.durations.get(path) ?? null; },
    clipFacts(path: string) { return backend.facts.get(path); },
    invalidateClip() {},
    holdSpan() { return null; },
    ops: [],
    applyResult: { ok: true, class: "direct" },
    flushes: 0,
    mixCaps: { loudness: true, levelDucking: true, cpu: true, cpuReason: null, stampedBusRamps: true, capture: "full" },
    recorderTap: null,
    profileSink: null,
    mixOpTarget: { liveCaps: CORE_LIVE_CAPS, sendOp(op: MixOp) { backend.ops.push(op); return { ...backend.applyResult }; } },
    flushNow() { backend.flushes++; },
    setProfileSink(sink: ProfileSink | null) { backend.profileSink = sink; },
    keyframe() { return FAKE_EMPTY_KEYFRAME; },
    play(request) {
      plays.push(request);
      if (!backend.ready) return null;
      const voice = makeFakeVoice(request);
      if (!backend.stampedRamps) delete (voice as { paramsShaped?: unknown }).paramsShaped;
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
      backend.durations.clear();
      backend.horizonTime = null;
      backend.music?.clear();
      backend.beginFrameCalls = 0;
      backend.ops.length = 0;
      backend.flushes = 0;
    },
  };
  backend.clipCache = backend;
  backend.clock = backend;
  backend.mix = backend;
  backend.capture = backend;
  backend.music = makeFakeMusicBackend(backend);
  return backend;
}

let nextFakeVoiceId = 1;

function makeFakeVoice(request: PlayRequest): FakeVoice {
  const events: FakeVoiceEvent[] = [];
  let counted = true;
  const state = { volume: 1, pitch: 1, attenuation: null as Attenuation | null, position: null as Vec3Like | null, bus: request.bus, paused: false, stopped: false, playing: true, alive: true, panner: null as AudioPanner | null, velocity: null as Vec3Like | null, occlusionGain: 1, occlusionLpHz: 24_000, dopplerRate: 1 };
  const uncount = (): void => {
    if (counted) mixer.voiceEnded(state.bus);
    counted = false;
    state.alive = false;
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
    paramsShaped(r) { events.push({ kind: "paramsShaped", ...r }); },
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
    get alive() { return state.alive; },
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
    setLoop(start, end, looping) { events.push({ kind: "loop", start, end, looping }); },
    pause() { state.paused = true; events.push({ kind: "pause" }); },
    resume() { state.paused = false; events.push({ kind: "resume" }); },
    stop(fadeSeconds) {
      state.stopped = true; state.playing = false;
      events.push(fadeSeconds ? { kind: "stop", fadeSeconds } : { kind: "stop" });
      if (!(fadeSeconds && fadeSeconds > 0)) uncount(); // a fading voice is freed (and uncounted) at `end()`
    },
    end() { state.playing = false; uncount(); },
    // ADR 0162 (K0 members), recorded like the other setters.
    get velocity() { return state.velocity; },
    get occlusionGain() { return state.occlusionGain; },
    get occlusion() { return state.occlusionGain; },
    get panner() { return !state.alive ? null : (state.panner ?? (request.ambisonic ? "ambisonic" : request.position || state.position ? "equalPower" : "flat")); },
    setPanner(kind) { state.panner = kind; },
    get occlusionLpHz() { return state.occlusionLpHz; },
    get dopplerRate() { return state.dopplerRate; },
    setVelocity(v) {
      state.velocity = { x: v.x, y: v.y, z: v.z };
      events.push({ kind: "velocity", value: state.velocity });
    },
    setOcclusion(gain, lpHz) {
      state.occlusionGain = gain;
      state.occlusionLpHz = lpHz;
      events.push({ kind: "occlusion", gain, lpHz });
    },
    setDopplerRate(factor) {
      state.dopplerRate = factor;
      events.push({ kind: "doppler", factor });
    },
    setSpatialOptions(o) { events.push({ kind: "spatialOptions", options: { ...o } }); },
  };
}

// --- ADR 0162 (K0, C9): the fake zone IR service --------------------------------------------------------------------

/** A request the fake zone IR service received. */
export interface FakeZoneIrRequest {
  readonly token: number;
  readonly kernelId: number;
  readonly assetUrl?: string;
  readonly preset?: string;
  readonly contextRate: number;
  readonly maxFrames: number;
}

/** A `ZoneIrService` a test drives: it records requests and answers only when told. */
export interface FakeZoneIrService extends ZoneIrService {
  /** Every `prepare`, in order. */
  readonly requests: FakeZoneIrRequest[];
  /** Every `release`d kernel id, in order. */
  readonly released: number[];
  /** Every `reprepareAll` rate, in order. */
  readonly reprepared: number[];
  /** True after `dispose`. */
  readonly disposed: boolean;
  /** Answers request `token` as prepared (`onPrepared`), with `frames` (default `maxFrames`), `truncated` false and `prepareMs` 1 unless given. */
  prepared(token: number, fields?: Partial<{ frames: number; truncated: boolean; prepareMs: number }>): void;
  /** Answers request `token` as failed (`onFailed`) with `message` and `code` (default 1). */
  failed(token: number, message: string, code?: number): void;
}

/**
 * The fake zone IR service (K0's `ZoneIrService`): `prepare` records the request and returns a token (1, 2, ...);
 * nothing is answered until the test calls `prepared` or `failed`. An unknown token is ignored.
 */
export function makeFakeZoneIrService(): FakeZoneIrService {
  const requests: FakeZoneIrRequest[] = [];
  const released: number[] = [];
  const reprepared: number[] = [];
  let disposed = false;
  const find = (token: number) => requests.find((r) => r.token === token);
  const service: FakeZoneIrService = {
    requests,
    released,
    reprepared,
    get disposed() {
      return disposed;
    },
    onPrepared: null,
    onFailed: null,
    prepare(request) {
      const token = requests.length + 1;
      requests.push({ token, ...request });
      return token;
    },
    release(kernelId) {
      released.push(kernelId);
    },
    reprepareAll(contextRate) {
      reprepared.push(contextRate);
    },
    dispose() {
      disposed = true;
    },
    prepared(token, fields = {}) {
      const r = find(token);
      if (!r) return;
      service.onPrepared?.({ token, kernelId: r.kernelId, frames: fields.frames ?? r.maxFrames, truncated: fields.truncated ?? false, prepareMs: fields.prepareMs ?? 1 });
    },
    failed(token, message, code = 1) {
      const r = find(token);
      if (!r) return;
      service.onFailed?.({ token, kernelId: r.kernelId, code, message });
    },
  };
  return service;
}

// --- The audio session ------------------------------------------------------------------------------------------

/**
 * Ends the audio session as a game's exit does (ADR 0218): the Engines' lifecycle reports a game Engine disposed, so every
 * listener of the release forgets the project's audio state (the event runtime's instances and groups, the music players,
 * the files' loop points, the warn-once keys, the core fallback's warning, the capture). Call it between tests instead of
 * resetting modules by hand. Nothing else about an Engine happens (no mixer reconfigure), so a rig may call it at any point.
 */
export function endAudioSession(): void {
  notifyEngineLifecycle("disposed", "runtime");
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
  /**
   * A3.4a: a new core and shell over a new Memory (the host's `respawn` for a hard rebuild), with a fake node and the
   * port the host rebinds its link to. From then on `driver`, `core` and `renderQuanta` are the new ones'; the old
   * shell gets nothing more. (Addition to K4.)
   */
  respawn(): { readonly node: AudioWorkletNode; readonly port: LinkPort };
  /**
   * A3.4a: the next quantum's render call traps. The host hands the shell the real instance's exports with
   * `myco_audio_process` wrapped to throw a `WebAssembly.RuntimeError` once, as a wasm trap inside that call does; the core
   * itself has no hook for it. (Addition to K4.)
   */
  trapNext(): void;
  /** Cores made so far (1, plus one per `respawn` or `recreate`). (Addition to K4.) */
  readonly cores: number;
  /**
   * A3.4c: a new context at `sampleRate` (a device or rate rebuild): a new core and shell initialised at that rate,
   * with frames starting again at 0 and the fake clock's context clock restarted (`restartContext`); each quantum then
   * advances the clock by 128 frames at the new rate. Returns the fake node and the port, as `respawn` does; the caller
   * makes the fake context. (Addition to K4.)
   */
  recreate(sampleRate: number): { readonly node: AudioWorkletNode; readonly port: LinkPort };
  /** The current context's rate (`LOOPBACK_RATE` until a `recreate`). (Addition to K4.) */
  readonly sampleRate: number;
  /**
   * ADR 0221: a main-thread stall: from now on what the shell sends main (STATUS, recycled buffers) queues on the port and
   * main handles none of it, so once its STATUS pool is out the shell takes nothing. `release` hands main what queued, in order.
   */
  stallMain(): LoopbackStall;
  /** ADR 0221: watches what reaches the shell: every BATCH or REPLAY posted from now on, decoded, with the frame it was posted at. */
  watch(): LoopbackWatch;
}

/** The default preset: roomy enough for the §8 loopback cases. */
export const LOOPBACK_PRESET: CorePreset = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: DEFAULT_LIMITER_LOOKAHEAD_MS, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 };
/** The loopback rate (the shell's `sampleRate`). */
export const LOOPBACK_RATE = 48_000;


/** Builds a loopback host on the committed wasm, with the given (or a new) fake clock and preset. */
export async function createLoopbackHost(options: { clock?: FakeHostClock; preset?: CorePreset } = {}): Promise<LoopbackHost> {
  // A variable specifier: the engine's declaration build (tsconfig.engine.json) has no Node types, and this file only runs in Node tests.
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
  const wasm = await readFile(new URL("./wasm/myco_audio.wasm", import.meta.url));
  const clock = options.clock ?? fakeHostClock();
  const preset = options.preset ?? LOOPBACK_PRESET;
  const module = new WebAssembly.Module(wasm as Uint8Array<ArrayBuffer>);

  let rate = LOOPBACK_RATE;
  /** The open `watch`es: each gets every BATCH or REPLAY posted to the shell, decoded. */
  const watchers = new Set<{ frame: number; batch: PostedBatch }[]>();
  /** Set by `trapNext`: the current core's next render call throws, as a trap inside it would. */
  let trapPending = false;
  /** The real instance with `myco_audio_process` wrapped (`trapNext`); every other export is the instance's own. */
  const trappable = (real: CoreInstance): CoreInstance => {
    const render = real.exports.myco_audio_process;
    const myco_audio_process = (frameLo: number, frameHi: number): number => {
      if (trapPending) {
        trapPending = false;
        throw new WebAssembly.RuntimeError("unreachable");
      }
      return render(frameLo, frameHi);
    };
    const exports = Object.create(real.exports, { myco_audio_process: { value: myco_audio_process } }) as CoreInstance["exports"];
    return { exports, memory: real.memory, sampleRate: real.sampleRate };
  };
  /** One core with its shell and both message queues (a respawn makes another; the old one is dropped). */
  const spawn = () => {
    trapPending = false;
    const core = trappable(instantiateCore(module, preset, rate));
    const toMain: unknown[] = [];
    const toWorklet: unknown[] = [];
    const driver = new CoreDriver(core, (message) => toMain.push(message), clock.dateNow());
    const port: LinkPort = {
      onmessage: null,
      postMessage: (message) => {
        if (watchers.size > 0 && message instanceof ArrayBuffer) {
          // A copy: pooled BATCH buffers come back to the link and are reused.
          const batch = batchRecords(message.slice(0));
          if (batch) for (const w of watchers) w.push({ frame, batch });
        }
        toWorklet.push(message);
      },
    };
    return { core, driver, toMain, toWorklet, port };
  };
  let current = spawn();
  let cores = 1;
  const link = new CoreLink(current.port);
  const statuses: StatusBlock[] = [];
  link.onStatus((s) => statuses.push(s));
  let frame = 0;

  /** A main-thread stall (`stallMain`): what the shell sent main meanwhile, and the frame the last of it arrived at. */
  let stalled: { held: unknown[]; lastFrame: number } | null = null;

  // Both directions drain synchronously, so a STATUS is received (and RECYCLEd) inside the quantum that posted it.
  const flush = (): void => {
    const { toMain, toWorklet, port, driver } = current;
    while (toMain.length || toWorklet.length) {
      for (const message of toMain.splice(0)) {
        if (stalled) {
          stalled.held.push(message);
          stalled.lastFrame = frame;
        } else port.onmessage?.({ data: message });
      }
      for (const message of toWorklet.splice(0)) {
        if (message instanceof ArrayBuffer) driver.onMessage(message, frame, clock.dateNow());
        else if ((message as { type?: unknown }).type === "debugTone") driver.onControl(message as never);
      }
    }
  };

  return {
    clock,
    link,
    get driver() {
      return current.driver;
    },
    get core() {
      return current.core;
    },
    statuses,
    get frame() {
      return frame;
    },
    get cores() {
      return cores;
    },
    get sampleRate() {
      return rate;
    },
    respawn() {
      current = spawn();
      cores++;
      const node = { connect() {}, disconnect() {} } as unknown as AudioWorkletNode;
      return { node, port: current.port };
    },
    recreate(sampleRate) {
      rate = sampleRate;
      frame = 0;
      clock.restartContext();
      current = spawn();
      cores++;
      const node = { connect() {}, disconnect() {} } as unknown as AudioWorkletNode;
      return { node, port: current.port };
    },
    trapNext() {
      trapPending = true;
    },
    stallMain() {
      const stall = { held: [] as unknown[], lastFrame: frame };
      stalled = stall;
      return {
        get held() {
          return stall.held.length;
        },
        get lastFrame() {
          return stall.lastFrame;
        },
        release() {
          if (stalled !== stall) return;
          stalled = null;
          for (const message of stall.held.splice(0)) current.port.onmessage?.({ data: message });
          flush();
        },
      };
    },
    watch() {
      const received: { frame: number; batch: PostedBatch }[] = [];
      watchers.add(received);
      return { take: () => received.splice(0), stop: () => void watchers.delete(received) };
    },
    send(buffer) {
      current.port.postMessage(buffer, [buffer]);
      flush();
    },
    renderQuanta(n) {
      const left = new Float32Array(n * QUANTUM_FRAMES);
      const right = new Float32Array(n * QUANTUM_FRAMES);
      for (let i = 0; i < n; i++) {
        const { driver } = current;
        driver.process(frame, clock.dateNow());
        left.set(driver.left, i * QUANTUM_FRAMES);
        right.set(driver.right, i * QUANTUM_FRAMES);
        frame += QUANTUM_FRAMES;
        clock.advance((QUANTUM_FRAMES / rate) * 1000);
        flush();
      }
      return { left, right };
    },
  };
}

// --- The loopback audio (ADR 0221) -------------------------------------------------------------------------------

/** What a loopback watch got: a BATCH or REPLAY posted to the shell, decoded, and the frame it was posted at. */
export interface LoopbackReceived {
  readonly frame: number;
  readonly batch: PostedBatch;
}

/** A main-thread stall on the loopback (`stallMain`). */
export interface LoopbackStall {
  /** Messages the shell sent main since the stall began. */
  readonly held: number;
  /** The frame the last of them arrived at (the stall's start before any). */
  readonly lastFrame: number;
  /** Main runs again: it handles what queued, in order. */
  release(): void;
}

/** The batches the loopback shell received since the watch began (or the last `take`). */
export interface LoopbackWatch {
  /** Takes the batches received so far, oldest first. */
  take(): LoopbackReceived[];
  /** Ends the watch. */
  stop(): void;
}

/** A clip `loopbackAudio` decodes: planar f32 at `sampleRate` (default 48 kHz). */
export interface LoopbackClip {
  readonly channelData: readonly Float32Array[];
  readonly sampleRate?: number;
}

/** What `loopbackAudio` builds. Every field is optional: the default is the project's default audio on the page mixer. */
export interface LoopbackAudioOptions {
  /** The audio settings (default `defaultAudioSettings()`); the mixer is configured with them and the host reconfigured from them. */
  readonly settings?: AudioSettings;
  /**
   * `"page"` (default): the page's mixer, configured with `settings`, and the backend registered with `setAudioBackend`, so the
   * public `Audio` / `Bus` / music API reach the core. `"own"`: a new `Mixer` the rig alone drives; nothing is registered.
   */
  readonly mixer?: "page" | "own";
  /** Overrides of the core's preset (`LOOPBACK_PRESET` underneath); the host and the core get the same one. */
  readonly preset?: Partial<CorePreset>;
  /** The injected clock (default a new `fakeHostClock()`); each rendered quantum advances it by 128 frames. */
  readonly clock?: FakeHostClock;
  /** Decodes a clip by path (default: one second of 0.5, mono at 48 kHz). The registry "fetches" the path's own bytes. */
  readonly decode?: (path: string) => LoopbackClip | Promise<LoopbackClip>;
  /** The backend's other dependencies (`createCoreBackend`'s: `hrir`, `magls`, `streams`, `zoneIr`, `warnOnce`, or `clips` to replace the registry). */
  readonly backend?: Omit<CoreBackendDeps, "mixer" | "clock">;
  /** Recovery's options (default: the fake clock's rAF time as its clock, `console.warn`). */
  readonly recovery?: RecoveryOptions;
  /** Whether one World holds a share of the host (default true), as while a scene with audio runs. */
  readonly world?: boolean;
  /** Quanta per main-thread frame in `step` (default 4). */
  readonly quantaPerFrame?: number;
  /** The `dt` (seconds) `step` hands `update` (default the frame's audio time). */
  readonly dt?: number;
}

/** The rendered audio, planar. */
export interface LoopbackOutput {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** The core on the loopback through the production assembly (`assembleCore`), and the controls a test has over it. */
export interface LoopbackAudio {
  /** The public audio API (`Audio`; `Audio.bus(name)`, `Audio.debug()`), over this backend when the rig is on the page mixer. */
  readonly Audio: typeof import("./Audio").Audio;
  /** The backend the assembly made: the `AudioBackend` the engine's callers use. */
  readonly backend: CoreBackend;
  /** The rig's mixer (the page's, or its own). */
  readonly mixer: Mixer;
  /** The production host over the loopback node (World shares, status, health). */
  readonly host: AudioHost;
  /** The host's link (ADR 0215: STATUS through `lastStatus` and `statusCount`). */
  readonly link: CoreLink;
  readonly clock: FakeHostClock;
  /** The first frame of the next quantum (0 again in each new context). */
  readonly frame: number;
  /** The current context's rate. */
  readonly sampleRate: number;
  /** The `dt` `step` hands `update`. */
  readonly dt: number;
  /** Renders `quanta` quanta with no main-thread frame. */
  render(quanta: number): LoopbackOutput;
  /**
   * `frames` main-thread frames (default 1), each `mixer.update`, `backend.update` and, on the page mixer, the event runtime's
   * `update`, then `quantaPerFrame` quanta and a few microtask turns. Returns what all of them rendered.
   */
  step(frames?: number): Promise<LoopbackOutput>;
  /** A few microtask turns (clip loads, the host's promises). */
  settle(): Promise<void>;
  /** Renders one quantum at a time, with microtask turns, until `promise` settles; throws after `maxQuanta` (default 2,000). */
  until<T>(promise: Promise<T>, maxQuanta?: number): Promise<T>;
  /** Fault: the next rendered quantum traps inside the core's render call, as a wasm trap does; the host's recovery rebuilds. */
  trap(): void;
  /** Fault: the output device changed to `rate`: the host rebuilds into a new context at that rate (`rebuildHost(host, "rate")`). */
  changeRate(rate: number): Promise<RebuildOutcome>;
  /** Fault: a rebuild for `reason` (a stall, a device change), as the background controller asks for one. */
  rebuild(reason: RebuildReason): Promise<RebuildOutcome>;
  /** Watches what reaches the core: every BATCH or REPLAY posted to the shell from now on, decoded, with its frame. */
  watch(): LoopbackWatch;
  /** Fault: a main-thread stall: what the core sends main queues until `release` (its STATUS pool runs out meanwhile). */
  stallMain(): LoopbackStall;
  /** Disposes the backend (unregistering it on the page mixer), closes the host and ends the audio session. A second call does nothing. */
  close(): Promise<void>;
}

/** Every loopback audio not yet closed (`closeLoopbackAudio`). */
const openLoopbacks = new Set<LoopbackAudio>();

/** Closes every `loopbackAudio` still open (an `afterEach`), then ends the audio session. */
export async function closeLoopbackAudio(): Promise<void> {
  for (const audio of [...openLoopbacks]) await audio.close();
  endAudioSession();
}

/** A fake AudioContext: state, rate, listeners and `statechange` fired by close, suspend and resume. */
function loopbackContext(rate: number) {
  const listeners = new Map<string, Set<() => void>>();
  const fire = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const ctx = {
    state: "running" as string,
    sampleRate: rate,
    destination: {},
    resume: () => {
      ctx.state = "running";
      fire("statechange");
      return Promise.resolve();
    },
    suspend: () => {
      ctx.state = "suspended";
      fire("statechange");
      return Promise.resolve();
    },
    close: () => {
      ctx.state = "closed";
      fire("statechange");
      return Promise.resolve();
    },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  return ctx;
}

const fakeNode = (): AudioWorkletNode => Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;

/** One second of 0.5, mono at 48 kHz. */
const defaultClip = (): LoopbackClip => ({ channelData: [new Float32Array(LOOPBACK_RATE).fill(0.5)] });

/**
 * ADR 0221: the audio core on the loopback, assembled as production assembles it (`core/assembly.ts` `assembleCore`, the
 * seam `service.ts` uses with the AudioWorklet host), over a real `AudioHost` whose node is the committed wasm run in
 * Node (`createLoopbackHost`). Like the service, it waits for the core's first ready STATUS before it makes the backend,
 * so a rig starts with the core running (6 quanta in). Resolves null when the wasm can't be loaded here (tests skip).
 * Close it, or call `closeLoopbackAudio` in an `afterEach`, so the host stops following the page's mixer.
 *
 * The one lower tier is `createLoopbackHost` itself, for the tests that check the wire bytes (ADR 0215: what is sent and
 * the STATUS blocks received) with no backend.
 */
export async function loopbackAudio(options: LoopbackAudioOptions = {}): Promise<LoopbackAudio | null> {
  const [{ assembleCore }, { AudioHost, presetFromSettings }, { Unlock }, { createClipRegistry }, { fakeDecoder }, { rebuildHost }, { setAudioBackend }, { Audio }, { events }] = await Promise.all([
    import("./core/assembly"),
    import("./core/context"),
    import("./core/unlock"),
    import("./core/clipRegistry"),
    import("./core/fakeDecoder"),
    import("./core/recovery"),
    import("./backend"),
    import("./Audio"),
    import("./events/eventRuntime"),
  ]);
  const settings = options.settings ?? defaultAudioSettings();
  const preset: CorePreset = { ...LOOPBACK_PRESET, ...options.preset };
  let loop: LoopbackHost;
  try {
    loop = await createLoopbackHost({ clock: options.clock, preset });
  } catch {
    return null;
  }
  const own = options.mixer === "own";
  const rigMixer = own ? new Mixer(settings) : mixer;
  if (!own) rigMixer.configure(settings);

  // The host's parts: a fake context per core context, a fake node, the unlock layer; the loopback serves respawn and recreate.
  const target = new EventTarget();
  let nextRate = LOOPBACK_RATE;
  const respawn = () => ({ node: fakeNode(), port: loop.respawn().port });
  const recreate = async () => {
    const context = loopbackContext(nextRate);
    const { port } = loop.recreate(nextRate);
    const unlock = new Unlock({ target, context: context as unknown as UnlockContext });
    return { context: context as unknown as AudioContext, node: fakeNode(), port, unlock, respawn };
  };
  const first = loopbackContext(LOOPBACK_RATE);
  const host = AudioHost._create({
    context: first as unknown as AudioContext,
    node: fakeNode(),
    link: loop.link,
    unlock: new Unlock({ target, context: first as unknown as UnlockContext }),
    preset: { ...presetFromSettings(settings), ...preset },
    respawn,
    recreate,
  });
  if (options.world !== false) host.attachWorld({ kind: "runtime" });

  const decode = options.decode ?? defaultClip;
  const link = loop.link;
  const clips =
    options.backend?.clips ??
    createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
      decodeWorker: fakeDecoder(async (bytes) => {
        const clip = await decode(new TextDecoder().decode(bytes));
        return { frames: clip.channelData[0]!.length, channels: clip.channelData.length, sampleRate: clip.sampleRate ?? LOOPBACK_RATE, channelData: clip.channelData };
      }),
      clipFormat: settings.clipFormat === "f32" ? 0 : 1,
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
    });
  const core = assembleCore(host, {
    ...options.backend,
    clips,
    mixer: rigMixer,
    clock: loop.clock,
    recovery: options.recovery ?? { now: () => loop.clock.rafTime() },
  });

  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  // As the service does: the backend is made once the core answered.
  for (let q = 0; link.readyState === "pending"; q++) {
    if (q >= 64) throw new Error("loopbackAudio: the core sent no ready STATUS");
    loop.renderQuanta(1);
  }
  await core.ready;
  const backend = core.createBackend();
  if (!own) {
    endAudioSession();
    setAudioBackend(backend);
  }

  const quantaPerFrame = options.quantaPerFrame ?? 4;
  const dtOf = () => options.dt ?? (quantaPerFrame * QUANTUM_FRAMES) / loop.sampleRate;
  let closed = false;
  const audio: LoopbackAudio = {
    Audio,
    backend,
    mixer: rigMixer,
    host,
    link,
    clock: loop.clock,
    get frame() {
      return loop.frame;
    },
    get sampleRate() {
      return loop.sampleRate;
    },
    get dt() {
      return dtOf();
    },
    render: (quanta) => loop.renderQuanta(quanta),
    async step(frames = 1) {
      const left = new Float32Array(frames * quantaPerFrame * QUANTUM_FRAMES);
      const right = new Float32Array(left.length);
      for (let f = 0; f < frames; f++) {
        const dt = dtOf();
        rigMixer.update(dt);
        backend.update(dt);
        if (!own) events().update(dt);
        const out = loop.renderQuanta(quantaPerFrame);
        left.set(out.left, f * out.left.length);
        right.set(out.right, f * out.right.length);
        await settle();
      }
      return { left, right };
    },
    settle,
    async until(promise, maxQuanta = 2_000) {
      let done = false;
      const result = promise.finally(() => {
        done = true;
      });
      await settle();
      for (let q = 0; !done; q++) {
        if (q >= maxQuanta) throw new Error(`loopbackAudio: still waiting after ${maxQuanta} quanta`);
        loop.renderQuanta(1);
        await settle();
      }
      return result;
    },
    trap: () => loop.trapNext(),
    changeRate(rate) {
      nextRate = rate;
      return rebuildHost(host, "rate");
    },
    rebuild: (reason) => rebuildHost(host, reason),
    watch: () => loop.watch(),
    stallMain: () => loop.stallMain(),
    async close() {
      if (closed) return;
      closed = true;
      openLoopbacks.delete(audio);
      if (own) backend.dispose();
      else setAudioBackend(null);
      await host.close();
      endAudioSession();
    },
  };
  openLoopbacks.add(audio);
  return audio;
}
