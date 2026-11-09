/**
 * The `"babylon"` audio backend (ADR 0157 BB1; ADR 0098): Babylon's AudioEngineV2 behind the internal `AudioBackend`
 * interface. It is the fallback for engines that can't load the core, and what `audio.backend: "babylon"` selects.
 *
 * - The engine is created lazily, on the first play, on a shared `AudioContext`, with Babylon's own resume-on-interaction,
 *   resume-on-pause and unmute UI off: the host's unlock layer stays in charge (architecture 2.1). If a core `AudioHost`
 *   exists (a core load failed after the host started) its context is reused; otherwise this backend makes the page's one
 *   context and arms the `Unlock` layer on it.
 * - Mixer buses are Babylon `AudioBus`es (parent through `outBus`); `applyMix` sets each bus's volume to its resolved gain.
 *   Effects (reverb, filters, compressor) are core-only, and so are priority, stealing by priority and virtual voices.
 * - A sound is one `StaticSound` (decoded once per URL, shared by every voice) or, for `stream` clips, one `StreamingSound`.
 *   `play` is synchronous but creating the sound is not, so the voice returned records its setters and applies them when
 *   the sound is ready (the pattern of `PendingVoice` in `backend.ts`).
 * - `maxVoices` maps to a cap on live voices per bus (the oldest is stopped), and to each sound's `maxInstances`.
 *
 * Babylon is imported module by module and only when a sound first plays, so servers and tests that never play don't load it.
 * Nothing of Babylon appears outside this file (ADR 0010).
 */
