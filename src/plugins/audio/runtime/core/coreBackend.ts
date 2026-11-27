// The core's `AudioBackend` (ADR 0157 K3; api-and-models §3 "Mixer counting", §6 "AudioBackend changes"; architecture
// §3.2): plays through the voice table and the command writer, reads the core through the status mirror, loads
// clips through the clip registry (K9), and keeps time with the clock map. `service.ts` registers a factory for it
// (`registerCoreBackend`) once the core has loaded.
//
// Frame flow (the stages `audioFrame.ts` `runAudioFrame` runs once per frame, ADR 0270): clock.beginFrame, mirror.beginFrame, free ended
// voices, apply clip events to the registry, start voices that were waiting for the unlock, move spatial voices, run
// the voice selection (A3.1, `selection.ts`: SET_MIXED for changes, steals over a bus's `maxVoices`), drain the table's
// STOP and FADE commands into the writer, flush the batch at `clock.nextFirstFrame()`. Everything the mirror does
// happens in `onmessage`, separately.
//
// ADR 0176: a voice's state and changes are `voices.ts` (`CoreVoices`: start, launch, the setters, what is sent, the stem
// re-sends, refusals); this file wires it to the frame and the lifecycle, and its `Voice` handle is an adapter onto it.
//
// Selection (A3.1): a new voice's PLAY carries the `mixed` bit `Selection.admit` decides (room under the cap); each
// frame `Selection.run` promotes and demotes with hysteresis and dwell, and the core fades 5 ms either way. Spatial
// voices get their listener-space direction and distance gain here (A1.5's models, through `ListenerBasis`, which
// allocates nothing). Only mixed voices get SET_PARAMS for gain and direction; virtual ones keep fresh values in the
// table for their audibility, and SET_MIXED carries them on a promote.
//
// HRTF (H3): after selection, `PannerPick` flags the top `voices.hrtf` mixed spatial voices by audibility (1.2x
// hysteresis) with panner kind 1, sent as SET_PARAMS `flags`; the core crossfades 45 ms either way. The first flag
// starts the lazy HRIR fetch (`hrir.ts`); `audio.spatial: "equalPower"` or `voices.hrtf: 0` never flags or fetches.
// ADR 0162 (A5): the other mixed spatial voices go to kind 2 (the bed) where their bus has one (`beds.ts`), with a 500 ms
// kind dwell in game time; the first bed hosted starts the lazy MagLS fetch (`hrir.ts`, HRTF mode only: R9), and the
// sharing chain's snapshot low-pass reaches a bed voice as `LowpassBy.SNAPSHOT`.
//
// A1.6 added `volume, pitch, priority, oneShot, at, attenuation, position` to `PlayRequest` and `id, reason, fade,
// setPriority, stop(fadeSeconds)` to `AudioVoice` (§6). `CorePlayRequest` and `CoreVoice` keep only what the core adds.
//
// B3: a `PlayRequest` with `stream: true` is a stream voice (`streams.ts`): no clip load; its PLAY (flag `stream`)
// goes out at once and the decoder worker feeds the core's ring directly. It is an ordinary voice otherwise (mixed or
// virtual, spatial, routed through any bus and its effects, paused, faded, stolen), as the design has it.
//
// ADR 0158 (M2 E3.1): `automation` is the event runtime's sink on the core (`coreAutomation.ts`: CURVES, PARAM,
// AUTOMATE, BUS_AUTOMATE, SET_LOOP and their mirror for a rebuild), so events' automation runs in the core and the
// runtime makes no `TsAutomation`. PLAY carries the request's `group`; `clipDuration` and `horizon` let continuous
// containers schedule gapless with `at`.
//
// ADR 0162 (K4, the M3 skeleton): the frame is split at main's passes (`StagedFrameHost`, `spatial.ts`) so the audio
// system runs the M3 order in one place: `frameAttenuate` (everything up to and including the spatial move: gain,
// direction, `audibility0`), then the passes on `spatialVoices` (Doppler, zones, occlusion: `doppler.ts`, `zones.ts`,
// `occlusion.ts`), then `frameSelect` (audibility = `audibility0` × `occGain`), `framePickPanners` (`pannerPick.ts`),
// `frameStageFx` (`voiceFx.ts`), `frameStageListener` (`listener.ts`) and `frameCommit` (idle, queued commands, the
// BATCH). ADR 0270: `runAudioFrame` is the only caller of the stages; the backend has no `update`. The backend constructs every M3 part here: the bed
// planner (`beds.ts`, planned after each BUS_CONFIG), the panner pick, the zone manager over the zone IR service
// (`zoneIr.ts`, K0's `ZoneIrService`), the occlusion and Doppler passes, the LISTENER stage and the per-voice fx staging.
// Main's results come back through `voices.setOcclusion` (the dry gain is `gain × occGain`, the cutoff a `voiceFx` low-pass)
// and `voices.setDopplerRate` (the pitch sent is `pitch × dopplerFactor`); both are 1 until their tasks, so M2's bytes stand.
//
// ADR 0166 (Q2, the M4 skeleton; this file is coordinator-only after W1): `music` is `musicOps` (`musicOps.ts`, P1 and
// P9 fill it), built over a `MusicOpsHost` of closures so music work never edits this file. The hooks: `beginFrame`
// (step 0 of the audio system: the clock map and this frame's music STATUS), `timeAt` (`Audio.timeAt`, the raw heard
// clock), `latency` (`Audio.latency`; the context's part from `host.latency`, Rh1), a member's play
// (`CorePlayRequest.music`: musicOps opened and primed its stream, its PLAY carries the gate), `Voice.fadeShaped`,
// `onFree` for members, `reopenStreams` (music voices skipped, then `musicOps.reopenGroups`), and `musicOps` on the
// `DebugSource` (P10).
import type { Vec3Like } from "../../../../engine/core/math";
import { mixer as defaultMixer, type Mixer, type MixOpTarget, type ResolvedBus } from "../../../../engine/audio/mixer";
import { Assets } from "../../../../engine/scene/Assets";
import type { Attenuation, AudioBackend, AudioBackground, AudioCaptureSource, AudioCodecs, AudioGenerators, AudioOutputDevice, AudioPacks, AudioWorldViews, BackendKeyframe, AudioClipCache, AudioClock, AudioCpuDebug, AudioFrameMap, AudioLiveMix, AudioMixCaps, AudioMixDebug, AudioPanner, AudioStatus, AudioVoice, ClipSpanHold, ListenerPose, MusicBackend, PlayRequest, RecorderTap, ShapedFade, ShapedParams, VoiceSpatialOptions, ZoneIrService } from "../backend";
import type { AudioLatency } from "../../../../engine/audio/musicTypes";
import { MAX_BUSES } from "../../../../engine/audio/settings";
import { BUS_LP_OFF_HZ, FX_MEMORY_SECONDS, readStatus, type BusConfigBuses } from "../wire.generated";
import { AudioHandle, type AudioReason } from "./handle";
import { limiterLatencyFrames } from "./limiterLatency";
import { ClockMap } from "./clock";
import { CommandWriter } from "./commandWriter";
import { createHrirLoader, createMaglsLoader, type HrirLoader, type MaglsLoader, type SpatialPrepare } from "./hrir";
import { createClipRegistry, type ClipInfo, type ClipRegistry } from "./clipRegistry";
import { DEFAULT_CLIP_CEILING_MB, type AudioHost, type CoreLink, type HostHealth } from "./context";
import { PlayheadTracker, Replayer, replayBusConfig, replayMaster, type ReplaySource } from "./replay";
import { CoreSession } from "./session";
import { CoreLoudness } from "./coreLoudness";
import { buildDebugInfo, fxStarvedOwnerName, mixDebugInfo, type AudioDebugInfo, type DebugSource } from "./debug";
import { BackgroundController } from "./background";
import { browserHostClock, type HostClock } from "./hostClock";
import { StatusMirror } from "./mirror";
import { StatusReader } from "./statusReader";
import { UnlockQueue } from "./unlockQueue";
import { connectVoiceTable, VoiceFlag, VoiceFlag2, VoiceState, VoiceTable } from "./voiceTable";
import { reopenStamp, StreamManager, type StreamDecoderLike, type StreamManagerDeps } from "./streams";
import { WorkletChannel } from "./workletChannel";
import { sharedDecoderClient, type DecoderClient } from "../decoder/decoderClient";
import { createPackHost } from "./packHost";
import { packedMediaUrl, packedSound } from "./packMedia";
import { headedVoice } from "./headedVoice";
import { createWarnOnce, type WarnOnce } from "./codecs";
import { effectiveMixedCap, Selection } from "./selection";
import { PannerKind, PannerPick, type PannerKindCode, type PannerSink } from "./pannerPick";
import { BedPlanner } from "./beds";
import { ZoneManager } from "./zones";
import { createZoneIrService, type ZoneIrChannel } from "./zoneIr";
import { OcclusionPass } from "./occlusion";
import { DopplerPass } from "./doppler";
import { ListenerStage } from "./listener";
import { LowpassBy, VoiceFx } from "./voiceFx";
import { type ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView, type StagedFrameHost } from "./spatial";
import { BusIndex } from "./busIndex";
import { LaneWriter } from "./laneWriter";
import { KeyframeSource, type KeyframeHost } from "./keyframeSource";
import { Presence, type PresenceHost } from "./presence";
import { LiveMix } from "./liveMix";
import { StructuralDip } from "./structuralDip";
import { DeferredAdds } from "./deferredAdds";
import { setRecoveryProfileSink } from "./recovery";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import { EffectPluginHost } from "../effectPlugins/host";
import { wireProfileTaps } from "../mix/profileTaps";
import { CoreAutomation } from "./coreAutomation";
import { CoreSubmixes } from "./submixes";
import { CoreMusicOps, type MusicMemberTag } from "./musicOps";
import { CoreVoices } from "./voices";


/** `PlayRequest` plus the core's World key. */
export interface CorePlayRequest extends PlayRequest {
  /** ADR 0166 (Q2; P1 sets it in `musicOps.stampGroup`): a music group member (`musicOps.ts` `MusicMemberTag`). */
  music?: MusicMemberTag;
  /** The World key of the playing World (0 or omitted: none). */
  world?: number;
  /** W12: a stream voice opens its stream at this frame of the file (after a prefetch head that plays frames before it). */
  streamStartFrame?: number;
}

/** One voice as `AudioVoice`, with §6's optional members required, plus the handle. */
export interface CoreVoice extends AudioVoice {
  readonly id: number;
  readonly reason: AudioReason | null;
  readonly handle: AudioHandle;
  fade(to: number, seconds: number): void;
  setPriority(priority: number): void;
  stop(fadeSeconds?: number): void;
}

/**
 * What the backend needs of the host: `createCoreBackend` adapts the `AudioHost` to it. Module-private, as is the class's
 * value: a backend is made only by `createCoreBackend`, which only `assembleCore` calls (ADR 0221, 0234).
 */
