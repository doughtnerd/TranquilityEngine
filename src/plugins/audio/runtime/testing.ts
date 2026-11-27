// @internal test helpers for the audio plugin (api-and-models §6, "Fakes"). Contract K4 (coordinator, MS2 wave 2):
// the loopback host's signature. A1.7 owns this file; A1.4's loopback check runs on it at the wave review.
//
// `makeFakeBackend()` replaces the per-test fakes and the library mocks: an `AudioBackend` that records what the
// engine tells it. `createLoopbackHost()` runs the real committed wasm in Node with no AudioContext.
//
// ADR 0221: `loopbackAudio()` is the core as production assembles it (`core/assembly.ts`) over a real `AudioHost` on that
// loopback, with the public `Audio` on top and the faults a real host can see (a trap, a rate change, a rebuild, a main
// stall, a main-to-core hitch), and `startWorld` runs the real World service over it (ADR 0234). Rigs build on it;
// `createLoopbackHost()` stays the lower tier for tests of the wasm wire itself (bytes in, STATUS out, no backend).
//
// ADR 0234: `recordingAudio()` is the third adapter of the same assembly: a real `AudioHost` whose node runs no core. What
// main posts is recorded and read as `watch()` reads it, the test hands main its STATUS blocks, and the clock and the clips
// (`makeFakeClipRegistry()`) are the test's. The backend's wire-tier unit tests use it; none builds a `CoreBackend` by hand.
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
//
// ADR 0286: the fake's clock is one clock a test moves with one call (`advance(seconds)`, or `advanceTo(time)`), as
// `fakeHostClock` is: `time`, the rAF time `timeAt` maps from, `clock.horizon()` (the clock's `lookahead` ahead) and the
// frame map (once `startContext(rate)` gave it a context) are all read off it, so they never disagree. `time` is read-only.
//
// ADR 0264: a fake voice has every `AudioVoice` member, as every adapter's does: the stamped ramps (`fadeShaped`,
// `paramsShaped`) and `seek` are recorded as events, as asked. Whether ramps are sample-exact is the fake's
// `music.caps.stampedFades`.