import type { AudioParameterRampShape } from "@babylonjs/core/AudioV2/audioParameter";
import type { AudioBus, PrimaryAudioBus } from "@babylonjs/core/AudioV2/abstractAudio/audioBus";
import type { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { StaticSound } from "@babylonjs/core/AudioV2/abstractAudio/staticSound";
import type { StaticSoundBuffer } from "@babylonjs/core/AudioV2/abstractAudio/staticSoundBuffer";
import type { StreamingSound } from "@babylonjs/core/AudioV2/abstractAudio/streamingSound";
import type { Vec3Like } from "../../../engine/core/math";
import type { Mixer, ResolvedBus } from "../../../engine/audio/mixer";
import { mixer, registerDefaultBackend, resolveBackendKind, type AudioBackend, type AudioBackground, type AudioDebugInfo, type AudioReason, type AudioStatus, type AudioVoice, type Attenuation, type ListenerPose, type PlayRequest } from "./backend";
import { busCreationSteps, listenerQuaternion, planBuses, playbackRate, soundVolume, spatialParams, spatialSoundOptions, type BusPlan } from "./babylonMapping";
import { Unlock, type UnlockContext } from "./core/unlock";

/** What a test (or an unusual host) can replace. */
export interface BabylonBackendOptions {
  /** The core host's context, if one exists. Default: when `audio.backend` is "core", the page's `AudioHost` context. */
  hostContext?: () => AudioContext | null | Promise<AudioContext | null>;
  /** Makes the page's context when there is no host. Default: `new AudioContext()`. */
  createContext?: () => AudioContext;
  /** Where the unlock layer listens for the first gesture. Default: `document` (none outside a browser). */
  unlockTarget?: EventTarget | null;
}

type Sound = StaticSound | StreamingSound;

/** The engine and what hangs off it, once created. */
interface Live {
  readonly engine: AudioEngineV2;
  readonly main: PrimaryAudioBus;
  /** One `AudioBus` per mixer bus (rebuilt by `configureBuses`). */
  buses: Map<string, AudioBus>;
  plan: BusPlan[];
  /** Unknown bus names play on this one: the first root, else the main bus. */
  rootName: string | null;
  /** Decoded clips by URL, so repeated one-shots don't refetch. */
  readonly buffers: Map<string, Promise<StaticSoundBuffer>>;
}

const RAMP = "linear" as AudioParameterRampShape;
let nextVoiceId = 1;

class BabylonVoice implements AudioVoice {
  readonly id = nextVoiceId++;
  /** The fallback has no stealing, virtual or locked voices (api-and-models 1 "Fallback backend"); only a failed load shows. */
  reason: AudioReason | null = null;
  private ended = false;
  private bus: string;
  private volume: number;
  /** The fade's target gain, and the gain the sound has now (they differ until `applyVolume` runs). */
  private gain = 1;
  private appliedGain = 1;
  private rampSeconds = 0;
  private pitch: number;
  private attenuation: Attenuation | null;
  private position: Vec3Like | null;
  private paused = false;
  private started = false;
  private sound: Sound | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly backend: BabylonBackend, private readonly req: PlayRequest) {
    this.bus = req.bus;
    this.volume = req.volume ?? 1;
    this.pitch = req.pitch ?? 1;
    this.attenuation = req.attenuation ?? null;
    this.position = req.position ? { x: req.position.x, y: req.position.y, z: req.position.z } : null;
    mixer.voiceStarted(this.bus);
    void this.load();
  }

  get playing(): boolean {
    return !this.ended;
  }

  /** @internal The bus this voice counts on. */
  get busName(): string {
    return this.bus;
  }

  /** @internal Ends the voice's bookkeeping once: the bus count drops and the backend forgets it. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    mixer.voiceEnded(this.bus);
    this.backend._forget(this);
  }

  private disposeSound(): void {
    const sound = this.sound;
    this.sound = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      sound?.dispose();
    } catch {
      /* already gone */
    }
  }

  private async load(): Promise<void> {
    let sound: Sound;
    try {
      const live = await this.backend._ready();
      if (!live) {
        // The backend already warned that the engine can't start: no second warning per voice.
        if (!this.ended) {
          this.reason = "failed";
          this.finish();
        }
        return;
      }
      if (this.ended) return;
      const cap = this.backend._cap(this.bus);
      const options: Record<string, unknown> = {
        outBus: this.backend._busNode(live, this.bus),
        volume: soundVolume(this.volume * this.appliedGain),
        loop: this.req.loop,
        ...(cap !== null ? { maxInstances: cap } : {}),
      };
      if (!this.req.stream) options.playbackRate = playbackRate(this.pitch);
      if (this.attenuation || this.position) Object.assign(options, spatialSoundOptions(spatialParams(this.attenuation ?? DEFAULT_ATTENUATION, mixer.audioSettings.spatial)));
      const name = `${this.req.path}#${this.id}`;
      sound = this.req.stream
        ? await live.engine.createStreamingSoundAsync(name, this.req.url, options)
        : await live.engine.createSoundAsync(name, await this.backend._buffer(live, this.req.url), options);
    } catch (e) {
      if (!this.ended) {
        console.warn(`[myco] audio: could not load "${this.req.path}": ${e instanceof Error ? e.message : String(e)}`);
        this.reason = "failed";
        this.finish();
      }
      return;
    }
    if (this.ended) {
      try {
        sound.dispose();
      } catch {
        /* already gone */
      }
      return;
    }
    this.sound = sound;
    sound.onEndedObservable.add(() => {
      this.finish();
      this.disposeSound();
    });
    if (this.position) this.applyPosition();
    if (!this.paused) this.start();
    if (this.gain !== this.appliedGain) this.applyVolume(this.rampSeconds);
  }

  private start(): void {
    const sound = this.sound;
    if (!sound || this.started) return;
    this.started = true;
    const live = this.backend._live;
    // `at` is a time on the heard clock (`Audio.time`); Babylon takes seconds from now. Only decoded clips can wait.
    const wait = live && this.req.at !== undefined && Number.isFinite(this.req.at) ? this.req.at - live.engine.currentTime : 0;
    if (!this.req.stream && wait > 0) (sound as StaticSound).play({ waitTime: wait });
    else sound.play();
  }

  /** Put volume times the fade's gain on the sound, easing over `seconds` when it is above zero. */
  private applyVolume(seconds = 0): void {
    const sound = this.sound;
    if (!sound) return;
    this.appliedGain = this.gain;
    this.rampSeconds = 0;
    const target = soundVolume(this.volume * this.gain);
    if (seconds > 0) sound.setVolume(target, { duration: seconds, shape: RAMP });
    else sound.volume = target;
  }

  private applySpatial(): void {
    const sound = this.sound;
    if (!sound) return;
    const p = spatialParams(this.attenuation ?? DEFAULT_ATTENUATION, mixer.audioSettings.spatial);
    const s = sound.spatial;
    s.distanceModel = p.distanceModel;
    s.minDistance = p.minDistance;
    s.maxDistance = p.maxDistance;
    s.rolloffFactor = p.rolloffFactor;
    s.panningModel = p.panningModel;
  }

  private applyPosition(): void {
    const sound = this.sound;
    const p = this.position;
    if (!sound || !p) return;
    const s = sound.spatial;
    s.position.set(p.x, p.y, p.z);
    s.update();
  }

  /** @internal The bus nodes were rebuilt: connect to the new one. */
  _rebind(live: Live): void {
    if (this.sound && !this.ended) this.sound.outBus = this.backend._busNode(live, this.bus);
  }

  setVolume(v: number): void {
    if (this.ended) return;
    this.volume = v;
    this.applyVolume();
  }
  /** Ease the gain to `to` times the voice's volume. */
  fade(to: number, seconds: number): void {
    if (this.ended) return;
    this.gain = Math.min(4, Math.max(0, Number.isFinite(to) ? to : 1));
    if (this.sound) this.applyVolume(seconds);
    else this.rampSeconds = seconds;
  }
  /** Priority has no meaning here: nothing is stolen by priority. */
  setPriority(priority: number): void {
    void priority;
  }
  /** Streamed clips have no playback rate in Babylon; their pitch stays 1. */
  setPitch(rate: number): void {
    if (this.ended) return;
    this.pitch = rate;
    const sound = this.sound;
    if (sound && !this.req.stream) (sound as StaticSound).playbackRate = playbackRate(rate);
  }
  setAttenuation(a: Attenuation): void {
    if (this.ended) return;
    this.attenuation = a;
    this.applySpatial();
    this.applyPosition();
  }
  setPosition(p: Vec3Like): void {
    if (this.ended) return;
    this.position = { x: p.x, y: p.y, z: p.z };
    this.applyPosition();
  }
  setBus(bus: string): void {
    if (this.ended || bus === this.bus) return;
    mixer.voiceEnded(this.bus);
    this.bus = bus;
    mixer.voiceStarted(bus);
    const live = this.backend._live;
    if (this.sound && live) this.sound.outBus = this.backend._busNode(live, bus);
    this.backend._enforceCap(bus, this);
  }
  pause(): void {
    if (this.ended || this.paused) return;
    this.paused = true;
    if (this.sound && this.started) this.sound.pause();
  }
  resume(): void {
    if (this.ended || !this.paused) return;
    this.paused = false;
    if (!this.sound) return;
    if (this.started) this.sound.resume();
    else this.start();
  }
  stop(fadeSeconds = 0): void {
    if (this.ended) return;
    const sound = this.sound;
    this.finish(); // `playing` goes false now
    if (!sound) return; // still loading: the load sees `ended` and drops the sound
    if (fadeSeconds > 0 && this.started) {
      sound.setVolume(0, { duration: fadeSeconds, shape: RAMP });
      this.timer = setTimeout(() => {
        try {
          sound.stop();
        } catch {
          /* already gone */
        }
        this.disposeSound();
      }, fadeSeconds * 1000);
      return;
    }
    try {
      if (this.started) sound.stop();
    } catch {
      /* already gone */
    }
    this.disposeSound();
  }
}