interface CoreBackendHost {
  readonly link: Pick<CoreLink, "batchPool" | "nextSeq" | "post" | "onStatus"> & { statusDecoder: CoreLink["statusDecoder"] } & Partial<Pick<CoreLink, "connectStreamPort" | "postControl" | "onShellEvent">>;
  readonly status: "locked" | "running" | "failed";
  /**
   * `maxMixed` is `voices.mixed` (selection's configured cap; absent: every logical voice may be mixed).
   * `limiterLookaheadMs` sets the core's output latency the clock map allows for (absent: the 1.5 ms default).
   */
  readonly preset: {
    readonly maxLogical: number;
    readonly maxMixed?: number;
    readonly limiterLookaheadMs?: number;
    /** ADR 0162 C8: the regions the core laid out (`initParams.ts`; absent: 0, as an M2 preset). */
    readonly maxBeds?: number;
    readonly maxZoneSlots?: number;
    readonly zoneMaxSeconds?: number;
    readonly maxWide?: number;
    /** ADR 0166 §4.5: the music ring pool (`audio.music.rings`, ABI 3.0; absent: 0, no streamed stems). */
    readonly maxMusicRings?: number;
  };
  /** Worlds holding a share (an idle host has none). */
  readonly worldCount: number;
  readonly sampleRate: number;
  addLifecycleListener: AudioHost["addLifecycleListener"];
  /** Architecture §8 health counters (traps, recoveries, rebuilds) of the host, for `Audio.debug()` (A3.4a). */
  readonly health?: HostHealth;
  /**
   * ADR 0166 §1.3, §1.5 (Rh1 implements it in `context.ts`): the context's `baseLatency` and `outputLatency`, seconds, as
   * read back after creation (0 where the browser reports none), and the host's `reliable` rule (§4.6; absent: the
   * range check alone). Absent: both 0.
   */
  latency?(): { readonly base: number; readonly output: number; readonly reliable?: boolean };
  /** ADR 0248: the sink the context outputs to ("" the default device or unsupported). Absent: not known (null). */
  outputSink?(): string;
}

/** What `createCoreBackend` takes beyond the host (tests inject fakes). */
export interface CoreBackendDeps {
  /** The registry for clips; defaults to one wired to the host (CoreLink, `fetch`, the decoder worker). */
  clips?: ClipRegistry;
  clock?: HostClock;
  mixer?: Mixer;
  /** The HRTF table loader (H2); defaults to one on `clips` at the host rate. Tests inject a fake. */
  hrir?: HrirLoader;
  /** ADR 0162 (A5): the MagLS bed filters' loader (default: the real one). */
  magls?: MaglsLoader;
  /**
   * B3: stream plumbing. Defaults: the page's decoder client, `host.link.connectStreamPort`, a `MessageChannel`, and a
   * fetch of the asset's URL. Tests pass an in-process decoder and channel.
   */
  streams?: Partial<Pick<StreamManagerDeps, "decoder" | "connectWorklet" | "channel" | "fetchBytes" | "packRef">>;
  /** B4: warns once per asset the core can't decode (shared with the clip registry); default: the backend's own over `console.warn`. */
  warnOnce?: WarnOnce;
  /** ADR 0162 (K0, C9): zone IR preparation; default `createZoneIrService` (`zoneIr.ts`). Tests inject a fake. */
  zoneIr?: ZoneIrService;
}


/** What the backend's parts read of it through its private view (`CoreBackend.view`). */
type CoreView = DebugSource & KeyframeHost & ReplaySource & PresenceHost;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** ADR 0171 (K0): the core backend that last registered its clock and op target on each mixer. */
const mixerOwners = new WeakMap<Mixer, CoreBackend>();

/**
 * The core backend. Exported as a type only (below the class): the one way to make one is `assembleCore`
 * (`core/assembly.ts`) through `createCoreBackend`, so no caller builds it over a hand-made host or without its clip
 * registry and background controller.
 */
class CoreBackend implements AudioBackend, AudioClipCache, AudioClock, AudioLiveMix, AudioCaptureSource, AudioOutputDevice, AudioCodecs, AudioWorldViews, StagedFrameHost {
  readonly name = "core";
  /** ADR 0351 A4 (`AudioCodecs`): IMA ADPCM clips held compressed in the arena, decoded per voice (clip format 6, ABI 4.12). */
  readonly adpcmCompressed = true;
  /** ADR 0351 A7 (`AudioCodecs`): Ogg Opus in the decoder worker (libopus, decoder ABI 1.5). */
  readonly opus = true;

  // ADR 0179: the core has every capability, and each is the backend itself (its own members are the capability's: no
  // object, no allocation). `music` and `automation` are its music ops and automation tables.
  get clipCache(): AudioClipCache {
    return this;
  }
  get clock(): AudioClock {
    return this;
  }
  get mix(): AudioLiveMix {
    return this;
  }
  get capture(): AudioCaptureSource {
    return this;
  }
  get device(): AudioOutputDevice {
    return this;
  }
  get codecs(): AudioCodecs {
    return this;
  }
  /** ADR 0434: which Worlds have the view (`setWorldAudible`). */
  get worldViews(): AudioWorldViews {
    return this;
  }
  /** ADR 0351 §7 (W12): packages in the decoder, their sounds committed to the arena at load (`packHost.ts`). */
  get packs(): AudioPacks {
    return (this.packHost ??= createPackHost({ decoder: () => this.decoderOf(), clips: this.clips, locked: () => this.status === "locked" }));
  }
  private packHost: AudioPacks | null = null;

  /**
   * ADR 0360 (G3): generator voices. A play with `generator` is a PLAY of the kind's reserved clip id and a GEN with every
   * value at the same frame (`voices.ts`); `setParams` sends a partial GEN to a playing one (a hot reload).
   */
  readonly generators: AudioGenerators = {
    setParams: (voice, params, seconds) => this.voices.setGeneratorParams(voice.id, params, seconds),
  };

  /**
   * ADR 0360: what the automation sink reads as a generator voice's "clip" (slot `i`): ready, mono, no frames, at the
   * context's rate, so its SET_LOOP release (the key-off) is sent like any voice's.
   */
  private generatorClipInfo(i: number): ClipInfo {
    return { id: this.table.clip[i]!, path: this.table.genPath[i] ?? "", state: "ready", refs: 1, frames: 0, channels: 1, sampleRate: this.clockMap.sampleRate, format: 0, bytes: 0, failure: null };
  }

  /** ADR 0352 §7: plugin effects (the core runs them inside its chains; `effectPlugins/host.ts`). */
  get effectPlugins(): EffectPluginHost {
    return this.plugins;
  }
  /** ADR 0248: the output device's sink (`AudioOutputDevice`), from the host. */
  get outputSink(): string | null {
    return this.host.outputSink?.() ?? null;
  }
  /** ADR 0248: set by the layer above; the background controller reports each device event through it. */
  onOutputDevice: ((sink: string, change: "opened" | "changed") => void) | null = null;
  private readonly table: VoiceTable;
  private readonly mirror: StatusMirror;
  private readonly writer: CommandWriter;
  readonly clockMap: ClockMap;
  readonly clips: ClipRegistry;
  readonly mixer: Mixer;
  /** The per-frame voice selection (A3.1). */
  readonly selection: Selection;
  /** Where each voice is in its clip (A3.4a), for a hard rebuild's replay. */
  readonly playheads: PlayheadTracker;
  /** The hard rebuild's replay (A3.4a; `replay.ts`). */
  private readonly replayer: Replayer;
  /** ADR 0162 (K4): each voice's panner kind (`pannerPick.ts`; H3's HRTF pick until A5). */
  readonly panners: PannerPick;
  private readonly pannerSink: PannerSink;
  /** ADR 0162 (K4): the bed planner (`beds.ts`). */
  readonly beds: BedPlanner;
  /** ADR 0162 (K4): per-voice fx staging (`voiceFx.ts`: lpHz, SET_VOICE_FX). */
  readonly voiceFx: VoiceFx;
  /** ADR 0162 (K4, K0): zone IR preparation (`zoneIr.ts`). */
  readonly zoneIr: ZoneIrService;
  /**
   * B3, ADR 0162 C9: the decoder worker ↔ worklet channel (`workletChannel.ts`) streams and zone IRs share; whichever
   * needs it first connects it, and a respawned worker or a rebuilt node gets a new one.
   */
  readonly worklet: WorkletChannel<StreamDecoderLike>;
  /** ADR 0162 (K4): the zone manager (`zones.ts`). */
  readonly zones: ZoneManager;
  /** ADR 0162 (K4): main's occlusion pass (`occlusion.ts`), run by the frame step (`audioFrame.ts`). */
  readonly occlusion: OcclusionPass;
  /** ADR 0162 (K4): main's Doppler pass (`doppler.ts`), run by the frame step (`audioFrame.ts`). */
  readonly doppler: DopplerPass;
  /** ADR 0162 (K4): LISTENER staging (`listener.ts`). */
  readonly listener: ListenerStage;
  /** ADR 0162 (K4): the interned send curves (`spatial.ts`). */
  readonly sendCurves = new SendCurveTable();
  /** ADR 0162 (K4): the voices as main's passes see them (`spatial.ts`). */
  readonly spatialVoices: TableSpatialView;
  /** ADR 0176: the core voice: start, launch, the setters, what is sent, stem re-sends and refusals (`voices.ts`). */
  private readonly voices: CoreVoices;
  /** B3: the stream voices' main side (`streams.ts`). */
  readonly streams: StreamManager;
  /** The decoder client clips and streams use (W12: packages load into it). */
  private readonly decoderOf: () => StreamDecoderLike;
  /** ADR 0158 (E3.1): the event runtime's automation sink on the core, and its mirror for a rebuild (`coreAutomation.ts`). */
  readonly automation: CoreAutomation;
  /** ADR 0345: the instance submix pool (`submixes.ts`). */
  readonly submixes: CoreSubmixes;
  /** ADR 0352: the plugin effect registry and its worklet messages. */
  private readonly plugins: EffectPluginHost;
  /** ADR 0166 (Q2): the music group operations (`music`); P1 and P9 fill them in `musicOps.ts`. */
  readonly musicOps: CoreMusicOps;

