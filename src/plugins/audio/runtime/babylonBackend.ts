/**
 * The `"babylon"` audio backend (ADR 0157 BB1; ADR 0098): Babylon's AudioEngineV2 behind the internal `AudioBackend`
 * interface. It is the fallback for engines that can't load the core, and what `audio.backend: "babylon"` selects.
 *
 * - The engine is created lazily, on the first play, on a shared `AudioContext`, with Babylon's own resume-on-interaction,
 *   resume-on-pause and unmute UI off: the host's unlock layer stays in charge (architecture 2.1). If a core `AudioHost`
 *   exists (a core load failed after the host started) its context is reused; otherwise this backend makes the page's one
 *   context and arms the `Unlock` layer on it.
 * - Mixer buses are Babylon `AudioBus`es (parent through `outBus`); `applyMix` sets each bus's volume to its resolved gain.
 *   Snapshots and ducking arrive already folded into that gain. Effects (reverb, filters, compressor), a snapshot's low-pass,
 *   priority, stealing by priority and virtual voices are core-only: the fallback ignores them rather than fake them.
 * - A voice is a `BabylonVoice` (`babylonVoice.ts`), which reaches this backend only through its `VoiceHost`. Its sound
 *   plays a buffer from the clip loader (`babylonClipLoader.ts`: decoded once per URL and shared by every voice, an
 *   ambisonic clip's W channel, a generator's render) or, for `stream` clips, is one `StreamingSound`. `play` is
 *   synchronous but creating the sound is not, so the voice keeps what its setters ask and applies it when the sound is
 *   ready (its voice sound state, `babylonVoiceState.ts`).
 * - `maxVoices` maps to a cap on live voices per bus (the oldest is stopped), and to each sound's `maxInstances`.
 * - Music (`music`) is `BabylonMusic` (`babylonMusic.ts`), through its `MusicHost`.
 *
 * Babylon is imported module by module and only when a sound first plays, so servers and tests that never play don't load it.
 * Nothing of Babylon appears outside this file and the voice, voice state, clip loader and mapping modules (ADR 0010).
 */