/** The settings of a sound given a position but no attenuation: the engine's defaults for `AudioSource`. */
const DEFAULT_ATTENUATION: Attenuation = { minDistance: 1, maxDistance: 100, rolloff: "inverse" };

export class BabylonBackend implements AudioBackend {
  readonly name = "babylon";

  private readonly voices = new Set<BabylonVoice>();
  private mixerRef: Mixer | null = null;
  private gains = new Map<string, number>();
  private chain: Promise<Live | null> | null = null;
  private liveNow: Live | null = null;
  private ctx: AudioContext | null = null;
  private ownsContext = false;
  private unlock: Unlock | null = null;
  private listenerPose: ListenerPose | null = null;
  private master = 1;
  private isMuted = false;
  private background: AudioBackground = "mute";
  private disposed = false;
  private warned = false;

  constructor(private readonly options: BabylonBackendOptions = {}) {}

  /** @internal */
  get _live(): Live | null {
    return this.liveNow;
  }

  // --- Engine, context and unlock ----------------------------------------------------------------------------------

  /** @internal The engine once it exists, created on first use. Null when it couldn't start (every voice then fails). */
  _ready(): Promise<Live | null> {
    return (this.chain ??= this.create());
  }

  private async acquireContext(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const host = this.options.hostContext ? await this.options.hostContext() : await coreHostContext();
    if (this.ctx) return this.ctx;
    if (host) {
      // The host owns this context and its unlock layer; the backend only plays on it.
      this.ctx = host;
      this.ownsContext = false;
      return host;
    }
    const ctx = this.options.createContext ? this.options.createContext() : newAudioContext();
    this.ctx = ctx;
    this.ownsContext = true;
    const target = this.options.unlockTarget !== undefined ? this.options.unlockTarget : typeof document !== "undefined" ? document : null;
    if (target) {
      // Arms when the context starts suspended; keeps re-arming after "interrupted" (Safari) or an outside suspend.
      this.unlock = new Unlock({ target, context: ctx as unknown as UnlockContext });
      this.unlock.watch();
    }
    return ctx;
  }