  private readonly hostClock: HostClock;
  private readonly reader = new StatusReader();
  private readonly cleanups: (() => void)[] = [];
  /**
   * ADR 0178: the core session's lifecycle: the reconfigure, rebuild, replay, failure and dispose phases run their
   * participants in `PHASE_ORDER`'s order (`session.ts`; the participants join in `joinSession`). It owns `recovering`
   * and `disposed`, and (ADR 0291) answers whether the core may be written to now (`maySend`, `mayQueue`), which the
   * parts that write ask it.
   */
  readonly session = new CoreSession(() => this.host.status);
  /** ADR 0171 (K0): the bus indexing (`busIndex.ts`; Ma1 moves it onto the slot table). */
  readonly buses: BusIndex;
  /** ADR 0171 (K0): the bus gain writer (`laneWriter.ts`; Wa2, then Mx2). */
  private readonly lanes: LaneWriter;
  /**
   * What the backend's own parts read of it: `debug()` (`debug.ts`), the capture's keyframe (`keyframeSource.ts`), the
   * hard rebuild's replay (`replay.ts`) and presence ducking (`presence.ts`). The table, mirror and writer stay private
   * to the backend; each part sees them through this view (getters over the backend, no allocation per read).
   */
  private readonly view: CoreView = this.createView();
  /** ADR 0171 (K0): presence ducking's hooks (`presence.ts`; Dp1). */
  readonly presence = new Presence(this.view);
  /** ADR 0171 (K0): structural live edits (`structuralDip.ts`; Ma2). */
  private readonly dip = new StructuralDip();
  /** ADR 0171 (K0): deferred live adds (`deferredAdds.ts`; Ma3). */
  private readonly deferredAdds = new DeferredAdds();
  /** ADR 0171 (K0), 0175: the live-edit path, `mixer.apply`'s target (`liveMix.ts`; Ma1). */
  private readonly liveMix = new LiveMix({
    dip: this.dip,
    deferred: this.deferredAdds,
    mixer: () => this.mixer,
    buses: () => this.buses,
    writer: () => this.writer,
    automation: () => this.automation,
    // The mixer's change notification, run at once so the op's records go with this frame's BATCH (or `flushNow`).
    syncMix: () => {
      if (this.disposed) return;
      this.buses.replanBedsOnSettings();
      this.presence.settingsChanged(this.mixer);
      this.lanes.sync();
      this.loudness.liveApplied(); // Ld2: the live op sent its own LOUD_CONFIG (or changed nothing it carries)
    },
    session: this.session,
    firstFrame: () => this.clockMap.nextFirstFrame(),
    framesNow: () => this.clockMap.framesNow(),
    stampAt: (t) => this.clockMap.stampFor(this.clockMap.frameOfTime(t)),
    // §6.6: the preview path's coalescing window, on the page's clock.
    nowMs: () => performance.now(),
    setTimer: (fn, ms) => void setTimeout(fn, ms),
  });
  /** ADR 0171 (K0): the capture's event taps (`mix/profileSink.ts`); the null object until a recorder runs (Rc3). */
  profile: ProfileSink = NULL_PROFILE_SINK;
  /** Ld2: the page's loudness hub's wiring (`coreLoudness.ts`). */
  private readonly loudness: CoreLoudness;
  private get names(): string[] {
    return this.buses.names;
  }
  private get busIndexByName(): ReadonlyMap<string, number> {
    return this.buses.busIndexByName;
  }
  /** D5: voices played while locked (`voices.ts` owns the queue). */
  get lockedQueue(): UnlockQueue<number> {
    return this.voices.lockedQueue;
  }
  /** Each slot's `PlayRequest.owner`, for `debug()`'s voice rows (`voices.ts`). */
  private get owners(): readonly (string | null)[] {
    return this.voices.owners;
  }
  private idlePending = false;
  private master = 1;
  private isMuted = false;
  private get disposed(): boolean {
    return this.session.disposed;
  }
  private get recovering(): boolean {
    return this.session.recovering;
  }
  private readonly hrir: HrirLoader;
  private readonly magls: MaglsLoader;
  private readonly clipSink: { event(id: number, code: number): void };
  private readonly warnOnce: WarnOnce;
  private streamSink!: { event(id: number, code: number): void };

  constructor(
    readonly host: CoreBackendHost,
    deps: CoreBackendDeps & { clock: HostClock; clips: ClipRegistry },
  ) {
    this.mixer = deps.mixer ?? defaultMixer;
    this.warnOnce = deps.warnOnce ?? createWarnOnce();
    this.hostClock = deps.clock;
    this.clips = deps.clips;
    this.table = new VoiceTable(host.preset.maxLogical);
    this.selection = new Selection(this.table);
    this.panners = new PannerPick(this.table);
    this.pannerSink = { setPanner: (i, kind) => this.sendPanner(i, kind) };
    this.occlusion = new OcclusionPass(this.table.capacity);
    this.doppler = new DopplerPass(this.table.capacity);
    this.mirror = new StatusMirror(this.table, host.sampleRate);
    this.writer = new CommandWriter(host.link, host.sampleRate);
    // ADR 0162 (K4): the M3 parts that write through the writer and read the mirror.
    const preset = host.preset;
    this.voiceFx = new VoiceFx(this.table, this.writer);
    this.beds = new BedPlanner(this.writer, preset.maxBeds ?? 0);
    const streamDeps = deps.streams ?? {};
    // B4: the AAC build's worker when the project decodes AAC, else the default one.
    const decoder = streamDeps.decoder ?? (() => sharedDecoderClient(this.aac ? "aac" : "default"));
    this.decoderOf = decoder;
    // ADR 0331: the HRIR table and the MagLS filters are prepared for the context rate on that same worker.
    const prepare: SpatialPrepare = (kind, asset, rate) => {
      const worker = decoder() as StreamDecoderLike & Partial<Pick<DecoderClient, "prepareSpatial">>;
      if (!worker.prepareSpatial) return Promise.reject(new Error("audio: this decoder can't prepare the spatial assets"));
      return worker.prepareSpatial(kind, asset, rate);
    };
    this.hrir = deps.hrir ?? createHrirLoader({ clips: deps.clips, sampleRate: host.sampleRate, prepare });
    this.magls = deps.magls ?? createMaglsLoader({ clips: deps.clips, sampleRate: host.sampleRate, prepare });
    this.worklet = new WorkletChannel<StreamDecoderLike>({
      decoder,
      connectWorklet:
        streamDeps.connectWorklet ??
        ((port) => {
          if (!host.link.connectStreamPort) throw new Error("audio: this host can't connect the decoder worker to the worklet");
          host.link.connectStreamPort(port as MessagePort);
        }),
      channel: streamDeps.channel,
    });
    // ADR 0162 C9: kernels go to the worklet on that channel, from the streams' worker.
    const worklet = this.worklet;
    this.zoneIr =
      deps.zoneIr ??
      createZoneIrService({
        sampleRate: host.sampleRate,
        worklet: {
          ensure: () => {
            const decoder = worklet.ensure() as StreamDecoderLike & Partial<ZoneIrChannel>;
            if (!decoder.postIr || !decoder.onIr) throw new Error("audio: this decoder can't prepare zone impulse responses");
            return decoder as StreamDecoderLike & ZoneIrChannel;
          },
          get connections() {
            return worklet.connections;
          },
          onConnect: (listener) => worklet.onConnect(listener),
        },
      });
    this.zones = new ZoneManager({ writer: this.writer, fx: this.voiceFx, irs: this.zoneIr, mirror: this.mirror, maxZoneSlots: preset.maxZoneSlots ?? 0, zoneMaxSeconds: preset.zoneMaxSeconds ?? 0, sampleRate: host.sampleRate, wet: this.occlusion.wet });
    this.listener = new ListenerStage(this.writer);
    this.spatialVoices = new TableSpatialView(this.table, this.sendCurves, {
      setOcclusion: (i, gain, lpHz) => this.voices.setOcclusionAt(i, gain, lpHz),
      setDopplerRate: (i, factor) => this.voices.setDopplerRateAt(i, factor),
    });
    this.clockMap = new ClockMap(this.hostClock, host.sampleRate, limiterLatencyFrames(host.sampleRate, host.preset.limiterLookaheadMs));
    const fetchBytes =
      streamDeps.fetchBytes ??
      (async (path: string) => {
        // ADR 0351 §7 (W12): a packaged `stream` sound's loose media (music stems read it through here).
        const response = await fetch(packedMediaUrl(path) ?? Assets.url(path));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      });
    this.streams = new StreamManager({
      table: this.table,
      decoder,
      connectWorklet: () => {},
      worklet,
      fetchBytes,
      // ADR 0351 A4: entries of packages the worker holds stream from its copy.
      ...(streamDeps.packRef ? { packRef: streamDeps.packRef } : {}),
      onError: (id, asset, message, code) => this.voices.streamFailed(id, asset, message, code),
      sendSeek: (id, frame, epoch) => this.writer.seek(id, frame, epoch),
      // ADR 0162 B4: a FuMa stream's headroom scale multiplies its volume, as a FuMa clip's import volume.
      onImportGain: (id, gain) => this.voices.scaleVolume(id, gain),
      // E4.4: a stream loop's change lands at the end of the voice's current pass, predicted from its STATUS playhead
      // at the playhead estimate's rate (the estimate itself before the voice sounds).
      positionAt: (id, frame) => (this.table.isLive(id) ? this.playheads.positionNow(id & 0xffff, frame) : null),
      rateOf: (id) => this.playheads.rate[id & 0xffff] ?? 0,
    });
    this.streams.afterSeek = (voice, frame) => this.voices.reanchorSeek(voice, frame);
    // ADR 0166 (Q2): the music group operations, over closures to what they need of the backend (P1, P9 fill them).
    this.musicOps = new CoreMusicOps({
      table: this.table,
      writer: this.writer,
      mirror: this.mirror,
      clockMap: this.clockMap,
      streams: this.streams,
      worklet,
      decoder,
      fetchBytes,
      clips: this.clips,
      play: (req) => this.play(req),
      session: this.session,
      musicRings: () => this.host.preset.maxMusicRings ?? 0,
      sampleRate: () => this.clockMap.sampleRate,
      warnOnce: this.warnOnce,
      setStemLevel: (i, level, at, nowFrame, rampFrames, shape) => this.voices.setStemLevel(i, level, at, nowFrame, rampFrames, shape),
    });
    // ADR 0166 (Q2): stream event 4 and music members' stream events go to musicOps (`streams.ts`).
    this.streams.music = this.musicOps;
    // Stream voices' positions are in their stream's frames, at its rate (B3).
    // M2 F1: the tracker reads only `sampleRate` (per voice start and retime), so a clip's comes without an info object.
    const rateInfo = { sampleRate: 0 };
    this.playheads = new PlayheadTracker(
      this.table,
      {
        info: (id) => {
          const stream = this.streams.clipInfo(id);
          if (stream || !this.clips.sampleRate) return stream ?? this.clips.info(id);
          const rate = this.clips.sampleRate(id);
          if (rate === null) return null;
          rateInfo.sampleRate = rate;
          return rateInfo as unknown as ClipInfo; // read at once, never kept
        },
      },
      host.sampleRate,
    );
    // E4.4: where a voice's (unwrapped) playhead is in its sound: a stream by its map (regions, splices, seeks), a clip
    // in its SET_LOOP region (or the whole clip for a plain loop).
    this.playheads.wrap = (i, pos) => this.voices.wrapPlayhead(i, pos);
    this.automation = new CoreAutomation({
      table: this.table,
      writer: this.writer,
      clockMap: this.clockMap,
      playheads: this.playheads,
      // ADR 0360: a generator voice has no clip; its SET_LOOP (the key-off, region 0..0) counts in the context's frames.
      clipInfo: (i) => (this.table.genKind[i] !== 0 ? this.generatorClipInfo(i) : (this.table.flags[i]! & VoiceFlag.STREAM) !== 0 ? this.streams.clipInfo(this.table.clip[i]!) : this.clips.info(this.table.clip[i]!)),
      busIndex: (name) => this.busIndexByName.get(name) ?? -1,
      session: this.session,
      streamLoop: (i, loop, at) => this.streams.setLoop(this.table.clip[i]!, loop, at),
      writerBatches: () => this.writer.stats.batches,
      busView: (name, gain) => this.mixer._setAutomationView(name, gain),
      busSelection: (name, gain) => {
        const b = this.busIndexByName.get(name);
        if (b === undefined || b >= MAX_BUSES) return;
        this.lanes.selAuto[b] = gain;
        this.lanes.refreshBusGain();
      },
    });
    this.submixes = new CoreSubmixes({
      writer: this.writer,
      session: this.session,
      poolSize: () => this.mixer.audioSettings.voices.submixes,
      busIndex: (name) => this.busIndexByName.get(name) ?? -1,
      profile: () => this.profile,
      warnOnce: (key, message) => this.warnOnce(key, message),
    });
    this.plugins = new EffectPluginHost({
      post: (message, transfer) => host.link.postControl?.(message, transfer),
      warnOnce: (key, message) => this.warnOnce(key, message),
      profile: () => this.profile,
      kindsChanged: () => {
        if (!this.session.disposed) this.configureBuses(this.mixer);
      },
    });
    this.replayer = new Replayer(this.view, host.link);
    // ADR 0176: the core voice, over the parts above (closures read the backend lazily: the buses come next).
    this.voices = new CoreVoices({
      table: this.table,
      writer: this.writer,
      clockMap: this.clockMap,
      clips: this.clips,
      mixer: this.mixer,
      selection: this.selection,
      playheads: this.playheads,
      voiceFx: this.voiceFx,
      listener: this.listener,
      sendCurves: this.sendCurves,
      panners: this.panners,
      doppler: this.doppler,
      occlusion: this.occlusion,
      zones: this.zones,
      streams: this.streams,
      musicOps: this.musicOps,
      automation: this.automation,
      dip: this.dip,
      presence: this.presence,
      warnOnce: this.warnOnce,
      busNames: () => this.buses.names,
      busIndexByName: () => this.buses.busIndexByName,
      busRef: (bus) => this.buses.slots.busRef(bus),
      profile: () => this.profile,
      aac: () => this.aac,
      mixedCap: () => this.mixedCap(),
      maxWide: () => this.host.preset.maxWide ?? 0,
      session: this.session,
      holdStemResends: () => this.recovering || this.replayer.waitingForClock,
    });
    // ADR 0171 (K0): the per-concern modules (closures read the backend lazily).
    this.buses = new BusIndex({
      mixer: this.mixer,
      writer: this.writer,
      beds: this.beds,
      automation: this.automation,
      mirror: this.mirror,
      table: this.table,
      presence: this.presence,
      onCore: (i) => {
        const s = this.table.state[i]!;
        return s === VoiceState.PLAYING || s === VoiceState.VIRTUAL;
      },
      applyMix: (buses) => this.applyMix(buses),
      busesReset: () => this.session.busesReset(),
      moveVoice: (i, to) => this.voices.moveBus(i, to),
    });
    this.lanes = new LaneWriter({
      mixer: this.mixer,
      writer: this.writer,
      clockMap: this.clockMap,
      busIndexByName: this.buses.busIndexByName,
      busGain: this.selection.busGain,
      refreshSharedLowpass: () => this.refreshSharedLowpass(),
    });
    this.clipSink = { event: (id, code) => this.clips.applyClipEvent(id, code) };

    // STATUS: decode into one block, apply in onmessage.
    host.link.statusDecoder = (_buffer, view) => this.reader.readView(view);
    this.cleanups.push(this.mirror.attach(host.link));
    const unlisten = host.link.onShellEvent?.((event) => this.plugins.onShellEvent(event));
    if (unlisten) this.cleanups.push(unlisten);
    // B3, after the mirror: a stream voice that moves again is no longer waiting for data.
    this.cleanups.push(this.streams.attach(host.link));
    this.streamSink = { event: (id, code) => this.streams.streamEvent(id, code) };
    // Ld2: the loudness sections, after the mirror and the recorder tap (api §3.2).
    this.loudness = new CoreLoudness({ mixer: this.mixer, writer: this.writer, link: host.link, buses: () => this.buses, disposed: () => this.disposed });
    this.joinSession();
    // Voice ends free the slot's clip reference and the bus count (api §3 "Mixer counting").
    this.table.onFree = (id, bus) => this.voices.onFree(id, bus);
    this.cleanups.push(connectVoiceTable(this.table, host));
    this.cleanups.push(
      host.addLifecycleListener({
        onBusRemap: () => this.configureBuses(this.mixer),
        onIdle: () => {
          this.idlePending = true;
        },
        onClose: () => this.dispose(),
        onRebuildStart: () => this.session.beginRecovery(),
        onContextReplaced: (rate) => this.session.contextReplaced(rate),
        onRebuilt: () => this.session.endRecovery(),
        onRecoveryFailed: () => this.session.recoveryFailed(),
      }),
    );
    this.cleanups.push(
      this.mixer.onChange(() => {
        this.buses.replanBedsOnSettings();
        if (!this.disposed) this.presence.settingsChanged(this.mixer);
        if (!this.disposed) this.lanes.sync();
        this.loudness.sync(false); // Ld2: a settings edit of the meters, targets or loudnessResetOnPlay
      }),
    );
    this.configureBuses(this.mixer);
    // ADR 0171 (K0, Mx1's H2), 0175: `mixer.apply(op)` sends to `liveMix`; the mixer evaluates its ramps on the heard clock once
    // the core runs (`syncMixerClock`, each frame). Only the newest backend on a mixer clears them at its dispose (a
    // replacement is made before the old one goes).
    mixerOwners.set(this.mixer, this);
    this.mixer._setOpTarget(this.liveMix);
    this.mixer._setDuckSource(this.duckSource);
    this.cleanups.push(() => {
      if (mixerOwners.get(this.mixer) !== this) return;
      mixerOwners.delete(this.mixer);
      if (this.mixerOnHeardClock) this.mixer.setClock(null);
      this.mixerOnHeardClock = false;
      this.mixer._setOpTarget(null);
      this.mixer._setDuckSource(null);
    });
    // Ld2: the hub reads for the mixer, its gate sink, and each Engine's audio configure as a Play.
    this.loudness.attach();
  }