import type { AudioEffectPlugins, AudioGenerators, EffectPluginModule } from "./backend";
import type { AudioBackend, AudioCaptureSource, AudioClipCache, AudioClock, AudioLiveMix, AudioMixCaps, AudioPanner, Attenuation, AudioVoice, FadeLaw, ListenerPose, MusicAdmitResult, MusicBackend, MusicBackendCaps, MusicGroupEvent, MusicGroupRequest, MusicGroupStamp, MusicLifecycleEvent, AudioOutputDevice, BackendKeyframe, MusicBackendDebug, PlayRequest, RecorderTap, VoiceSpatialOptions, ZoneIrService } from "./backend";
import type { AudioLatency } from "../../../engine/audio/musicTypes";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { CORE_LIVE_CAPS } from "../../../engine/audio/busCapability";
import type { ProfileSink } from "./mix/profileSink";
import { mixer, Mixer, type ResolvedBus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { AudioHost as CoreAudioHost, CoreLink, presetFromSettings as presetOf, type AudioHost, type LinkPort, type WorldShare } from "./core/context";
import type { HostClock } from "./core/hostClock";
import { CORE_ABI_VERSION, Kind, QUANTUM_FRAMES, readEnvelope, STATUS_BUFFER_BYTES, STATUS_FLAGS_READY, writeStatus, type StatusBlock } from "./wire.generated";
import { DEFAULT_LIMITER_LOOKAHEAD_MS, defaultAudioSettings, type AudioSettings } from "../../../engine/audio/settings";
import { CoreDriver, instantiateCore, type CoreInstance, type CorePreset } from "./worklet/coreDriver";
import { loadCoreWasm } from "./core/loader";
import { notifyEngineLifecycle } from "../../../engine/core/engineLifecycle";
import { batchRecords, type PostedBatch } from "./core/batchRecords";
import { batchRecorder, type BatchRecorder, type BatchWatch } from "./core/batchWatch";
import type { CoreBackend, CoreBackendDeps } from "./core/coreBackend";
import type { ClipInfo, ClipRegistry, ClipRegistryDeps, ClipResidentListener, ClipState } from "./core/clipRegistry";
import { rebuildHost, type RebuildOutcome, type RebuildReason, type RecoveryOptions } from "./core/recovery";
import { Unlock as CoreUnlock, type UnlockContext } from "./core/unlock";
import { assembleCore } from "./core/assembly";
import { setAudioBackend as registerBackend } from "./backend";
import { makeStatusBlock } from "./core/statusFixtures";
import { ListenerFrame } from "./core/spatial";
import { runAudioFrame, stepAudioFrame, type AudioFrameParts, type PlaylistFrame } from "./audioFrame";
import type { World } from "../../../engine/core/World";
import { DecoderWasm } from "./decoder/wasm";
import type { SpatialPrepare } from "./core/hrir";

/** ADR 0352: the plugin glue's control messages, which the loopback hands the shell as `processor.ts` does. */
const FX_CONTROLS: ReadonlySet<unknown> = new Set(["fxLoad", "fxUnload", "fxReset"]);

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
  // ADR 0362 §1: `at`, the heard time a stamped pause or resume was asked for.
  | { readonly kind: "pause"; readonly at?: number }
  | { readonly kind: "resume"; readonly at?: number }
  | { readonly kind: "stop"; readonly fadeSeconds?: number }
  | { readonly kind: "fade"; readonly to: number; readonly seconds: number }
  // ADR 0166 (G-1, §4.2), ADR 0264: the stamped ramps, as asked.
  | { readonly kind: "paramsShaped"; readonly gain?: number; readonly lowpassHz?: number; readonly seconds: number; readonly law?: FadeLaw; readonly at?: number }
  | { readonly kind: "fadeShaped"; readonly to: number; readonly seconds: number; readonly law: FadeLaw; readonly startPhase?: number; readonly at?: number; readonly stopAtEnd?: boolean }
  | { readonly kind: "seek"; readonly seconds: number }
  | { readonly kind: "priority"; readonly value: number }
  | { readonly kind: "loop"; readonly start: number; readonly end: number; readonly looping: boolean }
  // ADR 0162 (K0 members).
  | { readonly kind: "velocity"; readonly value: Vec3Like }
  | { readonly kind: "occlusion"; readonly gain: number; readonly lpHz: number }
  | { readonly kind: "doppler"; readonly factor: number }
  | { readonly kind: "spatialOptions"; readonly options: VoiceSpatialOptions }
  // ADR 0360 (G3): `generators.setParams` on this voice (parameters by catalogue index).
  | { readonly kind: "gen"; readonly params: ReadonlyMap<number, number>; readonly seconds: number };

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
const FAKE_EMPTY_KEYFRAME: BackendKeyframe = Object.freeze({
  voices: [], buses: [], metered: [], eventVoices: new Map<number, number>(),
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
  /** ADR 0286: the clock's heard time, seconds (read-only: `advance` or `advanceTo` moves it). */
  readonly time: number;
  /** ADR 0286: moves the clock on by `seconds`: `time`, the rAF time, the horizon and the frame map's time all follow. */
  advance(seconds: number): void;
  /** ADR 0286: moves the clock to heard time `time` (back too, when a test that shares the fake starts over). */
  advanceTo(time: number): void;
  /**
   * ADR 0158, 0286: how far `clock.horizon()` runs ahead of `time`, seconds; null (the default): no horizon, so callers
   * take their no-clock path (as on the Babylon fallback).
   */
  lookahead: number | null;
  /** ADR 0224, 0286: a (new) context at `rate` whose frame 0 is heard now: `clock.frameMap()` reports it from here on. */
  startContext(rate: number): void;
  /** ADR 0166 (G-1): what `clipFacts` reports per path; unlisted clips are unknown (undefined). */
  readonly facts: Map<string, { frames: number; rate: number; channels: number; gapless: boolean }>;

  /** ADR 0166 (G-1): what `clock.frameInterval()` returns, seconds; null (the default): unknown, so callers estimate it. */
  frameIntervalSeconds: number | null;

  // ADR 0166 (Q2): the music seam, so the P rows' loopback tests run on the fake.
  /** The fake's `MusicBackend`; set it to undefined for a backend without music. */
  music: FakeMusicBackend | undefined;
  /** ADR 0248: the output device (default undefined: none); a test sets one to report a sink or a device change. */
  device: AudioOutputDevice | undefined;
  /** `beginFrame` calls so far (the `engine.AudioMusic` safety net counts them). */
  beginFrameCalls: number;
  /** The rAF time (ms) `timeAt` maps to `time`: `timeAt(p) = time + (p - rafTime) / 1000`. 0 at time 0; moves with the clock. */
  readonly rafTime: number;
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

  // ADR 0352 §7: the fake records plugin effect registrations (set `effectPlugins` to undefined for a backend without them).
  effectPlugins: FakeEffectPlugins | undefined;

  /**
   * ADR 0360 (G3): generator voices. A generator play is recorded in `plays` like any (its `generator` holds the resolved
   * kind, values and seed); `setParams` is recorded on the voice as a `gen` event. Set it to undefined for a backend
   * without generators (the Babylon fallback).
   */
  generators: AudioGenerators | undefined;
}

/** ADR 0352 §7: the fake's plugin effect capability: it records each call and loads every module at once. */
export interface FakeEffectPlugins extends AudioEffectPlugins {
  /** Every module `register` was given, in order. */
  readonly registrations: EffectPluginModule[];
  /** Every `unregister` and `reset` argument, in order. */
  readonly unregistered: string[];
  readonly resets: string[];
}

function makeFakeEffectPlugins(): FakeEffectPlugins {
  const registrations: EffectPluginModule[] = [];
  const unregistered: string[] = [];
  const resets: string[] = [];
  const indices = new Map<string, number>();
  return {
    registrations,
    unregistered,
    resets,
    register(module) {
      registrations.push(module);
      const effects = module.effects.map((d) => {
        if (!indices.has(d.spec.type)) indices.set(d.spec.type, indices.size);
        return { type: d.spec.type, e: indices.get(d.spec.type)! };
      });
      return Promise.resolve({ ok: true, effects });
    },
    unregister(plugin) {
      unregistered.push(plugin);
    },
    reset(type) {
      resets.push(type);
    },
    health: () => [],
  };
}

/** A group the fake music backend holds: the latest request for its id and which members are primed. */
interface FakeGroup {
  request: MusicGroupRequest;
  primed: number;
}

/**
 * ADR 0166 (Q2): the fake's `MusicBackend`. It records every call; `admitGroup` answers `admitResult`; a primed group is
 * whatever the test said with `setPrimed`; `stampGroup` plays each member through the fake backend (`play`, with the
 * stamp's `at`), so the voices show in `voices`; `emit` delivers a group event to `onGroupEvent`, `report` a lifecycle
 * event to `onLifecycle` (ADR 0248: what the core reports of rebuilds, recoveries and the hidden tick).
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
  /** Test hook: deliver `e` to `onLifecycle`. */
  report(e: MusicLifecycleEvent): void;
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
    onLifecycle: null,
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
    report(e) {
      music.onLifecycle?.(e);
    },
    debugView(): MusicBackendDebug {
      const groupRows = [...groups].map(([id, g]) => {
        const of = g.request.members.length;
        return { id, state: "priming" as const, primed: Math.min(of, g.primed), of };
      });
      return {
        poolUsed: 0, poolSize: music.ringPool, poolHighWater: 0, musicRingRefused: 0, groupTableFull: 0, encodedOverBudget: 0,
        streamStartsLate: 0, groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0, voiceSplits: 0, curvePoolFull: 0,
        groups: groupRows,
      };
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
  // ADR 0286: the one clock. `time` and the rAF time move together; the frame map is a context started at `contextAt`.
  let time = 0;
  let rafMs = 0;
  let contextRate: number | null = null;
  let contextAt = 0;
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
    get time() {
      return time;
    },
    get rafTime() {
      return rafMs;
    },
    advance(seconds: number) {
      time += seconds;
      rafMs += seconds * 1000;
    },
    advanceTo(t: number) {
      backend.advance(t - time);
    },
    lookahead: null,
    startContext(rate: number) {
      contextRate = rate;
      contextAt = time;
    },
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
    facts: new Map(),
    frameIntervalSeconds: null,

    music: undefined,
    device: undefined,
    beginFrameCalls: 0,
    latencyValue: { base: 0, output: 0, limiter: 0, total: 0, reliable: false },
    beginFrame() { backend.beginFrameCalls++; },
    timeAt(performanceTime: number) { return time + (performanceTime - rafMs) / 1000; },
    latency() { return { ...backend.latencyValue }; },
    horizon() { return backend.lookahead === null ? null : time + backend.lookahead; },
    frameInterval() { return backend.frameIntervalSeconds; },
    frameMap() { return contextRate === null ? null : { sampleRate: contextRate, timeOffset: contextAt, carryPending: false }; },
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
    effectPlugins: makeFakeEffectPlugins(),
    generators: {
      setParams(voice, params, seconds) {
        const v = voices.find((x) => x === voice);
        if (v) (v.events as FakeVoiceEvent[]).push({ kind: "gen", params: new Map(params), seconds });
      },
    },
    mixOpTarget: { liveCaps: CORE_LIVE_CAPS, sendOp(op: MixOp) { backend.ops.push(op); return { ...backend.applyResult }; } },
    flushNow() { backend.flushes++; },
    setProfileSink(sink: ProfileSink | null) { backend.profileSink = sink; },
    keyframe() { return FAKE_EMPTY_KEYFRAME; },
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
      backend.durations.clear();
      backend.lookahead = null;
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
    fadeShaped(f) { events.push({ kind: "fadeShaped", ...f }); },
    seek(seconds) { events.push({ kind: "seek", seconds }); },
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
    pause(at) { state.paused = true; events.push(at === undefined ? { kind: "pause" } : { kind: "pause", at }); },
    resume(at) { state.paused = false; events.push(at === undefined ? { kind: "resume" } : { kind: "resume", at }); },
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
 * listener of the release forgets the project's audio state (the playlist runtime's instances and groups, the music players,
 * the files' loop points, the warn-once keys, the core fallback's warning, the capture). Call it between tests instead of
 * resetting modules by hand. Nothing else about an Engine happens (no mixer reconfigure), so a rig may call it at any point.
 */
export function endAudioSession(): void {
  notifyEngineLifecycle("disposed", "runtime");
}

// --- The loopback host ----------------------------------------------------------------------------------------

/**
 * The real wasm core run in Node with no AudioContext (architecture §4.6): the worklet side of the loopback. ADR 0221:
 * this is the one lower tier. Tests that read the wire itself (ADR 0215: the bytes `send` hands the shell, the STATUS
 * blocks in `statuses`, the shell's `driver`) use it directly; everything else uses `loopbackAudio`, which puts the
 * production `AudioHost` and the production assembly (`assembleCore`) on top of it.
 *
 * ADR 0223: the shell answers the link's controls as `worklet/processor.ts` does: `debugTone`, and `streamPort`
 * (`CoreLink.connectStreamPort`), whose port then carries the decoder worker's streams and zone kernels to the current
 * shell and its credits back, never through main. Nothing else reaches the shell's driver from outside.
 */
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
  /** The shell's driver: the STATUS pool, the probe. (Addition to K4.) */
  readonly driver: CoreDriver;
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
  /**
   * ADR 0221: a hitch between main and the core: from now until `stop`, each BATCH posted reaches the shell `quanta` quanta
   * later, in order (a later batch waits behind a held one, also after `stop`), as when a thread stalls after a frame
   * commits. Nothing tells the clock map; it learns of it from the next STATUS, as in a page.
   */
  delayBatches(quanta: number): { stop(): void };
  /** ADR 0221: watches what reaches the shell: every BATCH or REPLAY posted from now on, decoded, with the frame it was posted at. */
  watch(): LoopbackWatch;
}

/** The worklet's end of the decoder worker's channel, as `CoreLink.connectStreamPort` hands it over (a `MessagePort` in a page). */
export interface LoopbackStreamPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** The default preset: roomy enough for the §8 loopback cases. */
export const LOOPBACK_PRESET: CorePreset = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: DEFAULT_LIMITER_LOOKAHEAD_MS, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 };
/** The loopback rate (the shell's `sampleRate`). */
export const LOOPBACK_RATE = 48_000;