  private async create(): Promise<Live | null> {
    try {
      const audioContext = await this.acquireContext();
      const { CreateAudioEngineAsync } = await import("@babylonjs/core/AudioV2/webAudio/webAudioEngine");
      const engine = await CreateAudioEngineAsync({
        audioContext,
        resumeOnInteraction: false,
        resumeOnPause: false,
        disableDefaultUI: true,
        volume: this.isMuted ? 0 : this.master,
      });
      const main = engine.defaultMainBus ?? (await engine.createMainBusAsync("main"));
      const live: Live = { engine, main, buses: new Map(), plan: [], rootName: null, buffers: new Map() };
      if (this.disposed) {
        this.teardown(live);
        return null;
      }
      await this.buildBuses(live);
      this.liveNow = live;
      this.applyListener();
      return live;
    } catch (e) {
      this.liveNow = null;
      if (!this.warned) {
        this.warned = true;
        console.warn(`[myco] audio: the Babylon backend could not start: ${e instanceof Error ? e.message : String(e)}`);
      }
      return null;
    }
  }

  // --- Buses -------------------------------------------------------------------------------------------------------

  /** Builds one `AudioBus` per mixer bus into `live.buses` (parents first), then swaps them in and moves voices over. */
  private async buildBuses(live: Live): Promise<void> {
    const settings = this.mixerRef?.audioSettings.buses ?? [];
    const plan = planBuses(settings);
    const buses = new Map<string, AudioBus>();
    for (const step of busCreationSteps(plan, this.gains)) {
      const outBus = step.parent !== null ? buses.get(step.parent) ?? live.main : live.main;
      buses.set(step.name, await live.engine.createBusAsync(step.name, { ...step.options, outBus }));
    }
    const old = live.buses;
    live.buses = buses;
    live.plan = plan;
    live.rootName = plan.find((b) => b.parent === null)?.name ?? null;
    for (const v of this.voices) v._rebind(live);
    for (const b of old.values()) {
      try {
        b.dispose();
      } catch {
        /* already gone */
      }
    }
  }

  /** @internal */
  _busNode(live: Live, name: string): PrimaryAudioBus {
    return live.buses.get(name) ?? (live.rootName !== null ? live.buses.get(live.rootName) : undefined) ?? live.main;
  }