  /** ADR 0171 (K0): the mixer's ramps run on `heardClock` while this is true. */
  private mixerOnHeardClock = false;
  private readonly heardClock = (): number => this.time;
  /** Dp1: the heard time a stamped ramp written now starts at (the lane writer's stamp), for the mixer's ramp records. */
  private readonly stampClock = (): number => this.lanes.stampTime();
  /** Dp1: the mixer reads the duck lane from STATUS (`duckGain`); main computes no presence duck on this backend. */
  private readonly duckSource = (bus: string): number => this.duckGain(bus);
  /** Dp1: the table's queued commands go to the writer; an explicit stop ends the voice's presence at once (asap, with its STOP). */
  private readonly commandSink = {
    stop: (id: number, fadeSeconds: number): void => {
      this.presence.voiceStopped(this.table.bus[id & 0xffff]!, id & 0xffff);
      this.writer.stop(id, fadeSeconds);
    },
    fade: (id: number, to: number, seconds: number): void => this.writer.fade(id, to, seconds),
  };

  /**
   * ADR 0171 (K0, Mx1's H2): once the core runs and the clock map is anchored, the mixer evaluates fades, snapshots and
   * presence ducks on the heard clock (`Audio.time`'s base); before that (locked, loading) and after a failure, on its own
   * `dt` clock. Re-anchoring is the mixer's (`setClock` keeps each running ramp's remaining length).
   */
  private syncMixerClock(): void {
    const heard = this.host.status === "running" && this.clockMap.anchored;
    if (heard === this.mixerOnHeardClock || mixerOwners.get(this.mixer) !== this) return;
    this.mixerOnHeardClock = heard;
    this.mixer.setClock(heard ? this.heardClock : null, heard ? this.stampClock : null);
  }

  /** §1 `Audio.time`. */
  get time(): number {
    return this.clockMap.audioTime();
  }

  /** §1 `Audio.status`. */
  get status(): AudioStatus {
    return this.host.status;
  }

  private background: AudioBackground = "mute";