let decoderInProcess: Promise<DecoderWasm> | null = null;

/**
 * ADR 0331: the spatial assets' preparation in process, on the committed `myco_audio_decode.wasm` (Node only): what the
 * decoder worker runs for `DecoderClient.prepareSpatial`, for loaders (`createHrirLoader`, `createMaglsLoader`) and rigs
 * that have no worker.
 */
export function inProcessSpatialPrepare(): SpatialPrepare {
  const load = (decoderInProcess ??= (async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
    return DecoderWasm.load((await readFile(new URL("./wasm/myco_audio_decode.wasm", import.meta.url))) as Uint8Array<ArrayBuffer>);
  })());
  return async (kind, asset, rate) => {
    const decoder = await load;
    const bytes = new Uint8Array(asset);
    return (kind === "hrir" ? decoder.prepareHrir(bytes, rate) : decoder.prepareMagls(bytes, rate)).buffer as ArrayBuffer;
  };
}

/** Builds a loopback host on the committed wasm, with the given (or a new) fake clock and preset. */
export async function createLoopbackHost(options: { clock?: FakeHostClock; preset?: CorePreset; keepStatuses?: boolean } = {}): Promise<LoopbackHost> {
  // A variable specifier: the engine's declaration build (tsconfig.engine.json) has no Node types, and this file only runs in Node tests.
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
  // Through the page's loader, as the host loads it (so what asks the loaded core, the debug memory row, finds it).
  const readCore = (async (url: URL) => new Response((await readFile(url)) as Uint8Array<ArrayBuffer>)) as unknown as typeof fetch;
  const { module } = await loadCoreWasm(readCore);
  const clock = options.clock ?? fakeHostClock();
  const preset = options.preset ?? LOOPBACK_PRESET;

  let rate = LOOPBACK_RATE;
  /** The open `watch`es: each gets every BATCH or REPLAY posted to the shell, decoded. */
  const watchers = new Set<LoopbackReceived[]>();
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
    return { exports, memory: real.memory, sampleRate: real.sampleRate, plugins: real.plugins };
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
        if (message instanceof ArrayBuffer && (batchDelay !== null || heldBatches.length > 0) && isBatch(message)) {
          heldBatches.push({ message, due: Math.max(quanta + (batchDelay ?? 0), heldBatches.at(-1)?.due ?? 0) });
          return;
        }
        toWorklet.push(message);
      },
    };
    return { core, driver, toMain, toWorklet, port, streamPort: null as LoopbackStreamPort | null };
  };
  type Spawned = ReturnType<typeof spawn>;
  /**
   * `{type:"streamPort"}` (`CoreLink.connectStreamPort`), as `worklet/processor.ts`'s `connectStreams` does: the shell
   * takes the decoder worker's messages on that port at the current frame and posts its credits back on it. Bound to
   * the shell it reached; a new one replaces the old, and a respawned or recreated shell waits for its own.
   */
  const connectStreams = (shell: Spawned, port: LoopbackStreamPort): void => {
    if (shell.streamPort) shell.streamPort.onmessage = null;
    shell.streamPort = port;
    port.onmessage = (event) => shell.driver.onStreamMessage(event.data, frame, clock.dateNow());
    shell.driver.setStreamPost((message, transfer) => port.postMessage(message, transfer));
  };
  /** The old shell gets nothing more (as `retire` does in the worklet): its stream port goes quiet. */
  const retire = (shell: Spawned): void => {
    if (shell.streamPort) shell.streamPort.onmessage = null;
  };
  let current = spawn();
  let cores = 1;
  const link = new CoreLink(current.port);
  const statuses: StatusBlock[] = [];
  // `loopbackAudio` reads STATUS through its link and keeps none (a long soak would hold every block).
  if (options.keepStatuses !== false) link.onStatus((s) => statuses.push(s));
  let frame = 0;

  /** Quanta rendered so far, over every core (the `delayBatches` clock). */
  let quanta = 0;
  /** `delayBatches`: the delay in quanta while one is active, and the BATCHes held back with the quantum count each is due at. */
  let batchDelay: number | null = null;
  const heldBatches: { message: ArrayBuffer; due: number }[] = [];
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
        // ADR 0352: plugin modules for the glue; a load compiles asynchronously, and what it posts reaches main when it has.
        else if (FX_CONTROLS.has((message as { type?: unknown }).type)) void driver.onControl(message as never)?.then(flush);
        else if ((message as { type?: unknown }).type === "streamPort") connectStreams(current, (message as { port: LoopbackStreamPort }).port);
      }
    }
  };

  return {
    clock,
    link,
    get driver() {
      return current.driver;
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
      retire(current);
      current = spawn();
      cores++;
      const node = { connect() {}, disconnect() {} } as unknown as AudioWorkletNode;
      return { node, port: current.port };
    },
    recreate(sampleRate) {
      rate = sampleRate;
      frame = 0;
      clock.restartContext();
      retire(current);
      current = spawn();
      cores++;
      const node = { connect() {}, disconnect() {} } as unknown as AudioWorkletNode;
      return { node, port: current.port };
    },
    trapNext() {
      trapPending = true;
    },
    delayBatches(delay) {
      batchDelay = Math.max(0, Math.round(delay));
      return {
        stop: () => {
          batchDelay = null;
        },
      };
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
      const received: LoopbackReceived[] = [];
      watchers.add(received);
      const take = () => received.splice(0).map((r) => r.batch);
      return {
        takeReceived: () => received.splice(0),
        take,
        takeRecords: () => take().flatMap((b) => b.records),
        takeOps: (op) => take().flatMap((b) => b.records.filter((r) => r.opcode === op)),
        get pending() {
          return received.map((r) => r.batch);
        },
        stop: () => void watchers.delete(received),
      };
    },
    send(buffer) {
      current.port.postMessage(buffer, [buffer]);
      flush();
    },
    renderQuanta(n) {
      const left = new Float32Array(n * QUANTUM_FRAMES);
      const right = new Float32Array(n * QUANTUM_FRAMES);
      for (let i = 0; i < n; i++) {
        // Held BATCHes due by now reach the shell with this quantum's messages (after it renders), as a posted batch does.
        while (heldBatches.length > 0 && heldBatches[0]!.due <= quanta) current.toWorklet.push(heldBatches.shift()!.message);
        quanta++;
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

/**
 * What the loopback shell received since the watch began (or the last take): a `BatchWatch` (`take`, `takeRecords`,
 * `takeOps`, `pending`) read where the core receives the batches, plus each batch's arrival frame.
 */
export interface LoopbackWatch extends BatchWatch {
  /** Takes the batches received so far with the frame each arrived at, oldest first. */
  takeReceived(): LoopbackReceived[];
}

/** A clip `loopbackAudio` decodes: planar f32 at `sampleRate` (default 48 kHz). */
export interface LoopbackClip {
  readonly channelData: readonly Float32Array[];
  readonly sampleRate?: number;
}

/** What `loopbackAudio` builds. Every field is optional: the default is the project's default audio on the page mixer. */
export interface LoopbackAudioOptions {
  /**
   * The audio settings: the mixer is configured with them and the host reconfigured from them. Default: on the page's mixer,
   * the settings it has (an Engine's `create` configured it); on its own mixer, `defaultAudioSettings()`.
   */
  readonly settings?: AudioSettings;
  /**
   * `"page"` (default): the page's mixer, configured with `settings`, and the backend registered with `setAudioBackend`, so the
   * public `Audio` / `Bus` / music API reach the core. `"own"`: a new `Mixer` the rig alone drives; nothing is registered.
   */
  readonly mixer?: "page" | "own";
  /**
   * On the page's mixer, whether the rig registers the backend with `setAudioBackend` (default true). False leaves it to the
   * test, as the service leaves it to `registerCoreBackend` (the pending backend's hand-over).
   */
  readonly register?: boolean;
  /** Overrides of the core's preset (`LOOPBACK_PRESET` underneath); the host and the core get the same one. */
  readonly preset?: Partial<CorePreset>;
  /** The injected clock (default a new `fakeHostClock()`); each rendered quantum advances it by 128 frames. */
  readonly clock?: FakeHostClock;
  /** Decodes a clip by path (default: one second of 0.5, mono at 48 kHz). The registry "fetches" the path's own bytes. */
  readonly decode?: (path: string) => LoopbackClip | Promise<LoopbackClip>;
  /** Parts of the rig's clip registry to replace instead (a real decoder client and its fetch, a warning spy). */
  readonly clipRegistry?: Partial<Pick<ClipRegistryDeps, "fetchBytes" | "decodeWorker" | "warn" | "nextQuantum" | "packRef">>;
  /**
   * The backend's other dependencies (`createCoreBackend`'s: `hrir`, `magls`, `streams`, `zoneIr`, `warnOnce`, or `clips` to
   * replace the registry), or a function of the rig's clip registry that gives them (an HRIR loader on it).
   */
  readonly backend?: LoopbackBackendDeps | ((clips: ClipRegistry) => LoopbackBackendDeps);
  /** Recovery's options (default: the fake clock's rAF time as its clock, `console.warn`). */
  readonly recovery?: RecoveryOptions;
  /** Whether one World holds a share of the host (default true), as while a scene with audio runs. */
  readonly world?: boolean;
  /** Whether `watched` watches what reaches the core from before the backend is made (its first BUS_CONFIG, ...); default false. */
  readonly watchFromStart?: boolean;
  /** Quanta per main-thread frame in `step` (default 4). */
  readonly quantaPerFrame?: number;
  /** The `dt` (seconds) `step` hands the frame (default the frame's audio time). */
  readonly dt?: number;
  /**
   * ADR 0223: another thread's turn after each rendered quantum (`render`, `step`, `until`): a decoder worker in process
   * delivering what it and the worklet posted on their channel, as their own thread would between render calls.
   */
  readonly eachQuantum?: () => void;
}

/** The backend dependencies a loopback rig may set (the rest are the rig's). */
export type LoopbackBackendDeps = Omit<CoreBackendDeps, "mixer" | "clock">;

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
  /** The `dt` `step` hands the frame. */
  readonly dt: number;
  /** Renders `quanta` quanta with no main-thread frame. */
  render(quanta: number): LoopbackOutput;
  /**
   * ADR 0270: the backend's frame alone (`runAudioFrame`: every stage and main's passes), with the rig's listener frame (no
   * World, no listener) and its mixer's settings; `dt` defaults to `dt`. Nothing else: no `mixer.update`, no playlists, no
   * render. A test that drives the mixer itself uses it; one that wants the game's frame uses `mainFrame`.
   */
  tick(dt?: number): void;
  /**
   * ADR 0434: one main-thread audio frame as the audio system runs it (`stepAudioFrame`: `mixer.update`, `tick`, then, on the
   * page mixer, the playlist runtime), with no render; `dt` defaults to `dt`.
   */
  mainFrame(dt?: number): void;
  /**
   * `frames` main-thread frames (default 1), each `mainFrame`, then `quantaPerFrame` quanta and a few microtask turns.
   * Returns what all of them rendered.
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
  /** With `watchFromStart`, the watch begun before the backend was made; else null. */
  readonly watched: LoopbackWatch | null;
  /** Fault: a main-thread stall: what the core sends main queues until `release` (its STATUS pool runs out meanwhile). */
  stallMain(): LoopbackStall;
  /** Fault: a hitch between main and the core: BATCHes posted until `stop` reach the core `quanta` quanta late (`LoopbackHost.delayBatches`). */
  delayBatches(quanta: number): { stop(): void };
  /**
   * ADR 0234: starts the real `myco.audio` World service in `world`, over this rig's host, and resolves the World's key (its
   * share). The service's own `load` hands over the page's host, so the first call makes this rig's host the page's
   * (`acquireAudioHost`, as the service's start would) and registers the service again (the plugin set with audio off, then
   * on), since a registration loads once. Any number of Worlds may start after it; each needs a view (`render`), as the
   * service's `runsIn` asks, and the page mixer's `audio.backend` must be "core". Nothing is mocked.
   */
  startWorld(world: World): Promise<number>;
  /** Disposes the backend (unregistering it on the page mixer), closes the host and ends the audio session. A second call does nothing. */
  close(): Promise<void>;
}

/** A rig's two frame entries over one listener frame of its own (no World and no listener: the listener-bound passes are inert). */
function frameDriver(backend: AudioBackend, mixer: Mixer, playlists: PlaylistFrame | null) {
  const parts: AudioFrameParts = { mixer, playlists, backend, frame: new ListenerFrame() };
  return {
    /** ADR 0434: the main-thread audio frame (`stepAudioFrame`: `mixer.update`, the backend frame, the playlists). */
    frame(dt: number): void {
      parts.frame.set(null, 0, null, null, dt);
      stepAudioFrame(parts, dt);
    },
    /** ADR 0270: the backend frame alone (`runAudioFrame`), for a test that drives the mixer itself. */
    tick(dt: number): void {
      parts.frame.set(null, 0, null, null, dt);
      runAudioFrame(backend, parts.frame, dt, mixer.audioSettings);
    },
  };
}

/**
 * ADR 0434: drives `backend` one main-thread frame at a time as the audio system does (`stepAudioFrame`: `mixer.update`, the
 * backend frame of ADR 0270 with every stage and main's passes, then `playlists` when given), with a listener frame of its
 * own (no World and no listener, so the listener-bound passes are inert). No render. A test that builds its own host over
 * `createLoopbackHost` uses it; the rigs' `mainFrame` is the same step.
 */
export function audioFrameDriver(backend: AudioBackend, mixer: Mixer, playlists: PlaylistFrame | null = null): (dt: number) => void {
  return frameDriver(backend, mixer, playlists).frame;
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

/** Whether a message is a BATCH (its envelope's kind). */
const isBatch = (message: ArrayBuffer): boolean => message.byteLength >= 8 && readEnvelope(new DataView(message), 0).kind === Kind.BATCH;

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
  const [{ assembleCore }, { AudioHost, presetFromSettings }, { Unlock }, { createClipRegistry }, { fakeDecoder }, { rebuildHost }, { setAudioBackend }, { Audio }, { playlistHost }] = await Promise.all([
    import("./core/assembly"),
    import("./core/context"),
    import("./core/unlock"),
    import("./core/clipRegistry"),
    import("./core/fakeDecoder"),
    import("./core/recovery"),
    import("./backend"),
    import("./Audio"),
    import("./playlists/host"),
  ]);
  const own = options.mixer === "own";
  // On the page's mixer without `settings`, whatever configured it (an Engine's create) stands.
  const settings = options.settings ?? (own ? defaultAudioSettings() : mixer.audioSettings);
  const preset: CorePreset = { ...LOOPBACK_PRESET, ...options.preset };
  let loop: LoopbackHost;
  try {
    loop = await createLoopbackHost({ clock: options.clock, preset, keepStatuses: false });
  } catch (error) {
    // Only a wasm that isn't there (or doesn't compile) here skips; a preset the core refuses is the test's error.
    if ((error as { code?: string }).code === "ENOENT" || error instanceof WebAssembly.CompileError) return null;
    throw error;
  }
  const rigMixer = own ? new Mixer(settings) : mixer;
  if (!own && options.settings) rigMixer.configure(settings);

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
    // The host's clock is the rig's: it moves only as the rig renders (or the test advances it), as a page's moves with
    // its audio. The background controller's stall check reads it, so a test idling between renders sees no stall, while
    // rendering a second with no STATUS reaching main is one, as in a page.
    now: () => loop.clock.rafTime(),
  });
  if (options.world !== false) host.attachWorld({ kind: "runtime" });

  const decode = options.decode ?? defaultClip;
  const link = loop.link;
  const given = typeof options.backend === "function" ? undefined : options.backend;
  const clips =
    given?.clips ??
    createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
      decodeWorker: fakeDecoder(async (bytes) => {
        const clip = await decode(new TextDecoder().decode(bytes));
        return { frames: clip.channelData[0]!.length, channels: clip.channelData.length, sampleRate: clip.sampleRate ?? LOOPBACK_RATE, channelData: clip.channelData };
      }),
      clipFormat: settings.clipFormat === "f32" ? 0 : 1,
      // As `createCoreBackend`'s registry: `audio.codecs.aac`.
      aac: settings.codecs?.aac === true,
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
      ...options.clipRegistry,
    });
  const core = assembleCore(host, {
    ...(typeof options.backend === "function" ? options.backend(clips) : given),
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
  const watched = options.watchFromStart ? loop.watch() : null;
  const backend = core.createBackend();
  const registered = !own && options.register !== false;
  if (registered) {
    endAudioSession();
    setAudioBackend(backend);
  }

  const eachQuantum = options.eachQuantum;
  /** `n` quanta, with the other thread's turn after each when there is one. */
  const renderQuanta = (n: number): LoopbackOutput => {
    if (!eachQuantum) return loop.renderQuanta(n);
    const left = new Float32Array(n * QUANTUM_FRAMES);
    const right = new Float32Array(left.length);
    for (let q = 0; q < n; q++) {
      const out = loop.renderQuanta(1);
      left.set(out.left, q * QUANTUM_FRAMES);
      right.set(out.right, q * QUANTUM_FRAMES);
      eachQuantum();
    }
    return { left, right };
  };
  const quantaPerFrame = options.quantaPerFrame ?? 4;
  const dtOf = () => options.dt ?? (quantaPerFrame * QUANTUM_FRAMES) / loop.sampleRate;
  // ADR 0434: on the page's mixer the playlist runtime runs in the frame, as in a game; a rig on its own mixer has none.
  const driver = frameDriver(backend, rigMixer, own ? null : { update: (dt) => playlistHost().update(dt) });
  let closed = false;
  /** Whether this rig's host is the page's and the World service was registered again to load it (`startWorld`). */
  let servesWorlds = false;
  const startWorld = async (world: World): Promise<number> => {
    const [{ acquireAudioHost }, { AUDIO }, { _startWorldService }, { applyTestPlugins }] = await Promise.all([
      import("./core/context"),
      import("./core/service"),
      import("../../../engine/core/worldServices"),
      import("../../testPlugins"),
    ]);
    if (!servesWorlds) {
      if ((await acquireAudioHost(async () => host)) !== host) throw new Error("loopbackAudio: another audio host is the page's");
      applyTestPlugins(["myco.audio"]);
      applyTestPlugins();
      servesWorlds = true;
    }
    const service = (await _startWorldService(world, AUDIO)) as import("./core/service").AudioWorldService | null;
    if (!service || service.key === 0) throw new Error(`loopbackAudio: the World took no share of the host (no view, or audio.backend is "${mixer.audioSettings.backend}")`);
    return service.key;
  };
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
    render: (quanta) => renderQuanta(quanta),
    tick: (dt = dtOf()) => driver.tick(dt),
    mainFrame: (dt = dtOf()) => driver.frame(dt),
    async step(frames = 1) {
      const left = new Float32Array(frames * quantaPerFrame * QUANTUM_FRAMES);
      const right = new Float32Array(left.length);
      for (let f = 0; f < frames; f++) {
        driver.frame(dtOf());
        const out = renderQuanta(quantaPerFrame);
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
        renderQuanta(1);
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
    watched,
    stallMain: () => loop.stallMain(),
    delayBatches: (quanta) => loop.delayBatches(quanta),
    startWorld,
    async close() {
      if (closed) return;
      closed = true;
      openLoopbacks.delete(audio);
      if (registered) setAudioBackend(null);
      backend.dispose();
      await host.close();
      endAudioSession();
    },
  };
  openLoopbacks.add(audio);
  return audio;
}

// --- The fake clip registry (ADR 0234) ---------------------------------------------------------------------------------

/** A `ClipRegistry` a test drives: what was acquired and released, each clip's state, the clip events STATUS brought. */
export interface FakeClipRegistry extends ClipRegistry {
  /** Each path acquired, with its id (1, 2, ... in order). */
  readonly ids: Map<string, number>;
  /** Each id's state (a new path starts in the registry's `state`, default "ready"); set one to change what plays see. */
  readonly states: Map<number, ClipState>;
  /** Each id's references (acquires less releases). */
  readonly refs: Map<number, number>;
  /** Every `applyClipEvent` (the STATUS mirror's clip events), as `[id, code]`. */
  readonly events: [number, number][];
  /** What `residentIds` answers (a rebuild's re-send, the idle reset's check); default none. */
  resident: number[];
  /** Moves `id` to `state` and calls its `onResident` listeners once, as a load that finished (or failed) does. */
  settle(id: number, state: ClipState): void;
}

/**
 * ADR 0234: the recording host's clip registry (no fetch, no decode, no core): every path gets an id, starting in
 * `options.state` ("ready" by default, so plays start at once); `settle` finishes a load by hand. `options.info` adds to
 * the `ClipInfo` it reports for a path (its channels, its frames).
 */
export function makeFakeClipRegistry(options: { state?: ClipState; info?: (path: string) => Partial<ClipInfo> } = {}): FakeClipRegistry {
  const ids = new Map<string, number>();
  const states = new Map<number, ClipState>();
  const refs = new Map<number, number>();
  const listeners = new Map<number, ClipResidentListener[]>();
  const pathOf = (id: number): string => [...ids].find(([, v]) => v === id)?.[0] ?? "";
  let next = 1;
  const registry: FakeClipRegistry = {
    ids,
    states,
    refs,
    events: [],
    resident: [],
    acquire(path) {
      let id = ids.get(path);
      if (id === undefined) {
        id = next++;
        ids.set(path, id);
        states.set(id, options.state ?? "ready");
      }
      refs.set(id, (refs.get(id) ?? 0) + 1);
      return id;
    },
    release(id) {
      refs.set(id, (refs.get(id) ?? 0) - 1);
    },
    state: (id) => states.get(id) ?? "idle",
    info(id) {
      const path = pathOf(id);
      return { id, path, state: registry.state(id), refs: refs.get(id) ?? 0, frames: 0, channels: 1, sampleRate: LOOPBACK_RATE, format: 1, bytes: 0, failure: null, ...options.info?.(path) };
    },
    onResident(id, listener) {
      const list = listeners.get(id) ?? [];
      list.push(listener);
      listeners.set(id, list);
      return () => {
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
      };
    },
    releaseWorld() {},
    acquireReserved() {},
    applyClipEvent(id, code) {
      registry.events.push([id, code]);
    },
    residentIds: () => registry.resident,
    settle(id, state) {
      states.set(id, state);
      const list = listeners.get(id) ?? [];
      listeners.delete(id);
      for (const l of list) l(registry.info(id)!);
    },
  };
  return registry;
}

// --- The recording host (ADR 0234) -------------------------------------------------------------------------------------

/** How a core the recording host makes in a rebuild answers: its first ready STATUS, a shell error, or nothing. */
export type RecordingNewCore = "answers" | "fails" | "silent";

/** What `recordingAudio` builds. Every field is optional; the defaults are `loopbackAudio`'s where it has one. */
export interface RecordingAudioOptions<C extends ClipRegistry = FakeClipRegistry> {
  /** The audio settings (as `loopbackAudio`'s): the mixer is configured with them and the host from them. */
  readonly settings?: AudioSettings;
  /** `"page"` (default): the page's mixer, and the backend registered with `setAudioBackend` (unless `register` is false). `"own"`: a new `Mixer`. */
  readonly mixer?: "page" | "own";
  /** On the page's mixer, whether the rig registers the backend (default true). */
  readonly register?: boolean;
  /** Overrides of the preset (`LOOPBACK_PRESET` underneath) the host reports: `maxLogical`, `maxBeds`, `maxMusicRings`, the limiter look-ahead. */
  readonly preset?: Partial<CorePreset>;
  /** The injected clock (default a new `fakeHostClock()`); `frame` advances it. */
  readonly clock?: FakeHostClock;
  /** The clip registry (default `makeFakeClipRegistry()`). */
  readonly clips?: C;
  /** The backend's other dependencies (`hrir`, `magls`, `streams`, `zoneIr`, `warnOnce`). */
  readonly backend?: Omit<LoopbackBackendDeps, "clips">;
  /** Recovery's options (default: the fake clock's rAF time as its clock). */
  readonly recovery?: RecoveryOptions;
  /** Whether one World holds a share (default true; `share` is it). */
  readonly world?: boolean;
  /** The context's `baseLatency` and `outputLatency`, seconds (default none: the host reads 0). */
  readonly latency?: { readonly base: number; readonly output: number };
}

/**
 * ADR 0234: the third adapter of `assembleCore`. A real `AudioHost` whose node runs no core: everything main posts to the
 * link is recorded (BATCH and REPLAY decoded, read as `loopbackAudio().watch()` reads them), BATCH buffers go back to the
 * link's pool as the shell returns them, and the test plays the core's part: `status` hands main a STATUS block, and the
 * cores a rebuild makes answer as told. The clock and the clips are the test's (`clock`, `clips`). For the backend's own
 * logic at the wire: what it sends for a call, a STATUS or a lifecycle event, with no wasm.
 */
export interface RecordingAudio<C extends ClipRegistry = FakeClipRegistry> {
  /** The backend the assembly made. */
  readonly backend: CoreBackend;
  readonly mixer: Mixer;
  /** The production host over the recording node: World shares (`attachWorld`, `releaseWorld`), its context (`suspend`, `resume`, `close`), status. */
  readonly host: AudioHost;
  readonly link: CoreLink;
  readonly clock: FakeHostClock;
  readonly clips: C;
  /** The World share the rig took (`world`), or null. */
  readonly share: WorldShare | null;
  /** Every BATCH and REPLAY posted from before the backend was made, decoded (a `BatchWatch`: `take`, `takeRecords`, `takeOps`, `pending`). */
  readonly posted: BatchWatch;
  /** Another watch, from now on. */
  watch(): BatchWatch;
  /** The core's STATUS reaching main: a block with every field 0 but `fields` (`makeStatusBlock`), through the link as the port delivers it. */
  status(fields?: Partial<StatusBlock>): void;
  /** ADR 0270: the backend's frame alone (`runAudioFrame`, as `loopbackAudio`'s `tick`); the clock stays. */
  tick(dt: number): void;
  /** One main-thread frame: the clock moves `dt` seconds (default 0.016), then `tick(dt)`. */
  frame(dt?: number): void;
  /**
   * The context stops and only a user gesture resumes it (an interruption, or autoplay): the host reads "locked", and the
   * page's own resumes (the background controller's) do nothing until `gesture()`.
   */
  lock(): void;
  /** A user gesture (a pointerdown on the page): the host's unlock layer resumes the context, which then runs. */
  gesture(): void;
  /** How the next core a rebuild makes answers once main listens (default "answers"; a microtask after the rebind). */
  newCore: RecordingNewCore;
  /** A rebuild for `reason` (default "trap"), as recovery runs one (`rebuildHost`): `onRebuildStart` has run when this returns, `onRebuilt` once it resolves. */
  rebuild(reason?: RebuildReason): Promise<RebuildOutcome>;
  /** A rate rebuild into a new context at `rate` (`onContextReplaced(rate)`); the clock's context time starts again at 0. */
  changeRate(rate: number): Promise<RebuildOutcome>;
  /** A few microtask turns. */
  settle(): Promise<void>;
  /** Disposes the backend (unregistering it on the page mixer), closes the host and ends the audio session. A second call does nothing. */
  close(): Promise<void>;
}

/** Every recording audio not yet closed (`closeRecordingAudio`). */
const openRecordings = new Set<{ close(): Promise<void> }>();

/** Closes every `recordingAudio` still open (an `afterEach`), then ends the audio session. */
export async function closeRecordingAudio(): Promise<void> {
  for (const audio of [...openRecordings]) await audio.close();
  endAudioSession();
}

/** A STATUS buffer as the shell posts it. */
function statusBuffer(fields: Partial<StatusBlock>): ArrayBuffer {
  const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
  writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
  return buffer;
}

/** The first STATUS of a core that started: the ready flag and this ABI. */
const readyStatus = (): ArrayBuffer => statusBuffer({ flags: STATUS_FLAGS_READY, abiVersion: CORE_ABI_VERSION });

/**
 * ADR 0234: the core backend as production assembles it (`assembleCore`) over a recording host: no wasm, no core, no
 * audio. Synchronous: the host's first core answers at once, and the backend is made as the service makes it, once the
 * core answered. Close it, or call `closeRecordingAudio` in an `afterEach`.
 */
export function recordingAudio<C extends ClipRegistry = FakeClipRegistry>(options: RecordingAudioOptions<C> = {}): RecordingAudio<C> {
  const own = options.mixer === "own";
  const settings = options.settings ?? (own ? defaultAudioSettings() : mixer.audioSettings);
  const rigMixer = own ? new Mixer(settings) : mixer;
  if (!own && options.settings) rigMixer.configure(settings);
  const clock = options.clock ?? fakeHostClock();
  const clips = (options.clips ?? makeFakeClipRegistry()) as C;
  const recorders = new Set<BatchRecorder>();
  let newCore: RecordingNewCore = "answers";

  /** The current node's port: records what main posts, returns BATCH buffers, and answers once main listens (a rebuild's core). */
  let current: LinkPort | null = null;
  const recordingPort = (answer: RecordingNewCore | null): LinkPort => {
    let handler: ((event: { data: unknown }) => void) | null = null;
    const port: LinkPort = {
      get onmessage() {
        return handler;
      },
      set onmessage(listener) {
        handler = listener;
        if (!listener || answer === null) return;
        const how = answer;
        answer = null;
        // After the rebind, as a new core's first message arrives (`onContextReplaced` has run by then).
        queueMicrotask(() => {
          if (current !== port || how === "silent") return;
          handler?.({ data: how === "answers" ? readyStatus() : { type: "error", message: "the new core failed to start" } });
        });
      },
      postMessage(message) {
        if (current !== port || !(message instanceof ArrayBuffer)) return;
        for (const r of recorders) r.receive(message);
        // The shell returns each BATCH buffer to the link's pool (a STATUS's RECYCLE stays with the shell).
        if (message.byteLength >= 8 && readEnvelope(new DataView(message), 0).kind === Kind.BATCH) handler?.({ data: message });
      },
    };
    return port;
  };
  const deliver = (message: unknown): void => current?.onmessage?.({ data: message });

  const target = new EventTarget();
  /** Autoplay's rule (`lock`): a blocked context resumes only inside a gesture, and a gesture's resume lifts the block. */
  const gate = { blocked: false, inGesture: false };
  let nextRate = LOOPBACK_RATE;
  const respawn = () => {
    current = recordingPort(newCore);
    return { node: fakeNode(), port: current };
  };
  const recordingContext = (rate: number) => {
    const context = loopbackContext(rate);
    const resume = context.resume;
    return Object.assign(context, {
      baseLatency: options.latency?.base ?? 0,
      outputLatency: options.latency?.output ?? 0,
      getOutputTimestamp: () => clock.outputTimestamp() ?? { contextTime: 0, performanceTime: 0 },
      resume: (): Promise<void> => {
        if (gate.blocked && !gate.inGesture) return Promise.resolve();
        gate.blocked = false;
        return resume();
      },
    });
  };
  const recreate = async () => {
    const context = recordingContext(nextRate);
    clock.restartContext();
    const { port } = respawn();
    const unlock = new CoreUnlock({ target, context: context as unknown as UnlockContext });
    return { context: context as unknown as AudioContext, node: fakeNode(), port, unlock, respawn };
  };
  const first = recordingContext(LOOPBACK_RATE);
  current = recordingPort(null);
  const link = new CoreLink(current);
  const host = CoreAudioHost._create({
    context: first as unknown as AudioContext,
    node: fakeNode(),
    link,
    unlock: new CoreUnlock({ target, context: first as unknown as UnlockContext }),
    preset: { ...presetOf(settings), ...LOOPBACK_PRESET, ...options.preset },
    respawn,
    recreate,
  });
  const share = options.world !== false ? host.attachWorld({ kind: "runtime" }) : null;
  const posted = batchRecorder();
  recorders.add(posted);
  const core = assembleCore(host, {
    ...options.backend,
    clips,
    mixer: rigMixer,
    clock,
    recovery: options.recovery ?? { now: () => clock.rafTime() },
  });
  // As the service does: the backend is made once the core answered.
  deliver(readyStatus());
  if (link.readyState !== "ready") throw new Error("recordingAudio: the core did not start");
  const backend = core.createBackend();
  const registered = !own && options.register !== false;
  if (registered) {
    endAudioSession();
    registerBackend(backend);
  }
  const { tick } = frameDriver(backend, rigMixer, null);
  let closed = false;
  const rig: RecordingAudio<C> = {
    backend,
    mixer: rigMixer,
    host,
    link,
    clock,
    clips,
    share,
    posted,
    get newCore() {
      return newCore;
    },
    set newCore(how) {
      newCore = how;
    },
    watch() {
      const watch = batchRecorder();
      recorders.add(watch);
      return {
        take: watch.take,
        takeRecords: watch.takeRecords,
        takeOps: watch.takeOps,
        get pending() {
          return watch.pending;
        },
        stop: () => {
          watch.stop();
          recorders.delete(watch);
        },
      };
    },
    status: (fields = {}) => deliver(statusBuffer(fields)),
    tick,
    frame(dt = 0.016) {
      clock.advance(dt * 1000);
      tick(dt);
    },
    lock() {
      gate.blocked = true;
      void host.context.suspend();
    },
    gesture() {
      gate.inGesture = true;
      try {
        target.dispatchEvent(new Event("pointerdown"));
      } finally {
        gate.inGesture = false;
      }
    },
    rebuild: (reason = "trap") => rebuildHost(host, reason),
    changeRate(rate) {
      nextRate = rate;
      return rebuildHost(host, "rate");
    },
    async settle() {
      for (let k = 0; k < 8; k++) await Promise.resolve();
    },
    async close() {
      if (closed) return;
      closed = true;
      openRecordings.delete(rig);
      if (registered) registerBackend(null);
      backend.dispose();
      await host.close();
      endAudioSession();
    },
  };
  openRecordings.add(rig);
  return rig;
}