  configureBuses(m: Mixer): void {
    this.mixerRef = m;
    const chain = this.chain;
    if (!chain) return; // before the first play: the buses are built with the engine
    this.chain = chain.then(async (live) => {
      if (live && !this.disposed) {
        try {
          await this.buildBuses(live);
        } catch (e) {
          console.warn(`[myco] audio: could not rebuild the buses: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return live;
    });
  }

  applyMix(buses: readonly ResolvedBus[]): void {
    for (const b of buses) this.gains.set(b.name, b.gain);
    const live = this.liveNow;
    if (!live) return;
    for (const b of buses) {
      const node = live.buses.get(b.name);
      const v = Math.max(0, Number.isFinite(b.gain) ? b.gain : 1);
      if (node && node.volume !== v) node.volume = v;
    }
  }

  /** @internal `maxVoices` of a bus, or null. */
  _cap(bus: string): number | null {
    const settings = this.mixerRef?.audioSettings.buses.find((b) => b.name === bus);
    return settings?.maxVoices ?? null;
  }

  /** @internal Stops the oldest voices on `bus` until it holds at most its `maxVoices`, never `keep`. */
  _enforceCap(bus: string, keep: BabylonVoice): void {
    const cap = this._cap(bus);
    if (cap === null) return;
    const onBus = [...this.voices].filter((v) => v.busName === bus);
    for (let i = 0; onBus.length - i > cap; i++) {
      const v = onBus[i]!;
      if (v !== keep) v.stop();
    }
  }

  // --- Sounds ------------------------------------------------------------------------------------------------------

  /** @internal The decoded clip for `url`, fetched once. */
  _buffer(live: Live, url: string): Promise<StaticSoundBuffer> {
    let buffer = live.buffers.get(url);
    if (!buffer) {
      buffer = live.engine.createSoundBufferAsync(url);
      live.buffers.set(url, buffer);
      buffer.catch(() => live.buffers.delete(url));
    }
    return buffer;
  }

  /** @internal */
  _forget(voice: BabylonVoice): void {
    this.voices.delete(voice);
  }

  play(req: PlayRequest): AudioVoice | null {
    if (this.disposed) return null;
    const voice = new BabylonVoice(this, req);
    this.voices.add(voice);
    this._enforceCap(req.bus, voice);
    return voice;
  }

  setListener(pose: ListenerPose): void {
    const copy = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y, z: p.z });
    this.listenerPose = { position: copy(pose.position), forward: copy(pose.forward), up: copy(pose.up) };
    this.applyListener();
  }

  private applyListener(): void {
    const live = this.liveNow;
    const pose = this.listenerPose;
    if (!live || !pose) return;
    const listener = live.engine.listener;
    const q = listenerQuaternion(pose.forward, pose.up);
    listener.position.set(pose.position.x, pose.position.y, pose.position.z);
    listener.rotationQuaternion.set(q.x, q.y, q.z, q.w);
    listener.update();
  }

  // --- Status ------------------------------------------------------------------------------------------------------

  /** "locked" while the context is suspended (or interrupted), "failed" once it is closed, "running" otherwise. */
  get status(): AudioStatus {
    const state = (this.ctx?.state as string | undefined) ?? "running";
    return state === "suspended" || state === "interrupted" ? "locked" : state === "closed" ? "failed" : "running";
  }

  /** The heard clock: the context's, 0 before it exists. */
  get time(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get masterVolume(): number {
    return this.master;
  }
  set masterVolume(v: number) {
    this.master = v;
    this.applyMaster();
  }
  get muted(): boolean {
    return this.isMuted;
  }
  set muted(m: boolean) {
    this.isMuted = m;
    this.applyMaster();
  }
  private applyMaster(): void {
    if (this.liveNow) this.liveNow.engine.volume = this.isMuted ? 0 : Math.max(0, this.master);
  }

  /** The fallback has no background policy of its own; the mode is only reported. */
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }

  /** Babylon updates its own listener and sounds. */
  update(dt: number): void {
    void dt;
  }

  debug(): AudioDebugInfo {
    const counts = new Map<string, number>();
    for (const v of this.voices) counts.set(v.busName, (counts.get(v.busName) ?? 0) + 1);
    const n = this.voices.size;
    return {
      status: this.status,
      sampleRate: this.ctx?.sampleRate ?? 0,
      time: this.time,
      background: this.background,
      counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: n, mixedCap: 0, logicalVoices: n, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 },
      buses: (this.mixerRef?.resolveAll() ?? []).map((b) => ({ name: b.name, gain: b.gain, effectiveGain: b.effectiveGain, peakL: 0, peakR: 0, voices: counts.get(b.name) ?? 0, maxVoices: this._cap(b.name) })),
      voices: [],
      core: { backend: "babylon", voices: n, buffers: this.liveNow?.buffers.size ?? 0, context: this.ctx?.state ?? "none" },
    };
  }

  // --- Teardown ----------------------------------------------------------------------------------------------------

  private teardown(live: Live): void {
    for (const b of live.buses.values()) {
      try {
        b.dispose();
      } catch {
        /* already gone */
      }
    }
    live.buses.clear();
    live.buffers.clear();
    const ctx = this.ctx;
    // `engine.dispose()` closes its context. The host's context outlives this backend, so shield it from the close.
    const shielded = ctx !== null && !this.ownsContext;
    const own = shielded ? Object.getOwnPropertyDescriptor(ctx, "close") : undefined;
    if (shielded) (ctx as { close: () => Promise<void> }).close = () => Promise.resolve();
    try {
      live.engine.dispose();
    } catch {
      /* already gone */
    } finally {
      if (shielded) {
        if (own) Object.defineProperty(ctx, "close", own);
        else delete (ctx as { close?: unknown }).close;
      }
    }
  }

  /** Closes the context this backend made (the engine does it when one was created; a host's is never closed here). */
  private closeOwnedContext(): void {
    const ctx = this.ctx;
    if (ctx && this.ownsContext && ctx.state !== "closed") ctx.close().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    for (const v of [...this.voices]) v.stop();
    this.disposed = true;
    this.unlock?.dispose();
    this.unlock = null;
    const live = this.liveNow;
    this.liveNow = null;
    if (live) this.teardown(live);
    else this.closeOwnedContext();
    // A start still in flight sees `disposed` and tears down what it made.
  }
}

/** The page's core host context, when `audio.backend` is "core" (the only time a host can exist and this backend be playing). */
async function coreHostContext(): Promise<AudioContext | null> {
  if (resolveBackendKind(mixer.audioSettings.backend) !== "core") return null;
  const { currentAudioHost } = await import("./core/context");
  return currentAudioHost()?.context ?? null;
}

function newAudioContext(): AudioContext {
  const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("this environment has no Web Audio");
  return new Ctor({ latencyHint: "interactive" });
}

registerDefaultBackend(() => new BabylonBackend());