  /** §6 `setBackground`: what the host does when the page is hidden (`background.ts` applies it at the next hide). */
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }

  /** @internal The mode last set. */
  get backgroundMode(): AudioBackground {
    return this.background;
  }

  // --- Background hooks (A3.4b; `background.ts` is the `BackgroundTarget` caller) ---

  private hiddenMuteOn = false;
  private hidden = false;

  /** @internal MASTER is held at 0 by the hidden-page policy (a rebuild's replayed MASTER keeps it so). */
  get hiddenMuted(): boolean {
    return this.hiddenMuteOn;
  }
  /** @internal The background controller, when `createCoreBackend` made one (its counters feed `debug()`). */
  health: { readonly backgroundEnters: number; readonly interruptions: number } | null = null;

  /** @internal Runs `fn` when the backend is disposed. */
  addCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /** @internal STATUS blocks applied so far (the heartbeat the stall check watches). */
  get statusBlocks(): number {
    return this.mirror.blocks;
  }

  /** @internal Whether the page is hidden (for `debug()`). */
  get pageHidden(): boolean {
    return this.hidden;
  }

  /** @internal §3.8: while hidden no frame frees ended voices, so STATUS handling does (and frees what already ended). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    // ADR 0171 (K0): under `audio.background: "pause"` a hidden page records nothing until it shows: a GAP (§5.3).
    if (hidden && this.background === "pause") this.profile.gap("paused");
    this.mirror.freeEndedInMessage = hidden;
    if (hidden && !this.disposed) this.table.freeEnded();
  }

  /** @internal §3.8: MASTER to 0 (or back) over `rampMs`, flushed now since no frame will. `Audio.muted` and the volume are kept. */
  hiddenMute(on: boolean, rampMs: number): void {
    if (this.disposed) return;
    this.hiddenMuteOn = on;
    this.profile.hiddenTab(on);
    this.lanes.master(this.master, this.isMuted || on, Math.max(1, Math.round((rampMs / 1000) * this.host.sampleRate)));
    this.writer.flush(this.clockMap.nextFirstFrame());
  }

  /** @internal §3.8: the next frame re-anchors the clock map. */
  reanchor(): void {
    this.clockMap.reanchor();
  }

  /** ABI 4.8: STATUS `fxStarved` as last seen (a new core starts again from its own count). */
  private fxStarvedSeen = 0;

  /**
   * ADR 0345 (ABI 4.8): the core's effect memory ran out for an effect (it passes its signal through): one warning per
   * owner (a bus, a return, an instance submix), and `Audio.debug().mix.fxStarved` counts them.
   */
  private noteFxStarved(): void {
    const h = this.mirror.header;
    if (h.fxStarved === this.fxStarvedSeen) return;
    const grew = h.fxStarved > this.fxStarvedSeen;
    this.fxStarvedSeen = h.fxStarved;
    if (!grew) return;
    const who = fxStarvedOwnerName(h.fxStarvedOwner, this.names) ?? "an effect chain";
    this.warnOnce(`fx-starved:${who}`, `[myco] audio: an effect of ${who} got no effect memory (the audio core holds ${FX_MEMORY_SECONDS} s of stereo for delays, reverbs, chorus and pitch shifters) and passes its signal through; shorten delay times or run fewer of those effects (ADR 0345).`);
  }

  /** The bus names by index (root first), as last configured. */
  get busNames(): readonly string[] {
    return this.names;
  }

  /** Starts a clip. Returns null only when the backend can't play at all (the host failed). */
  play(req: CorePlayRequest): CoreVoice | null {
    if (this.disposed || this.host.status === "failed") return null;
    const head = this.prefetchHead(req);
    if (head) return this.playHeaded(req, head);
    // A3.4a: while locked or a hard rebuild runs, new plays wait in the locked queue (`voices.start` asks `maySend`).
    const id = this.voices.start(req);
    if (id === 0) return null;
    const voice = new Voice(this.voices, this.table, id, this.automation);
    this.automation.onPlay(voice, req);
    return voice;
  }

  /**
   * ADR 0351 §3 (W12): the resident prefetch head a stream play of a packaged `stream` sound starts on (frames and rate),
   * or null to stream as usual: no head, not resident, a stamp can't be exact (locked, a rebuild, no clock yet), or the
   * play asks for what a head can't give (a start offset, a span, a music member).
   */
  private prefetchHead(req: CorePlayRequest): { frames: number; rate: number } | null {
    if (!req.stream || req.music || req.span || (req.offset ?? 0) > 0 || !this.session.maySend || !this.clips.acquireSpan) return null;
    const packed = packedSound(req.path);
    if (!packed || packed.load !== "stream" || packed.headFrames <= 0) return null;
    // A peek: the package holds the head, so this reference changes nothing.
    const id = this.clips.acquireSpan(req.path, 0, packed.headFrames);
    const info = this.clips.info(id);
    this.clips.release(id);
    if (!info || info.state !== "ready" || !(info.sampleRate > 0) || info.frames <= 0) return null;
    const now = this.clockMap.framesNow();
    if (!(now > 0)) return null;
    return { frames: info.frames, rate: info.sampleRate };
  }

  /** W12: the head as a clip voice at T0 and the stream from the head's end at T0 + its length, as one voice (`headedVoice.ts`). */
  private playHeaded(req: CorePlayRequest, head: { frames: number; rate: number }): CoreVoice | null {
    const horizon = this.horizon();
    const at = req.at !== undefined && Number.isFinite(req.at) && req.at > horizon ? req.at : horizon;
    const pitch = req.pitch !== undefined && Number.isFinite(req.pitch) && req.pitch > 0 ? req.pitch : 1;
    const bodyId = this.voices.start({ ...req, at: at + head.frames / (head.rate * pitch), streamStartFrame: head.frames });
    if (bodyId === 0) return null;
    const body = new Voice(this.voices, this.table, bodyId, this.automation);
    this.automation.onPlay(body, req);
    const headId = this.voices.start({ ...req, stream: false, loop: false, at, span: { startFrame: 0, endFrame: head.frames } });
    if (headId === 0) return body;
    return headedVoice(new Voice(this.voices, this.table, headId, this.automation), body);
  }

  /** The listener pose the spatial voices' distance gains and directions come from (`voices.setListener`). */
  setListener(pose: ListenerPose): void {
    this.voices.setListener(pose);
  }

  /** The bus lanes that moved (`laneWriter.ts`, Mx2): read from the mixer's lane ramps, so `buses` is unused. */
  applyMix(buses: readonly ResolvedBus[]): void {
    if (this.disposed) return;
    this.lanes.applyMix(buses);
  }

  /**
   * ADR 0162 (A5, S3): the sharing chain's snapshot low-pass. A voice on the bed (kind 2) of an ancestor's slot skips the
   * buses between its own and the host, so main folds their snapshot cutoffs into its low-pass (`LowpassBy.SNAPSHOT`,
   * the lowest wins); the core folds the gains. Run where a snapshot's cutoff or the bed plan changes.
   */
  private refreshSharedLowpass(): void {
    if (!this.beds.foldLowpass(this.lanes.snapLp, this.lanes.selCount)) return;
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] === VoiceState.FREE) continue;
      this.voiceFx.setLowpass(i, LowpassBy.SNAPSHOT, this.panners.kindOf(i) === PannerKind.BED ? this.beds.chainLowpass[t.bus[i]!]! : BUS_LP_OFF_HZ);
    }
  }
  /** R13: game time, ms (the kind dwell's clock). */
  private gameMs = 0;

  /** Rebuilds the core's bus tree: the session's `reconfigure` phase (queued live adds go, BUS_CONFIG and every bus lane, LOUD_CONFIG). */
  configureBuses(mixer: Mixer): void {
    this.session.reconfigure(mixer);
  }

  /** BUS_CONFIG's buses for the tree last configured, root first (also the hard rebuild's replay, A3.4a; `busIndex.ts`). */
  busConfigWire(mixer: Mixer = this.mixer): BusConfigBuses[] {
    return this.buses.busConfigWire(mixer);
  }

  get masterVolume(): number {
    return this.master;
  }

  set masterVolume(v: number) {
    this.master = clamp(Number.isFinite(v) ? v : 1, 0, 1);
    this.lanes.master(this.master, this.isMuted || this.hiddenMuteOn, this.clockMap.rampFrames());
    if (this.profile !== NULL_PROFILE_SINK) this.profile.masterChange(this.master, this.isMuted || this.hiddenMuteOn);
  }

  get muted(): boolean {
    return this.isMuted;
  }

  set muted(m: boolean) {
    this.isMuted = m;
    this.lanes.master(this.master, m || this.hiddenMuteOn, this.clockMap.rampFrames());
    if (this.profile !== NULL_PROFILE_SINK) this.profile.masterChange(this.master, m || this.hiddenMuteOn);
  }

  /** B4: `audio.codecs.aac` (read when used, like the rest of the settings). */
  private get aac(): boolean {
    return this.mixer.audioSettings.codecs?.aac === true;
  }

  /** ADR 0162 (K4) `StagedFrameHost`: frame start through attenuation (gain, direction, `audibility0`). */
  frameAttenuate(dt: number): void {
    if (this.disposed) return;
    // R13: the panner kind dwell runs in game time (`dt` is 0 while `Time.scale` is 0).
    if (dt > 0) this.gameMs += dt * 1000;
    const clockMap = this.clockMap;
    clockMap.beginFrame();
    // A3.4c: after a context swap, the old core's last STATUS is in the old context's frames: wait for the new one's.
    if (this.mirror.blocks > this.staleBlocks) clockMap.noteStatus(this.mirror.frameAudio, this.mirror.frameDateMs);
    this.syncMixerClock();
    this.mirror.beginFrame();
    this.noteFxStarved();
    // F-9b: stem levels whose stamps come before this frame's asap records land (selection and dry-gain writes read them).
    // Asap records apply on arrival, about `framesNow`; a stamp after that is still pending (`ClockMap.stampFor`'s rule).
    this.table.resolveStems(clockMap.framesNow());
    this.publishPeaks();
    this.table.freeEnded();
    this.mirror.drainClipEvents(this.clipSink);
    this.mirror.drainStreamEvents(this.streamSink);
    this.musicOps.beginFrame(); // ADR 0166 (Q2): this frame's music STATUS when step 0 didn't run (P1)
    this.replayer.flush();
    this.automation.beginFrame();
    this.voices.unlock(); // the locked queue drains once the session may send
    this.musicOps.sendHeld(); // ADR 0294: then the stamped ramps and primes held meanwhile, after the members' PLAYs
    this.voices.moveSpatial();
  }

  /** ADR 0162 (K4) `SpatialPassHost`: this frame's voices for main's passes (after attenuation, before Doppler). */
  collectSpatialVoices(): void {
    if (this.disposed) return;
    this.spatialVoices.collect();
  }

  /** ADR 0162 (K4) `StagedFrameHost`: audibility = `audibility0` × `occGain`, and the selection. */
  frameSelect(): void {
    if (this.disposed) return;
    this.voices.select();
  }

  /** ADR 0162 (K4) `StagedFrameHost`: the panner kinds. */
  framePickPanners(): void {
    if (this.disposed) return;
    this.pickPanners();
  }

  /** ADR 0162 (K4) `StagedFrameHost`: per-voice fx changes past their thresholds. */
  frameStageFx(): void {
    if (this.disposed) return;
    this.voiceFx.flush(this.clockMap.rampFrames());
  }

  /** ADR 0162 (K4) `StagedFrameHost`: LISTENER when the rotation moved. */
  frameStageListener(frame: ListenerFrame): void {
    if (this.disposed) return;
    this.listener.stage(frame, this.clockMap.rampFrames());
  }

  /** ADR 0162 (K4) `StagedFrameHost`: idle check, the table's queued commands, and the frame's BATCH. */
  frameCommit(): void {
    if (this.disposed) return;
    if (this.idlePending) this.checkIdle();
    this.voices.resendStaleStems(); // F-12
    this.table.drainCommands(this.commandSink);
    this.dip.update(this.clockMap.framesNow());
    // E2: a mute in force (master, hidden tab, or any bus's authored or script mute) or MASTER not 1 suspends the loudness target check.
    this.loudness.frame(this.isMuted || this.hiddenMuteOn || this.mixer.anyMuted(), this.master !== 1);
    // A3.4a: during a rebuild (or after recovery gave up) no core keeps what is sent; the replay re-derives it all.
    if (!this.session.mayQueue) this.writer.clear();
    else if (this.writer.pending > 0) this.writer.flush(this.clockMap.nextFirstFrame());
  }

  // --- The core session (ADR 0178; `recovery.ts` drives the host's rebuild, `replay.ts` restores the voices) ---

  /** STATUS blocks that came from a context since replaced: the clock map's fallback ignores them (A3.4c). */
  private staleBlocks = 0;

  /**
   * ADR 0178: every part with lifecycle work joins the session here (the replayer joins itself as "replayer", "reset"
   * and "voiceState"; `loudness` and `worklet` implement their phases themselves). Which phases each runs in, and in what
   * order, is `PHASE_ORDER` in `session.ts`.
   */
  private joinSession(): void {
    const s = this.session;
    const { voices, clockMap, mirror } = this;
    // Ma3: a reconfigure starts from the settings, and a failed or disposed backend applies nothing: no queued live add survives.
    const clearAdds = () => this.deferredAdds.clear();
    s.join("deferredAdds", { reconfigure: clearAdds, recoveryFailed: clearAdds, dispose: clearAdds });
    s.join("buses", {
      reconfigure: (mixer) => this.buses.configureBuses(mixer),
      // ADR 0344: the sends into returns after the tree (they name bus slots).
      replayHeader: (b) => {
        replayBusConfig(b, this.busConfigWire());
        this.buses.replaySends(b);
      },
    });
    s.join("loudness", this.loudness);
    s.join("voices", {
      busesReset: () => voices.busesReset(),
      beginRecovery: () => voices.beginRecovery(), // F-12: the replay sends every gain again; pending frames change meaning
      recoveryFailed: () => voices.recoveryFailed(),
      dispose: () => voices.dispose(),
      // B3, FU2: each live stream reopens with a new stream id at one stamp `reopenStamp` ahead, from where its own position reaches there.
      reopenStreams: (ids) => voices.reopenStreams(ids, reopenStamp(clockMap.framesNow(), clockMap.sampleRate)),
    });
    s.join("lanes", { busesReset: () => this.lanes.busesReset(), replayHeader: (b) => this.lanes.replayLanes(b) });
    s.join("worklet", this.worklet);
    s.join("dip", { beginRecovery: () => this.dip.replayEndState() });
    // A3.4c, architecture §3.7: the clock map takes the new rate and the limiter latency at it and keeps `Audio.time`
    // continuous from the old clock's newest estimate; the writer converts seconds at the new rate. The HRIR and the MagLS
    // filters are resampled for it from their original assets (clips keep their own rate).
    const limiter = (rate: number) => limiterLatencyFrames(rate, this.host.preset.limiterLookaheadMs);
    s.join("clock", {
      contextReplaced: (rate) => {
        clockMap.rebase(rate, limiter(rate), clockMap.carryPoint());
        this.writer.sampleRate = rate;
      },
    });
    s.join("hrir", {
      contextReplaced: (rate) => {
        this.hrir.retarget?.(rate);
        this.magls.retarget(rate);
      },
    });
    s.join("zones", { contextReplaced: (rate) => this.zones.contextReplaced(rate), replayHeader: (b) => this.zones.replay(b), dispose: () => this.zones.dispose() });
    s.join("mirror", {
      contextReplaced: (rate) => {
        this.staleBlocks = mirror.blocks;
        mirror.cpu.setSampleRate(rate);
      },
      endRecovery: () => mirror.resetPeaks(),
    });
    s.join("beds", { replayHeader: (b) => this.beds.replay(b) });
    s.join("presence", { replayHeader: (b) => this.presence.replay(b) });
    s.join("master", { replayHeader: (b) => replayMaster(b, this.master, this.isMuted || this.hiddenMuteOn) });
    s.join("listener", { replayHeader: (b) => this.listener.replay(b) });
    s.join("automation", { replayHeader: (b) => this.automation.replayHeader(b), replayVoice: (b, v) => this.automation.replayVoice(b, v.id, v.i) });
    s.join("effectPlugins", { endRecovery: () => this.plugins.replay(), dispose: () => this.plugins.dispose() });
    s.join("submixes", { replayHeader: (b) => this.submixes.replayHeader(b), busesReset: () => this.submixes.busesReset(), dispose: () => this.submixes.clear() });
    s.join("voiceFx", { replayVoice: (b, v) => (v.mixed ? this.voiceFx.replayVoice(b, v.id, v.i) : undefined) });
    s.join("musicOps", {
      beginRecovery: () => this.musicOps.rebuilding(true),
      endRecovery: () => this.musicOps.rebuilding(false),
      recoveryFailed: () => this.musicOps.rebuilding(false),
      reopenStreams: () => this.musicOps.reopenGroups(),
      dispose: () => this.musicOps.dispose(),
    });
    s.join("streams", { dispose: () => this.streams.dispose() });
    s.join("cleanups", { dispose: () => this.cleanups.splice(0).forEach((c) => c()) });
    s.join("link", {
      dispose: () => {
        this.table.onFree = null;
        this.host.link.statusDecoder = readStatus;
      },
    });
    // A3.4a: after recovery gave up, or once disposed, no core keeps what is staged.
    s.join("writer", { recoveryFailed: () => this.writer.clear(), dispose: () => this.writer.clear() });
    // Every place `PHASE_ORDER` declares is filled (the replayer joined in its constructor).
    s.requireComplete();
  }

  /** `Bus.peak` (A2.3): the newest STATUS peaks (already decayed in the core) by bus name; 0 while locked and past the 32 the core reports. */
  private publishPeaks(): void {
    const m = this.mirror;
    const running = this.host.status === "running";
    const names = this.names;
    for (let b = 0; b < names.length; b++) {
      const peak = running && b < m.peakCount ? Math.max(m.peakL[b]!, m.peakR[b]!) : 0;
      this.mixer._setPeak(names[b]!, peak);
    }
  }

  /**
   * The mixed cap selection uses (architecture §6.3): `min(voices.mixed, mixedCap)`, where `mixedCap` is STATUS's: the
   * core's adaptive cap (A3.3), through the mirror. Before the first STATUS it is `voices.mixed`. `Audio.debug()`
   * reports this value as `counters.mixedCap`.
   */
  mixedCap(): number {
    const configured = this.host.preset.maxMixed ?? this.table.capacity;
    return effectiveMixedCap(configured, this.mirror.header.mixedCap);
  }

  /**
   * Architecture §3.9: World `key`'s voices are audible, or forced virtual (in time, silent) while it doesn't have the
   * view. Takes effect at the next frame's selection. Key 0 (no World) is always audible.
   */
  setWorldAudible(key: number, audible: boolean): void {
    this.selection.setWorldAudible(key, audible);
  }

  /** True once the core reported hrtfReady for the HRIR table (spatial voices stay equal-power until then). */
  get hrtfReady(): boolean {
    return this.hrir.ready;
  }

  /** ADR 0162 (A5): the MagLS bed filters failed to load (beds decode through the matrix: `bedFilterLoadFailure`). */
  get maglsFailed(): boolean {
    return this.magls.failed;
  }

  /** H3, STATUS `hrtfLoadFailure` with main's part: 2 when the core found the table invalid, 1 when the fetch failed, else 0. */
  get hrtfLoadFailure(): number {
    return this.mirror.header.hrtfLoadFailure || (this.hrir.failed ? 1 : 0);
  }

  /** H3: the panner kind the core holds for slot `i` (0 equal-power, 1 HRTF), which a rebuild's replayed PLAY carries. */
  hrtfPanner(i: number): number {
    return this.panners.panner(i);
  }

  /** H3's name for the panner pick (`debug.ts`'s `hrtf`). */
  private get hrtf(): PannerPick {
    return this.panners;
  }

  /** `Audio.debug()` (K10): delegates to `debug.ts`. */
  debug(): AudioDebugInfo {
    const info = buildDebugInfo(this.view);
    // ADR 0171 (Mx2): each bus row's last stamped BUS_RAMP start frame.
    info.buses.forEach((row, b) => {
      const frame = this.lanes.lastRampStartFrame(b);
      if (frame !== undefined) row.lastRampStartFrame = frame;
    });
    // ADR 0171 (K0): the M5 sections, empty until their tasks fill them (Dbg1, Cp2, Rc2), and the core's STATUS frame.
    info.core.currentFrame = this.mirror.header.currentFrame;
    info.mixCaps = { ...this.mixCaps };
    info.cpu = this.cpu();
    info.mix = this.mixDebug();
    info.recorder = null;
    // ADR 0352 §6: the registered plugin effects (none: no section).
    const plugins = this.plugins.health();
    if (plugins.length > 0) info.plugins = plugins.map((p) => ({ ...p, faults: { ...p.faults } }));
    return info;
  }

  // --- ADR 0171 amended by 0172 (M5, contract K0): the mix members; each delegates to its per-concern module ---

  /** §1.3: the core reports every flag true and `capture: "full"` (Dbg1 tests the flags per backend). */
  readonly mixCaps: AudioMixCaps = { loudness: true, levelDucking: true, cpu: true, cpuReason: null, stampedBusRamps: true, capture: "full" };

  /** §1.3, architecture §4.3: Cp2 fills it from `mix/cpuMeter.ts`; until then "not yet measured". `debug()` reads it (not part of the seam, ADR 0179). */
  private cpu(): AudioCpuDebug {
    return this.mirror.cpu.debug();
  }

  /** §1.3 `Audio.debug().mix` (Dbg1): the slot table reads the identity layout until Ma1 wires the table in. */
  private mixDebug(): AudioMixDebug {
    return mixDebugInfo(this.view, this.liveMix.refused, this.deferredAdds.count);
  }

  /** §6.2, ADR 0175: where `mixer.apply` sends a checked op (`liveMix.ts`). */
  get mixOpTarget(): MixOpTarget {
    return this.liveMix;
  }

  /** §6.6: post the pending batch now (Ma1). */
  flushNow(): void {
    this.liveMix.flushNow();
  }

  /** §1.1 `Bus.duckGain`: the STATUS `busDuck` section's gain for `bus` (a block old); 1 when no rule ducks it. The mixer reads it through `duckSource` (not part of the seam, ADR 0179). */
  private duckGain(bus: string): number {
    const b = this.busIndexByName.get(bus);
    if (b === undefined) return 1;
    const m = this.mirror;
    for (let k = 0; k < m.duckCount; k++) if (m.duckSlot[k] === b) return m.duckGain[k]!;
    return 1;
  }

  /** Architecture §2.1: the recorder's STATUS tap, set on the link (`CoreLink.handleMessage` calls it before RECYCLE). */
  get recorderTap(): RecorderTap | null {
    return (this.host.link as { recorderTap?: RecorderTap | null }).recorderTap ?? null;
  }
  set recorderTap(tap: RecorderTap | null) {
    (this.host.link as { recorderTap?: RecorderTap | null }).recorderTap = tap;
  }

  /** §5.6: the capture's event taps (Rc3); null restores the null object. Recovery reports EPOCH and GAP to the same sink. */
  setProfileSink(sink: ProfileSink | null): void {
    this.profile = sink ?? NULL_PROFILE_SINK;
    setRecoveryProfileSink(sink);
    // Rc3: one sink reaches the voice table, the mixer's setters and the page-wide event and music taps (null restores every null object).
    wireProfileTaps(sink, {
      table: this.table,
      mixer: this.mixer,
      sampleRate: () => this.host.sampleRate,
      names: {
        clip: (id, stream) => (stream ? (this.streams.assetOf(id) ?? "") : (this.clips.info(id)?.path ?? "")),
        busRef: (i) => this.buses.slots.busRef(i),
      },
      busRef: (n) => this.buses.slots.busRef(this.buses.slotOf(n)),
    });
  }

  private keyframes: KeyframeSource | null = null;

  /** §5.5 (G7b): the backend's part of the capture's KEYFRAME from main's tables, built by `keyframeSource.ts` (the voice table, the slot table and mixer lanes, the loudness hub); the event and music rows come from above the seam (ADR 0249). */
  keyframe(nameId: Parameters<AudioCaptureSource["keyframe"]>[0], noName = 0xffffffff): BackendKeyframe {
    return (this.keyframes ??= new KeyframeSource(this.view)).read(nameId, noName);
  }

  /** The view `view` holds (built once, at construction; its getters read the backend's fields when called). */
  private createView(): CoreView {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters read the backend lazily
    const b = this;
    return {
      get host() {
        return b.host;
      },
      get status() {
        return b.status;
      },
      get time() {
        return b.time;
      },
      get backgroundMode() {
        return b.backgroundMode;
      },
      get busNames() {
        return b.busNames;
      },
      get mirror() {
        return b.mirror;
      },
      get table() {
        return b.table;
      },
      get writer() {
        return b.writer;
      },
      get clips() {
        return b.clips;
      },
      get owners() {
        return b.owners;
      },
      get streams() {
        return b.streams;
      },
      get mixer() {
        return b.mixer;
      },
      get deferredAdds() {
        return b.deferredAdds;
      },
      get lockedQueue() {
        return b.lockedQueue;
      },
      get automation() {
        return b.automation;
      },
      get playheads() {
        return b.playheads;
      },
      get hrtfReady() {
        return b.hrtfReady;
      },
      get hrtfLoadFailure() {
        return b.hrtfLoadFailure;
      },
      get hrtf() {
        return b.hrtf;
      },
      get beds() {
        return b.beds;
      },
      get panners() {
        return b.panners;
      },
      get voiceFx() {
        return b.voiceFx;
      },
      get zones() {
        return b.zones;
      },
      get occlusion() {
        return b.occlusion;
      },
      get doppler() {
        return b.doppler;
      },
      get maglsFailed() {
        return b.maglsFailed;
      },
      get health() {
        return b.health;
      },
      get pageHidden() {
        return b.pageHidden;
      },
      mixedCap: () => b.mixedCap(),
      get clockMap() {
        return b.clockMap;
      },
      get musicOps() {
        return b.musicOps;
      },
      get buses() {
        return b.buses;
      },
      get masterVolume() {
        return b.masterVolume;
      },
      get hiddenMuted() {
        return b.hiddenMuted;
      },
      get session() {
        return b.session;
      },
      hrtfPanner: (i) => b.hrtfPanner(i),
      ampEnvelope: (i, frame) => b.voices.replayEnvelope(i, frame),
    };
  }

  /** The session's `dispose` phase (once). */
  dispose(): void {
    this.session.dispose();
  }

  /** ADR 0166 (G-1): Δ̄, seconds (the clock map's frame-interval EMA). */
  frameMap(): AudioFrameMap {
    const m = this.clockMap;
    return { sampleRate: m.sampleRate, timeOffset: m.timeOffset, carryPending: m.carryPending };
  }

  frameInterval(): number {
    return this.clockMap.frameIntervalMs / 1000;
  }

  /** ADR 0166 (G-1): a decoded clip's facts; its length is exact (decoded to PCM), so it is gapless. Undefined while unknown. */
  clipFacts(path: string): { frames: number; rate: number; channels: number; gapless: boolean } | undefined {
    const info = this.clips.infoByPath?.(path);
    return info ? { frames: info.frames, rate: info.sampleRate, channels: info.channels, gapless: true } : undefined;
  }

  /** ADR 0166 C14 (R4a): a reference to the decoded span `[startFrame, endFrame)` of `path`, so a later play of it starts on its stamp. */
  holdSpan(path: string, startFrame: number, endFrame: number): ClipSpanHold {
    const clips = this.clips;
    if (!clips.acquireSpan) return { state: "failed", failure: "refusedSpan", release: () => {} };
    let id = clips.acquireSpan(path, startFrame, endFrame);
    return {
      get state() {
        if (id === 0) return "failed";
        const st = clips.state(id);
        return st === "ready" ? "ready" : st === "failed" ? "failed" : "loading";
      },
      get failure() {
        return id === 0 ? null : (clips.info(id)?.failure ?? null);
      },
      release() {
        if (id !== 0) clips.release(id);
        id = 0;
      },
    };
  }

  /** ADR 0166 (P8): the file at `path` was edited: the registry's clips of it and the worker's encoded music bytes are dropped; the next use loads the new file. */
  invalidateClip(path: string): void {
    this.clips.invalidate?.(path);
    this.musicOps.invalidate(path);
  }

  /** ADR 0158: the clip's length in seconds at pitch 1 once the registry has decoded it; null while unknown (or streamed). */
  clipDuration(path: string): number | null {
    return this.clips.duration?.(path) ?? null;
  }

  /**
   * ADR 0158: the earliest `Audio.time` a play with `at` lands on exactly: the time of frame *F*_now + L (a stamp the
   * writer keeps, `lookahead.ts`). Before the clock has an estimate, `time` (such a play goes asap).
   */
  horizon(): number {
    const clock = this.clockMap;
    const now = clock.framesNow();
    if (!(now > 0)) return this.time;
    return Math.ceil(now + clock.lookaheadFrames()) / clock.sampleRate + clock.timeOffset;
  }

  // --- ADR 0166 (Q2): the music seam (`backend.ts` `MusicBackend`, `beginFrame`, `timeAt`, `latency`) ---

  /** §4.6, C10: the music group operations (`musicOps.ts`). */
  get music(): MusicBackend {
    return this.musicOps;
  }

  /**
   * §6 step 0 (R17): the clock map's frame start and this frame's music STATUS, before scripts run, so `update()` reads
   * this frame's `Audio.time`. Idempotent per frame: `ClockMap.beginFrame` does nothing the second time at the same rAF
   * time, and `frameAttenuate` repeats the same steps. The audio system calls it only while music plays.
   */
  beginFrame(): void {
    if (this.disposed) return;
    const clockMap = this.clockMap;
    clockMap.beginFrame();
    if (this.mirror.blocks > this.staleBlocks) clockMap.noteStatus(this.mirror.frameAudio, this.mirror.frameDateMs);
    this.syncMixerClock();
    this.musicOps.beginFrame();
  }

  /**
   * §1.3 `Audio.timeAt` (R18: the raw map, calibration never applied): the heard time of the `performance.now()` instant
   * `performanceTime` (ms) by the clock map's offset filter. `Audio.time` while the clock has no output-timestamp estimate
   * (the fallback, or a rebuild's carry).
   */
  timeAt(performanceTime: number): number {
    const clock = this.clockMap;
    if (!clock.anchored || clock.carryPending || !Number.isFinite(performanceTime)) return this.time;
    const sr = clock.sampleRate;
    return Math.max(0, ((performanceTime * sr) / 1000 + clock.offsetFrames - clock.outputLatencyFrames) / sr) + clock.timeOffset;
  }

  /**
   * §1.3 `Audio.latency`, seconds: the context's base and output latency (`host.latency`, Rh1's read-back; 0 without it),
   * the core's limiter look-ahead, their total, and `reliable` (0 < output < 0.5, S13).
   */
  latency(): AudioLatency {
    const ctx = this.host.latency?.();
    const base = ctx && Number.isFinite(ctx.base) ? Math.max(0, ctx.base) : 0;
    const output = ctx && Number.isFinite(ctx.output) ? Math.max(0, ctx.output) : 0;
    const limiter = this.clockMap.outputLatencyFrames / this.clockMap.sampleRate;
    return { base, output, limiter, total: base + output + limiter, reliable: output > 0 && output < 0.5 && ctx?.reliable !== false };
  }

  // --- The voice (`voices.ts`, ADR 0176): the handles and the passes call it ---

  /** ADR 0264 `SpatialPassHost.velocityOf` (D3 `AudioSource.velocity`): through `voices.velocityOf`. */
  velocityOf(id: number, out: { x: number; y: number; z: number }): boolean {
    return this.voices.velocityOf(id, out);
  }

  /**
   * B3, a hard rebuild's stream hand-off: the session's `reopenStreams` phase (each live stream reopens with a new stream
   * id, FU2's stamp ahead; music group members are skipped there and their groups reopen as groups, ADR 0166 P9).
   */
  reopenStreams(ids: readonly number[]): void {
    this.session.reopenStreams(ids);
  }

  /**
   * The panner kinds after selection (`pannerPick.ts`): the top `voices.hrtf` mixed spatial voices by audibility get HRTF
   * while `audio.spatial` is `"hrtf"` and the table hasn't failed to load (the first starts the lazy HRIR fetch; until
   * the core has it they pan equal-power, then crossfade), and the other mixed spatial voices go to the bed where their
   * bus has one (the first bed hosted starts the MagLS fetch in HRTF mode; `"equalPower"` keeps beds and fetches nothing,
   * R9). With neither, every voice is equal-power.
   */
  private pickPanners(): void {
    const settings = this.mixer.audioSettings;
    const hrtfOn = settings.spatial === "hrtf";
    const limit = hrtfOn && this.hrtfLoadFailure === 0 ? settings.voices.hrtf : 0;
    const beds = this.beds.slotCount > 0;
    if ((limit <= 0 && !beds) || this.voices.spatialCount === 0) {
      if (this.panners.count > 0 || this.panners.bedCount > 0) this.panners.clear(this.pannerSink);
      return;
    }
    if (beds && hrtfOn) this.magls.ensure();
    const limits = this.pannerLimits;
    limits.hrtf = limit;
    limits.nowMs = this.gameMs;
    limits.bedSlot = this.beds.bedSlot;
    limits.bedOnly = beds ? this.markBedOnly(settings.bed.beyond) : undefined;
    if (this.panners.run(limits, this.pannerSink) > 0) this.hrir.ensure();
  }
  /** ADR 0162 (K4): the panner pick's inputs, reused (`bedSlot` is the bed planner's live map). */
  private readonly pannerLimits: { hrtf: number; nowMs: number; bedSlot: ArrayLike<number>; bedOnly: ArrayLike<number> | undefined } = { hrtf: 0, nowMs: 0, bedSlot: new Uint8Array(0), bedOnly: undefined };
  /** ADR 0347: per slot, 1 for a voice the pick sends to its bus's bed whatever its rank (reused). */
  private bedOnly = new Uint8Array(0);

  /**
   * ADR 0347: marks the spatial voices that go to their bus's bed whatever their rank: those asking for it (an audio
   * zone's interior, `PlayRequest.bed`) and those farther from the listener than `beyond` metres (`audio.bed.beyond`,
   * the project's `settings.bedBeyond`; absent or 0: none by distance).
   */
  private markBedOnly(beyond: number | undefined): Uint8Array {
    const t = this.table;
    if (this.bedOnly.length !== t.capacity) this.bedOnly = new Uint8Array(t.capacity);
    const out = this.bedOnly;
    const far = beyond !== undefined && Number.isFinite(beyond) && beyond > 0 ? beyond : Infinity;
    for (let i = 0; i < t.capacity; i++) {
      out[i] = (t.flags[i]! & VoiceFlag.SPATIAL) !== 0 && t.state[i] !== VoiceState.FREE && ((t.flags2[i]! & VoiceFlag2.BED) !== 0 || this.voices.distanceOf(i) > far) ? 1 : 0;
    }
    return out;
  }

  /** H3, ADR 0162 C1: SET_PARAMS `flags` for slot `i`'s panner kind (0 equal-power, 1 HRTF, 2 bed). */
  private sendPanner(i: number, kind: PannerKindCode): void {
    const t = this.table;
    this.writer.setPanner(((t.gen[i]! << 16) | i) >>> 0, kind);
    // A voice on the bed takes its sharing chain's snapshot low-pass; one leaving it drops it.
    if (kind === PannerKind.BED || this.beds.slotCount > 0) this.voiceFx.setLowpass(i, LowpassBy.SNAPSHOT, kind === PannerKind.BED ? this.beds.chainLowpass[t.bus[i]!]! : BUS_LP_OFF_HZ);
  }

  /** `onIdle`: RESET 0 once no voice is live and no clip is resident (the registry unloads one frame after the World left). */
  private checkIdle(): void {
    if (this.host.worldCount > 0) {
      this.idlePending = false;
      return;
    }
    if (this.table.liveCount > 0 || this.clips.residentIds().length > 0) return;
    this.idlePending = false;
    this.writer.reset(false);
    // RESET 0 clears the core's automation tables too: the mirror goes again, spread over frames.
    this.automation.afterReset();
  }
}