import type { AudioBus, PrimaryAudioBus } from "@babylonjs/core/AudioV2/abstractAudio/audioBus";
import type { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { Vec3Like } from "../../../engine/core/math";
import { AudioReverbZone } from "./AudioReverbZone";
import type { Mixer, ResolvedBus } from "../../../engine/audio/mixer";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import type { MixOpTarget } from "../../../engine/audio/mixer";
import { FALLBACK_LIVE_CAPS, type SentClass } from "../../../engine/audio/busCapability";
import { BABYLON_CPU_REASON, babylonCpuDebug, babylonMixDebug } from "./mix/mixDebug";
import { NULL_PROFILE_SINK, type ProfileSink } from "./mix/profileSink";
import { mixerTapFor, taps } from "./mix/profileTaps";
import type { KeyframeBus, KeyframeVoice } from "./capture/format";
import { KEYFRAME_BUS_LANES, KEYFRAME_MAX_BUSES, KEYFRAME_MAX_VOICES, NO_NAME, keyframeAudibility, keyframePitch } from "./capture/keyframeLayout";
import { generatorParamIndex } from "../../../engine/audio/generators/catalogue";
import { mixer, registerDefaultBackend, resolveBackendKind, zeroCounters, type AudioBackend, type AudioBackground, type AudioCaptureSource, type AudioClipCache, type AudioDebugInfo, type AudioGenerators, type GeneratorSource, type AudioLiveMix, type AudioM3Counters, type AudioMixCaps, type ClipSpanHold, type RecorderTap, type AudioStatus, type AudioVoice, type ListenerPose, type MusicBackend, type AudioOutputDevice, type BackendKeyframe, type PlayRequest } from "./backend";
import { busCreationSteps, listenerQuaternion, planBuses, webAudioVector, type BusPlan } from "./babylonMapping";
import { BabylonClipLoader } from "./babylonClipLoader";
import { BabylonVoice, type VoiceHost, type VoiceMusic } from "./babylonVoice";
import { BabylonMusic, type MusicHost } from "./babylonMusic";
import { DistanceEffect, SendCurveTable, type ListenerFrame, type SpatialPassHost, type SpatialVoiceView, type ZonePass } from "./core/spatial";
import { DopplerPass } from "./core/doppler";
import { OcclusionPass } from "./core/occlusion";
import { encodeVoiceId, voiceGen, voiceIndex } from "./core/ids";
import type { VisibilitySource } from "./core/background";
import { HiddenTabPolicy } from "./hiddenTab";
import { writeKeyframeBusLanes } from "./mix/keyframeBus";
import { Unlock, type UnlockContext } from "./core/unlock";
import { warnOnce } from "./core/handle";

/** What a test (or an unusual host) can replace. */
export interface BabylonBackendOptions {
  /** The core host's context, if one exists. Default: when `audio.backend` is "core", the page's `AudioHost` context. */
  hostContext?: () => AudioContext | null | Promise<AudioContext | null>;
  /** Makes the page's context when there is no host. Default: `new AudioContext()`. */
  createContext?: () => AudioContext;
  /** Where the unlock layer listens for the first gesture. Default: `document` (none outside a browser). */
  unlockTarget?: EventTarget | null;
  /** The page's visibility, for `audio.background` (A3.4b). Default: `document`; null never hides. */
  visibility?: VisibilitySource | null;
}

/** The engine and what hangs off it, once created. */
interface Live {
  readonly engine: AudioEngineV2;
  readonly main: PrimaryAudioBus;
  /** One `AudioBus` per mixer bus (rebuilt by `configureBuses`). */
  buses: Map<string, AudioBus>;
  plan: BusPlan[];
  /** Unknown bus names play on this one: the first root, else the main bus. */
  rootName: string | null;
  /** Decoded clips, ambisonic W channels, generator renders and clip durations. */
  readonly clips: BabylonClipLoader;
}

/** The one warning a session gets the first time the fallback plays a generator (ADR 0360 §8). */
const GENERATOR_RENDER_WARNING =
  "the Babylon audio fallback plays generators as offline renders: their parameters and gen: curves don't follow while they play (ADR 0360).";

/** True when the generator sounds until released (an oscillator or synth with no length): its render loops. */
function generatorLoops(g: GeneratorSource): boolean {
  const i = generatorParamIndex(g.kind, "length");
  return (g.kind === "oscillator" || g.kind === "synth") && i >= 0 && !((g.values[i] ?? 0) > 0);
}

/** Babylon ramps each parameter change over this many seconds (`parameterRampDuration`); no per-call duration is needed. */
const BUS_RAMP_SECONDS = 0.015;
/** Ids of voices past the slot table (no Doppler or occlusion for them): generation 0, so no pass binds them. */
let overflowId = 1;
/** Voices the spatial view lists at once (ADR 0162 K4: Doppler and occlusion run over these). */
const SPATIAL_SLOTS = 1024;

/**
 * ADR 0162 (K4, F1): the fallback's `SpatialVoiceView`. Slots are `SPATIAL_SLOTS` long; a voice takes one at play and gives
 * it back when it ends (its generation then moves on). `collect` refreshes the live list from the voices; results come back
 * through `setOcclusion` and `setDopplerRate` to the voice in the slot.
 */
/**
 * ADR 0162 F2 (api-and-models §8), ADR 0264: the fallback's zone pass. Reverb zones are inert here, because Babylon's V2
 * audio API has no public insertion point for a ConvolverNode: the first enabled `AudioReverbZone` in the World with the
 * view gets one warning for the page. Nothing else happens: voices send nothing, and `debug()` has no `zones`.
 */
class InertZones implements ZonePass {
  private warned = false;

  run(frame: ListenerFrame): void {
    const world = frame.world;
    if (this.warned || !world) return;
    for (const z of world._componentsOfType(AudioReverbZone)) {
      if (!z.isActiveAndEnabled) continue;
      this.warned = true;
      warnOnce("babylon-reverb-zones", "reverb zones need the audio core: on the Babylon audio fallback they are inert and sounds play dry (ADR 0162).");
      return;
    }
  }
}

class BabylonSpatialView implements SpatialVoiceView {
  readonly capacity = SPATIAL_SLOTS;
  readonly slots = new Uint16Array(SPATIAL_SLOTS);
  count = 0;
  readonly gen = new Uint16Array(SPATIAL_SLOTS);
  readonly viewFlags = new Uint8Array(SPATIAL_SLOTS);
  readonly world = new Float64Array(SPATIAL_SLOTS);
  readonly posX = new Float32Array(SPATIAL_SLOTS);
  readonly posY = new Float32Array(SPATIAL_SLOTS);
  readonly posZ = new Float32Array(SPATIAL_SLOTS);
  readonly minDist = new Float32Array(SPATIAL_SLOTS);
  readonly maxDist = new Float32Array(SPATIAL_SLOTS);
  readonly volume = new Float32Array(SPATIAL_SLOTS);
  readonly audibility0 = new Float32Array(SPATIAL_SLOTS);
  readonly dopplerLevel = new Float32Array(SPATIAL_SLOTS);
  /** Zones are inert on the fallback (F2): no sends. */
  readonly reverbSend = new Float32Array(SPATIAL_SLOTS);
  readonly sendCurve = new Uint16Array(SPATIAL_SLOTS);
  readonly curves = new SendCurveTable();
  /** The voice in each slot, null when free. */
  readonly voices: (BabylonVoice | null)[] = new Array<BabylonVoice | null>(SPATIAL_SLOTS).fill(null);
  private readonly free: number[] = [];
  private next = 0;
  private readonly distance = new DistanceEffect();

  /** A free slot for `voice`, or -1 when the table is full. The slot's generation moves on (1..65535). */
  alloc(voice: BabylonVoice): number {
    const i = this.free.length > 0 ? this.free.pop()! : this.next < SPATIAL_SLOTS ? this.next++ : -1;
    if (i < 0) return -1;
    this.gen[i] = this.gen[i]! >= 0xffff ? 1 : this.gen[i]! + 1;
    this.voices[i] = voice;
    return i;
  }

  release(i: number, voice: BabylonVoice): void {
    if (i < 0 || this.voices[i] !== voice) return;
    this.voices[i] = null;
    this.free.push(i);
  }

  /** The voice that `id` names, null once it ended or for an id past the table. */
  voiceOf(id: number): BabylonVoice | null {
    const g = voiceGen(id);
    const i = voiceIndex(id);
    return g !== 0 && i < SPATIAL_SLOTS && this.gen[i] === g ? this.voices[i]! : null;
  }

  collect(listener: ListenerPose | null): void {
    let n = 0;
    for (let i = 0; i < this.next; i++) {
      const v = this.voices[i];
      if (!v) continue;
      v.fillView(this, i, listener, this.distance);
      this.slots[n++] = i;
    }
    this.count = n;
  }

  setOcclusion(i: number, gain: number, lpHz: number): void {
    this.voices[i]?.setOcclusion(gain, lpHz);
  }

  setDopplerRate(i: number, factor: number): void {
    this.voices[i]?.setDopplerRate(factor);
  }
}

/** The fallback's decoded-clip memory ceiling for an ambisonic clip is in `babylonMapping.ts` (`AMBISONIC_DECODE_LIMIT_BYTES`). */
export class BabylonBackend implements AudioBackend, AudioClipCache, AudioLiveMix, AudioCaptureSource, AudioOutputDevice, SpatialPassHost {
  readonly name = "babylon";

  // ADR 0179: the fallback's capabilities, each the backend itself (no object, no allocation): the clip cache (durations
  // only), the music ops (`music` below), the live mix and the capture's main-side sources. No heard clock, no automation.
  get clipCache(): AudioClipCache {
    return this;
  }
  get mix(): AudioLiveMix {
    return this;
  }
  get capture(): AudioCaptureSource {
    return this;
  }

  /**
   * ADR 0171 §1.3 / §9 (M5 Bb2): the fallback has no audio core, so no loudness meters, no level ducking, no CPU figure and
   * no stamped bus ramps; its capture is main-side only. Every bus reads the inert `EMPTY_BUS_LOUDNESS` (no loudness
   * source is registered on this backend's path).
   */
  readonly mixCaps: AudioMixCaps = {
    loudness: false,
    levelDucking: false,
    cpu: false,
    cpuReason: BABYLON_CPU_REASON,
    stampedBusRamps: false,
    capture: "mainSideOnly",
  };

  /** ADR 0175: where `mixer.apply` sends a checked op (`sendOp`); no core chain, no level ducking. */
  readonly mixOpTarget: MixOpTarget = { liveCaps: FALLBACK_LIVE_CAPS, sendOp: (op, cls) => this.sendOp(op, cls) };

  /** ADR 0162 (K4, F1): main runs Doppler and occlusion over this view (`audioFrame.ts`), then `update`. */
  readonly spatialVoices = new BabylonSpatialView();
  readonly doppler = new DopplerPass(SPATIAL_SLOTS);
  readonly occlusion = new OcclusionPass(SPATIAL_SLOTS);

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
  /** ADR 0171 (capture): the fallback has no STATUS blocks, so a recorder never sets or calls this (`mixCaps.capture` is "mainSideOnly"). */
  recorderTap: RecorderTap | null = null;
  /** ADR 0248: removes the device listeners `watchDevice` added. */
  private deviceOff: (() => void) | null = null;
  /** ADR 0248: set by the layer above (`AudioOutputDevice`): told the sink when the context exists and on device events. */
  onOutputDevice: ((sink: string, change: "opened" | "changed") => void) | null = null;
  private warned = false;
  /** A3.4b: the page is hidden and `audio.background` muted or paused the sound (the engine's volume is 0). */
  private hiddenMuted = false;
  /** True while this backend's own `pause` policy has suspended the context it owns. */
  private pageSuspended = false;
  /**
   * A3.4b, ADR 0179: what a hide does, the policy the core shares. The fallback mutes at once (Babylon's engine volume, no
   * ramp) and suspends only a context it made (a context shared with a core host is only muted: the host's policy owns it).
   */
  private readonly hiddenTab = new HiddenTabPolicy({
    mode: () => this.background,
    mute: (_rampMs, mode) => {
      this.hiddenMuted = true;
      this.applyMaster();
      this.profile.hiddenTab(true);
      if (mode === "pause") this.profile.gap("paused"); // §5.3: under `audio.background: "pause"` a hidden page records nothing until it shows
    },
    suspend: () => {
      const ctx = this.ctx;
      if (!ctx || !this.ownsContext || this.disposed || ctx.state !== "running") return;
      this.pageSuspended = true;
      ctx.suspend().catch(() => (this.pageSuspended = false));
    },
  });
  private readonly visibility: VisibilitySource | null;
  private readonly onVisibility = (): void => (this.visibility?.hidden ? this.enterBackground() : this.leaveBackground());

  constructor(private readonly options: BabylonBackendOptions = {}) {
    this.visibility = options.visibility !== undefined ? options.visibility : typeof document !== "undefined" ? (document as unknown as VisibilitySource) : null;
    this.visibility?.addEventListener("visibilitychange", this.onVisibility);
    if (this.visibility?.hidden) this.enterBackground();
  }

  /**
   * What a voice asks of this backend (`VoiceHost`): the engine and clip loader, bus nodes, `maxVoices`, its spatial slot
   * and velocity, and the capture's sink.
   */
  private readonly voiceHost: VoiceHost = {
    ready: () => this.ready(),
    engineTime: () => this.liveNow?.engine.currentTime ?? null,
    outBus: (bus) => (this.liveNow ? this.busNode(this.liveNow, bus) : null),
    maxVoices: (bus) => this.cap(bus),
    enforceCap: (bus, keep) => this.enforceCap(bus, keep),
    busRef: (bus) => this.busRef(bus),
    sampleRate: () => this.rate(),
    profile: () => this.profile,
    claimSlot: (voice) => {
      const slot = this.spatialVoices.alloc(voice);
      return { slot, id: slot >= 0 ? encodeVoiceId(slot, this.spatialVoices.gen[slot]!) : overflowId++ & 0xffff || 1 };
    },
    ended: (voice) => {
      this.voices.delete(voice);
      this.spatialVoices.release(voice.slot, voice);
    },
    setVelocity: (id, v) => {
      if (this.spatialVoices.voiceOf(id)) this.doppler.setVelocity(voiceIndex(id), v);
    },
  };

  // --- Engine, context and unlock ----------------------------------------------------------------------------------

  /** The engine once it exists, created on first use. Null when it couldn't start (every voice then fails). */
  private ready(): Promise<Live | null> {
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
      this.watchDevice(host);
      return host;
    }
    const ctx = this.options.createContext ? this.options.createContext() : newAudioContext();
    this.ctx = ctx;
    this.ownsContext = true;
    const target = this.options.unlockTarget !== undefined ? this.options.unlockTarget : typeof document !== "undefined" ? document : null;
    if (target) {
      // Arms when the context starts suspended; keeps re-arming after "interrupted" (Safari) or an outside suspend.
      this.unlock = new Unlock({ target, context: ctx as unknown as UnlockContext });
      this.unlock.watch(() => this.pageSuspended);
    }
    this.watchDevice(ctx);
    return ctx;
  }

  /** ADR 0248: the output device (the backend itself, as its other capabilities). */
  get device(): AudioOutputDevice {
    return this;
  }

  /** ADR 0248: the context's sink, null before the context exists. */
  get outputSink(): string | null {
    return this.ctx ? this.sinkOf(this.ctx) : null;
  }

  /** The sink the context outputs to: its `sinkId` string, "" for the default device or where unsupported. */
  private sinkOf(ctx: AudioContext): string {
    const id = (ctx as AudioContext & { sinkId?: unknown }).sinkId;
    return typeof id === "string" ? id : "";
  }

  /**
   * ADR 0248 (Rh2 on the fallback): report the sink once the context exists, and again on the context's `sinkchange`
   * and the browser's `devicechange` (`Audio.calibration` follows it above the seam). `dispose` removes the listeners.
   */
  private watchDevice(ctx: AudioContext): void {
    this.onOutputDevice?.(this.sinkOf(ctx), "opened");
    const onDevice = (): void => this.onOutputDevice?.(this.sinkOf(ctx), "changed");
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    ctx.addEventListener?.("sinkchange", onDevice);
    md?.addEventListener?.("devicechange", onDevice);
    this.deviceOff = () => {
      ctx.removeEventListener?.("sinkchange", onDevice);
      md?.removeEventListener?.("devicechange", onDevice);
    };
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
        // Every volume change (a bus's from `applyMix`, a fade step) ramps over this long instead of stepping, so a
        // mute, a solo or a ducking jump doesn't click (the removed BusGraph used a 15 ms time constant too).
        parameterRampDuration: BUS_RAMP_SECONDS,
        volume: this.isMuted ? 0 : this.master,
      });
      const main = engine.defaultMainBus ?? (await engine.createMainBusAsync("main"));
      const live: Live = { engine, main, buses: new Map(), plan: [], rootName: null, clips: new BabylonClipLoader(engine, audioContext) };
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
    for (const v of this.voices) v.rebind();
    for (const b of old.values()) {
      try {
        b.dispose();
      } catch {
        /* already gone */
      }
    }
  }

  private busNode(live: Live, name: string): PrimaryAudioBus {
    return live.buses.get(name) ?? (live.rootName !== null ? live.buses.get(live.rootName) : undefined) ?? live.main;
  }

  configureBuses(m: Mixer): void {
    this.mixerRef = m;
    // ADR 0344 ("one warning per feature", 0179's rule): returns, bus sends and bus effects run only on the audio core.
    const buses = m.audioSettings.buses;
    if (m.returnNames.length > 0 || buses.some((b) => b.effects.length > 0 || (b.sends?.length ?? 0) > 0)) {
      warnOnce("babylon-mix-core", "returns, bus sends and bus effects need the audio core: on the Babylon audio fallback returns are silent, sends feed nothing and bus effects are skipped (ADR 0344, 0345).");
    }
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

  /**
   * ADR 0171 §6.2, §9 (Bb3), 0175: a live edit on the fallback, already checked and classified by `Mixer.apply`. There is
   * no core: direct, smoothed and config ops change the mixer's model (`_applyLive`) and reach Babylon through `applyMix`
   * (bus volumes, which ramp over `BUS_RAMP_SECONDS`); presence ducking keeps running on main from the model. A
   * level-mode ducking rule is kept in the model (so later indices agree with the project); the Mixer answers
   * `needsAudioCore` (`FALLBACK_LIVE_CAPS`), and it never ducks. Structural ops (`dip`: move, remove, reorder), `addBus`
   * and `renameBus` change the node graph, so they rebuild it with the same short ramp: no dip, a click is accepted (the
   * panel says so). The returned class is the op's, as the core answers it.
   */
  sendOp(op: MixOp, cls: SentClass): ApplyResult {
    const m = this.mixerRef ?? mixer;
    const before = m.audioSettings;
    const names = before.buses.map((b) => b.name);
    if (!m._applyLive(op)) return { ok: true, class: "none" };
    const rename = op.op === "renameBus";
    if (rename) {
      const to = op.to.trim();
      for (const v of this.voices) if (v.busName === op.from) v.followRename(to);
      const gain = this.gains.get(op.from);
      this.gains.delete(op.from);
      if (gain !== undefined) this.gains.set(to, gain);
    }
    if (cls === "dip" || rename || op.op === "addBus") {
      const root = m.audioSettings.buses[0]!.name;
      const now = new Set(m.audioSettings.buses.map((b) => b.name));
      if (!rename) for (const n of names) if (!now.has(n)) for (const v of this.voices) if (v.busName === n) v.setBus(root);
      this.applyMix(m.resolveAll());
      this.configureBuses(m);
    } else {
      this.applyMix(m.resolveAll());
    }
    return { ok: true, class: cls };
  }

  /** ADR 0171 (Bb1): the capture's event sink; the null object while no recorder runs (a tap costs one comparison). */
  private profile: ProfileSink = NULL_PROFILE_SINK;

  /**
   * ADR 0171 (Bb1; api-and-models §5.6, §9): the capture's event taps on the fallback, all on main. One sink reaches this
   * backend's voice start, stop and steal, master and hidden-tab changes, the mixer's setters (bus ramps, snapshots, monitor
   * controls) and the page-wide event and music taps (`taps.sink`); null restores every null object. The taps the core
   * has and the fallback has no information for stay silent: no virtual, real, refused (a failed load stops as `failed`)
   * or queued voices, no ladder, no loudness controls, and no EPOCH or GAP from a core (a `pause` background reports its GAP).
   */
  setProfileSink(sink: ProfileSink | null): void {
    this.profile = sink ?? NULL_PROFILE_SINK;
    (this.mixerRef ?? mixer)._setTap(sink ? mixerTapFor(sink, () => this.rate(), (n) => this.busRef(n)) : null);
    taps.sink = this.profile;
  }

  /**
   * A bus name's `busRef` (`gen << 8 | slot`, §6.3): the mixer's slot for it with generation 0 (the fallback has no
   * slot table; a slot is never reused by a later bus, see `Mixer._applyLive`'s `addBus`).
   */
  private busRef(bus: string): number {
    return ((this.mixerRef ?? mixer)._lanes(bus)?.slot ?? 0) & 0xff;
  }

  /**
   * ADR 0171 (Bb1; api-and-models §5.5, §9): the main-side state at this instant for a capture's KEYFRAME, read from main's own
   * tables: the live voices (clip, bus, gain, pitch), every bus's lanes as the mixer holds them (value and target), the
   * events that have voices playing, and the mix section (snapshot in force, monitor flag, master volume, hidden mute). The
   * metered and music sections are empty (no loudness meters on the fallback; music segments aren't tracked here),
   * audibility is full and the playhead 0 (neither is known), and an event's asset is `noName`. `nameId` interns a clip or
   * snapshot name into the capture's NAMES table (`EventSink` does), `noName` is the id for none. The payload is built
   * fresh per call: a keyframe is once a second, and the fallback is best effort.
   */
  keyframe(nameId: (table: "clips" | "snapshots" | "events", name: string) => number, noName = NO_NAME): BackendKeyframe {
    const m = this.mixerRef ?? mixer;
    const voices: KeyframeVoice[] = [];
    const eventVoices = new Map<number, number>();
    for (const v of this.voices) {
      if (voices.length < KEYFRAME_MAX_VOICES) {
        const row = v.row;
        voices.push({
          id: v.id >>> 0, clip: nameId("clips", row.clip), slot: this.busRef(row.bus) & 0xff, state: 0, priority: 0, reason: 0,
          gain: Math.fround(row.gain), pitch: keyframePitch(row.pitch), audibility: keyframeAudibility(1), playheadFrames: 0,
        });
      }
      if (v.event !== null) eventVoices.set(v.event, (eventVoices.get(v.event) ?? 0) + 1);
    }
    const buses: KeyframeBus[] = [];
    for (const name of m.busNames) {
      const l = m._lanes(name);
      if (!l || buses.length >= KEYFRAME_MAX_BUSES) continue;
      // The lanes as the core's keyframe source reads them (`mix/keyframeBus.ts`, ADR 0179).
      const row: KeyframeBus = { slot: l.slot & 0xff, gen: 0, flags: 0, lanes: new Array<number>(KEYFRAME_BUS_LANES).fill(0), duck: 1, automation: 1 };
      row.flags = writeKeyframeBusLanes(row, m, name);
      buses.push(row);
    }
    const snapshot = m.currentSnapshot;
    return {
      voices, buses, metered: [], eventVoices,
      mix: {
        slotTableVersion: 0, monitorActive: m.monitorActive ? 1 : 0, loudnessPausedMask: 0, targetIndex: 0,
        snapshotName: snapshot === null ? noName : nameId("snapshots", snapshot), masterVolume: Math.fround(this.master), hiddenMute: this.hiddenMuted ? 1 : 0,
      },
    };
  }

  /** The fallback has no batch to post: `sendOp` already applied a preview edit. */
  flushNow(): void {}

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

  /** `maxVoices` of a bus, or null. */
  private cap(bus: string): number | null {
    const settings = this.mixerRef?.audioSettings.buses.find((b) => b.name === bus);
    return settings?.maxVoices ?? null;
  }

  /** Stops the oldest voices on `bus` until it holds at most its `maxVoices`, never `keep`. */
  private enforceCap(bus: string, keep: BabylonVoice): void {
    const cap = this.cap(bus);
    if (cap === null) return;
    const onBus = [...this.voices].filter((v) => v.busName === bus);
    for (let i = 0; onBus.length - i > cap; i++) {
      const v = onBus[i]!;
      if (v !== keep) v.stealFor(keep);
    }
  }

  // --- Sounds ------------------------------------------------------------------------------------------------------

  /** ADR 0162 (K4) `SpatialPassHost`: this frame's live voices, for Doppler and occlusion. */
  collectSpatialVoices(): void {
    if (!this.disposed) this.spatialVoices.collect(this.listenerPose);
  }

  /** ADR 0264 `SpatialPassHost.velocityOf` (D3 `AudioSource.velocity`): the estimate, or `setVelocity`'s value. */
  velocityOf(id: number, out: { x: number; y: number; z: number }): boolean {
    if (!this.spatialVoices.voiceOf(id)) return false;
    const i = voiceIndex(id);
    out.x = this.doppler.velX[i]!;
    out.y = this.doppler.velY[i]!;
    out.z = this.doppler.velZ[i]!;
    return true;
  }

  play(req: PlayRequest): AudioVoice | null {
    // ADR 0360 §8: a generator plays as its offline render (the clip loader's), looped when it sounds until released;
    // its parameters don't follow while it plays (one warning a session).
    if (req.generator) {
      warnOnce("babylon-generators", GENERATOR_RENDER_WARNING);
      return this.playVoice({ ...req, url: "", stream: false, loop: req.loop || generatorLoops(req.generator) });
    }
    // ADR 0362: reverse and the per-sample Amp envelope are the audio core's (ABI 6.1); here a reversed clip plays forward
    // and an envelope is left out (one warning each a session).
    if (req.reverse) warnOnce("babylon-reverse", "[myco] audio: reversed clips play forwards on the Web Audio fallback (reverse needs the audio core).");
    if (req.envelope) warnOnce("babylon-amp-envelope", "[myco] audio: a clip's Amp envelope isn't applied on the Web Audio fallback (it needs the audio core).");
    return this.playVoice(req);
  }

  /**
   * ADR 0360 §8 (another capability, 0179): generators play here as renders made at the trigger, so a later change to a
   * playing voice's parameters (a hot reload) isn't heard; the play's own warning already said so.
   */
  readonly generators: AudioGenerators = {
    setParams: () => {},
  };

  /** `play`, with a music member's extras. */
  private playVoice(req: PlayRequest, music?: VoiceMusic): BabylonVoice | null {
    if (this.disposed) return null;
    const voice = new BabylonVoice(this.voiceHost, req, music);
    this.voices.add(voice);
    this.enforceCap(req.bus, voice);
    return voice;
  }

  /** The context's sample rate, for file frames to seconds. */
  private rate(): number {
    const r = this.ctx?.sampleRate;
    return r && r > 0 ? r : 48000;
  }

  /**
   * ADR 0166 M4a on the fallback (api-and-models §8, B1): groups of decoded stems stamped through `waitTime`, shaped fades
   * as `setVolume` ramps, streamed stems flat and unaligned, no priming, no rhythm mode. Its presence is what lets a
   * music player leave "starting" on this backend.
   */
  readonly music: MusicBackend = new BabylonMusic(this.musicHost());

  private musicHost(): MusicHost {
    return {
      isDisposed: () => this.disposed,
      time: () => this.time,
      sampleRate: () => this.rate(),
      warm: (urls) => {
        void this.ready().then((live) => {
          if (live) for (const url of urls) live.clips.warm(url);
        });
      },
      play: (req, music) => this.playVoice(req, music),
    };
  }

  /** A loaded clip's length in seconds, null while it isn't decoded (or streams). */
  clipDuration(path: string): number | null {
    return this.liveNow?.clips.duration(path) ?? null;
  }

  /** The fallback keeps no clip facts (G-1): a stem's stream-or-decode rule uses its import setting here. */
  clipFacts(path: string): undefined {
    void path;
    return undefined;
  }

  /** P8: nothing to drop here (Babylon's decoded buffers are per URL and reloaded with the page's next load). */
  invalidateClip(path: string): void {
    void path;
  }

  /** C14: no span clips on the fallback, so no loop tails (they need the core's decoded spans). */
  holdSpan(path: string, startFrame: number, endFrame: number): ClipSpanHold | null {
    void path;
    void startFrame;
    void endFrame;
    return null;
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
    const p = webAudioVector(pose.position);
    listener.position.set(p.x, p.y, p.z);
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
    if (this.profile !== NULL_PROFILE_SINK) this.profile.masterChange(this.master, this.isMuted || this.hiddenMuted);
  }
  get muted(): boolean {
    return this.isMuted;
  }
  set muted(m: boolean) {
    this.isMuted = m;
    this.applyMaster();
    if (this.profile !== NULL_PROFILE_SINK) this.profile.masterChange(this.master, m || this.hiddenMuted);
  }
  private applyMaster(): void {
    if (this.liveNow) this.liveNow.engine.volume = this.isMuted || this.hiddenMuted ? 0 : Math.max(0, this.master);
  }

  /**
   * `audio.background` (A3.4b), as far as the fallback can: `mute` sets the engine's volume to 0 while the page is
   * hidden (at once, no ramp); `pause` also suspends the context when this backend owns it (a context shared with a
   * core host is only muted, since the host's policy owns it); `play` does nothing. Applied at the next hide.
   */
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }

  private enterBackground(): void {
    if (this.disposed) return;
    this.hiddenTab.hide();
  }

  private leaveBackground(): void {
    if (this.hiddenTab.show() === null) return;
    const resume = this.pageSuspended;
    this.pageSuspended = false;
    if (resume) this.ctx?.resume().catch(() => this.unlock?.arm());
    if (this.hiddenMuted) {
      this.hiddenMuted = false;
      this.applyMaster();
      this.profile.hiddenTab(false);
    }
  }

  /** ADR 0264 `SpatialPassHost.zones`: inert (`InertZones`). */
  readonly zones: ZonePass = new InertZones();

  private rhythmWarned = false;

  /** Babylon updates its own listener and sounds. */
  update(dt: number): void {
    void dt;
    // M4c (api-and-models §8): rhythm mode (a numeric latencyHint, latency read-back, held callbacks) needs the core. The
    // context keeps "interactive" and music runs as without it; beat callbacks come from `time` (the context clock) in
    // `music/beatClock.ts`, uncorrected for output latency, since `caps.heardClock` and `caps.rhythm` are false.
    if (!this.rhythmWarned && mixer.audioSettings.rhythmMode === true) {
      this.rhythmWarned = true;
      warnOnce("babylon-rhythm-mode", "audio.rhythmMode needs the audio core: the Babylon audio fallback keeps its default latency, so rhythm mode is unavailable and beat callbacks are not corrected for output latency (api-and-models §8). Calibration.fromTaps still works.");
    }
    (this.music as BabylonMusic).pump();
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
      counters: { ...zeroCounters(), mixedVoices: n, logicalVoices: n, ...this.m3Counters() },
      buses: (this.mixerRef?.resolveAll() ?? []).map((b) => ({ name: b.name, gain: b.gain, effectiveGain: b.effectiveGain, peakL: 0, peakR: 0, voices: counts.get(b.name) ?? 0, maxVoices: this.cap(b.name) })),
      // Existing tests (and architecture 8 for this fallback) expect an empty list for plain voices: only event voices get rows.
      voices: [...this.voices].filter((v) => v.event !== null).map((v) => ({ id: v.id, clip: v.row.clip, bus: v.row.bus, world: null, state: "playing" as const, priority: 0, gain: v.row.gain, pitch: v.row.pitch, audibility: 1, playheadSeconds: null, owner: null, event: v.event })),
      // ADR 0162 §1.6 (D5): what applies here. Beds, zones, ambisonic voices and the ladder don't exist on this fallback.
      occlusion: this.occlusion.debug(),
      // G7b: `currentFrame` is the audio clock in frames (the context's time at its rate): the fallback has no STATUS, so this is
      // the frame a capture stamps its events and keyframes with (`capture.ts` reads it as it reads the core's).
      core: { backend: "babylon", voices: n, buffers: this.liveNow?.clips.decodedClips ?? 0, context: this.ctx?.state ?? "none", currentFrame: Math.floor(this.time * this.rate()) },
      // ADR 0171 (Dbg1; §1.3, §9): the fallback's inert M5 sections.
      mixCaps: { ...this.mixCaps },
      cpu: babylonCpuDebug(),
      mix: babylonMixDebug(mixer, mixer.busNames),
      recorder: null,
    };
  }

  /** ADR 0162 §1.6 (D5): the occlusion and Doppler counters (the passes run on main for this backend too). */
  private m3Counters(): AudioM3Counters {
    const o = this.occlusion.counters;
    const d = this.doppler.counters;
    return {
      occlusionRays: o.occlusionRays, occlusionUsedMs: o.occlusionUsedMs, occlusionOverruns: o.occlusionOverruns, occlusionSources: o.occlusionSources,
      occlusionNoPhysics: o.occlusionNoPhysics, oldestOcclusionAgeFrames: o.oldestOcclusionAgeFrames,
      dopplerClamps: d.dopplerClamps, dopplerTeleports: d.dopplerTeleports, dopplerGuardTrips: d.dopplerGuardTrips,
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
    live.clips.clear();
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
    if (this.profile !== NULL_PROFILE_SINK) this.setProfileSink(null); // the taps point at nothing once this backend is gone
    this.deviceOff?.();
    this.deviceOff = null;
    this.visibility?.removeEventListener("visibilitychange", this.onVisibility);
    this.hiddenTab.dispose();
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