/**
 * One voice: an adapter from `AudioVoice` to the core voice (`voices.ts`, ADR 0176), by id; every call there checks the id
 * is still live. M2 F1: the voice is its own `AudioHandle` (one object per voice start, not two): `playing`, `alive`,
 * `reason`, `stop` and `fade` are the handle's, with M1's semantics; `handle` is the voice itself.
 */
class Voice extends AudioHandle implements CoreVoice {
  constructor(
    private readonly voices: CoreVoices,
    table: VoiceTable,
    id: number,
    /** ADR 0264: the voice's loop region goes through the core's automation sink (SET_LOOP, stamped behind its PLAY). */
    private readonly loops: Pick<CoreAutomation, "setLoop">,
  ) {
    super(table, id);
  }

  get handle(): AudioHandle {
    return this;
  }

  setVolume(v: number): void {
    this.voices.setVolume(this.id, v);
  }

  setPitch(rate: number): void {
    this.voices.setPitch(this.id, rate);
  }

  setAttenuation(a: Attenuation): void {
    this.voices.setAttenuation(this.id, a);
  }

  setPosition(p: Vec3Like): void {
    this.voices.setPosition(this.id, p);
  }

  setBus(bus: string): void {
    this.voices.setBus(this.id, bus);
  }

  setPriority(priority: number): void {
    this.voices.setPriority(this.id, priority);
  }

  pause(at?: number): void {
    this.voices.setPaused(this.id, true, at);
  }

  resume(at?: number): void {
    this.voices.setPaused(this.id, false, at);
  }

  seek(seconds: number): void {
    this.voices.seek(this.id, seconds);
  }

  setLoop(start: number, end: number, looping: boolean): void {
    this.loops.setLoop(this, start, end, looping);
  }

  /** ADR 0166 §4.2 (Q2): a shaped, stamped fade of the `fade` ramp (`musicOps.fadeShaped`, P1). */
  fadeShaped(f: ShapedFade): void {
    this.voices.fadeShaped(this.id, f);
  }

  /** ADR 0166 (G-1): a stamped gain and/or low-pass ramp with a law (`musicOps.paramsShaped`). */
  paramsShaped(r: ShapedParams): void {
    this.voices.paramsShaped(this.id, r);
  }

  // ADR 0162 (K0, K4): main's M3 results and options.
  setVelocity(v: Vec3Like): void {
    this.voices.setVelocity(this.id, v);
  }

  setOcclusion(gain: number, lpHz: number): void {
    this.voices.setOcclusion(this.id, gain, lpHz);
  }

  get panner(): AudioPanner | null {
    return this.voices.pannerOf(this.id);
  }

  get occlusion(): number {
    return this.voices.occlusionOf(this.id);
  }

  setDopplerRate(factor: number): void {
    this.voices.setDopplerRate(this.id, factor);
  }

  setSpatialOptions(o: VoiceSpatialOptions): void {
    this.voices.setSpatialOptions(this.id, o);
  }
}

/**
 * ADR 0162 (K4): the core's `SpatialVoiceView` over its voice table (`spatial.ts`). `collect` lists the voices on the core
 * (PLAYING or VIRTUAL) once per frame and computes their view flags; the per-slot arrays are the table's own. Results go
 * to the core voice (`voices.setOcclusionAt`, `setDopplerRateAt`), so the passes never touch the table.
 */
class TableSpatialView implements SpatialVoiceView {
  readonly capacity: number;
  readonly slots: Uint16Array;
  count = 0;
  readonly viewFlags: Uint8Array;

  constructor(
    private readonly table: VoiceTable,
    readonly curves: SendCurveTable,
    private readonly sink: Pick<SpatialVoiceView, "setOcclusion" | "setDopplerRate">,
  ) {
    this.capacity = table.capacity;
    this.slots = new Uint16Array(table.capacity);
    this.viewFlags = new Uint8Array(table.capacity);
  }

  get gen(): ArrayLike<number> { return this.table.gen; }
  get world(): ArrayLike<number> { return this.table.world; }
  get posX(): ArrayLike<number> { return this.table.posX; }
  get posY(): ArrayLike<number> { return this.table.posY; }
  get posZ(): ArrayLike<number> { return this.table.posZ; }
  get minDist(): ArrayLike<number> { return this.table.minDist; }
  get maxDist(): ArrayLike<number> { return this.table.maxDist; }
  get volume(): ArrayLike<number> { return this.table.volume; }
  get audibility0(): ArrayLike<number> { return this.table.audibility0; }
  get dopplerLevel(): ArrayLike<number> { return this.table.dopplerLevel; }
  get reverbSend(): ArrayLike<number> { return this.table.reverbSend; }
  get sendCurve(): ArrayLike<number> { return this.table.sendCurve; }

  /** This frame's list: every voice on the core, with its view flags. Allocates nothing. */
  collect(): void {
    const t = this.table;
    let n = 0;
    if (t.liveCount > 0) {
      const state = t.state;
      const flags = t.flags;
      const flags2 = t.flags2;
      for (let i = 0; i < t.capacity; i++) {
        const s = state[i]!;
        if (s !== VoiceState.PLAYING && s !== VoiceState.VIRTUAL) continue;
        const f = flags[i]!;
        const f2 = flags2[i]!;
        const spatial = (f & VoiceFlag.SPATIAL) !== 0;
        const ambisonic = (f2 & VoiceFlag2.AMBISONIC) !== 0;
        this.viewFlags[i] =
          (spatial && !ambisonic ? SpatialViewFlag.SPATIAL : 0) |
          (s === VoiceState.PLAYING ? SpatialViewFlag.MIXED : 0) |
          (spatial && !ambisonic && f2 & VoiceFlag2.OCCLUSION ? SpatialViewFlag.OCCLUSION : 0) |
          (ambisonic ? SpatialViewFlag.AMBISONIC : 0) |
          ((spatial || ambisonic) && f2 & VoiceFlag2.SENDS ? SpatialViewFlag.SENDS : 0);
        this.slots[n++] = i;
      }
    }
    this.count = n;
  }

  setOcclusion(i: number, gain: number, lpHz: number): void {
    this.sink.setOcclusion(i, gain, lpHz);
  }

  setDopplerRate(i: number, factor: number): void {
    this.sink.setDopplerRate(i, factor);
  }
}

export type { CoreBackend };

/**
 * `assembleCore`'s backend factory (its only caller, ADR 0221): wires the registry to the host (its messages go
 * through `CoreLink.post` with the link's `seq`, clips are fetched from the project's asset URLs and decoded on the
 * decoder worker) and the clock to the context.
 */
export function createCoreBackend(host: AudioHost, deps: CoreBackendDeps = {}): CoreBackend {
  const settings = (deps.mixer ?? defaultMixer).audioSettings;
  const link = host.link;
  const aac = settings.codecs?.aac === true;
  // B4: one set of "can't decode" warnings for clips and streams alike.
  const warnOnce = deps.warnOnce ?? createWarnOnce();
  const clips =
    deps.clips ??
    createClipRegistry({
      // `seq` is per sender on one port: the registry shares the link's counter.
      send: (message) => link.post(message),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async (path) => {
        const response = await fetch(Assets.url(path));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      },
      clipFormat: settings.clipFormat === "f32" ? 0 : 1,
      ceilingBytes: (settings.clipMemoryMB ?? DEFAULT_CLIP_CEILING_MB) * (1 << 20),
      // B4: the worker loads the AAC build of the decoder only when the project asks for AAC.
      decodeWorker: sharedDecoderClient(aac ? "aac" : "default"),
      aac,
      warnOnce,
    });
  const backendHost: CoreBackendHost = {
    link,
    get status() {
      return host.status;
    },
    get preset() {
      return host.preset;
    },
    get worldCount() {
      return host.worldCount;
    },
    // The current context's (a rebuild into a new context changes it, A3.4c).
    get sampleRate() {
      return host.context.sampleRate;
    },
    addLifecycleListener: (listener) => host.addLifecycleListener(listener),
    health: host.health,
    // ADR 0166 §4.6 (Rh1): the current context's latency read-back and its `reliable` rule.
    latency: () => host.latency(),
    outputSink: () => host.snapshot().sink,
  };
  const backend = new CoreBackend(backendHost, { ...deps, clips, warnOnce, clock: deps.clock ?? browserHostClock(() => host.context) });
  attachBackground(backend, host);
  return backend;
}

/** A3.4b: the visibility, device-event and stall controller (`background.ts`) for a backend on the page's host. */
function attachBackground(backend: CoreBackend, host: AudioHost): void {
  // The stall check's heartbeat age is on the host's clock (`performance.now` in a page; the loopback's rendered time).
  const controller = new BackgroundController({
    host, target: backend, now: host.now,
    // ADR 0248: a device event is reported up the seam (`Audio.calibration` follows the output device there, Rh2).
    onDevice: () => backend.onOutputDevice?.(host.snapshot().sink, "changed"),
  });
  backend.health = controller.counters;
  backend.addCleanup(() => controller.dispose());
  controller.start();
}
