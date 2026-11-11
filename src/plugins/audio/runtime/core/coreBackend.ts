// The core's `AudioBackend` (ADR 0157 K3; api-and-models §3 "Mixer counting", §6 "AudioBackend changes"; architecture
// §3.2): plays through the voice table and the command writer, reads the core through the status mirror, loads
// clips through the clip registry (K9), and keeps time with the clock map. `service.ts` registers a factory for it
// (`registerCoreBackend`) once the core has loaded.
//
// Frame flow (`update(dt)`, called by the audio system once per frame): clock.beginFrame, mirror.beginFrame, free ended
// voices, apply clip events to the registry, start voices that were waiting for the unlock, move spatial voices, run
// the voice selection (A3.1, `selection.ts`: SET_MIXED for changes, steals over a bus's `maxVoices`), drain the table's
// STOP and FADE commands into the writer, flush the batch at `clock.nextFirstFrame()`. Everything the mirror does
// happens in `onmessage`, separately.
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
// BATCH). `update(dt)` runs the same stages without the passes. The backend constructs every M3 part here: the bed
// planner (`beds.ts`, planned after each BUS_CONFIG), the panner pick, the zone manager over the zone IR service
// (`zoneIr.ts`, K0's `ZoneIrService`), the occlusion and Doppler passes, the LISTENER stage and the per-voice fx staging.
// Main's results come back through `_setOcclusion` (the dry gain is `gain × occGain`, the cutoff a `voiceFx` low-pass)
// and `_setDopplerRate` (the pitch sent is `pitch × dopplerFactor`); both are 1 until their tasks, so M2's bytes stand.
import type { Vec3Like } from "../../../../engine/core/math";
import { mixer as defaultMixer, type Mixer, type ResolvedBus } from "../../../../engine/audio/mixer";
import type { AudioSettings, BusEffect } from "../../../../engine/audio/settings";
import { Assets } from "../../../../engine/scene/Assets";
import type { Attenuation, AudioBackend, AudioBackground, AudioStatus, AudioVoice, ListenerPose, PlayRequest, VoiceSpatialOptions, ZoneIrService } from "../backend";
import {
  BUS_LP_OFF_HZ,
  BUS_ROOT,
  AUX_BUS_NONE,
  PLAY_FLAGS_AMBISONIC,
  PLAY_FLAGS_LOOP,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_SPATIAL,
  PLAY_FLAGS_STREAM,
  PLAY_FLAGS_WANTS_PLAYHEAD,
  readStatus,
  SET_PARAMS_MASK_BUS,
  SET_PARAMS_MASK_DIR,
  SET_PARAMS_MASK_GAIN,
  SET_PARAMS_MASK_LP_HZ,
  SET_PARAMS_MASK_PITCH,
  type BusConfigBuses,
  type BusConfigBusesEffects,
  type BusMixBuses,
} from "../wire.generated";
import { AudioHandle, type AudioReason } from "./handle";
import { limiterLatencyFrames } from "./limiterLatency";
import { ClockMap } from "./clock";
import { CommandWriter, type PlayArgs } from "./commandWriter";
import { createHrirLoader, createMaglsLoader, type HrirLoader, type MaglsLoader } from "./hrir";
import { ambisonicImportGain, createClipRegistry, type ClipInfo, type ClipRegistry } from "./clipRegistry";
import { DEFAULT_CLIP_CEILING_MB, type AudioHost, type CoreLink, type HostHealth } from "./context";
import { PlayheadTracker, Replayer } from "./replay";
import { buildDebugInfo, type AudioDebugInfo } from "./debug";
import { BackgroundController } from "./background";
import { browserHostClock, type HostClock } from "./hostClock";
import { StatusMirror } from "./mirror";
import { DistanceEffect } from "./spatial";
import { StatusReader } from "./statusReader";
import { UnlockQueue } from "./unlockQueue";
import { connectVoiceTable, VoiceFlag, VoiceFlag2, VoiceReason, VoiceRolloff, VoiceState, VoiceTable } from "./voiceTable";
import { STREAM_ERROR_FADE_SECONDS, StreamManager, type StreamManagerDeps } from "./streams";
import { sharedDecoderClient } from "../decoder/decoderClient";
import { aacRefusal, createWarnOnce, unsupportedFormat, type WarnOnce } from "./codecs";
import { effectiveMixedCap, ListenerBasis, Selection, type SelectionSink } from "./selection";
import { PannerKind, PannerPick, type PannerKindCode, type PannerSink } from "./pannerPick";
import { BedPlanner } from "./beds";
import { ZoneManager } from "./zones";
import { createZoneIrService } from "./zoneIr";
import { OcclusionPass } from "./occlusion";
import { DopplerPass } from "./doppler";
import { ListenerStage } from "./listener";
import { LowpassBy, VoiceFx } from "./voiceFx";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView, type StagedFrameHost } from "./spatial";
import type { ReplayBuilder, ReplaySpatial } from "./replay";
import { MAX_BUSES } from "../../../../engine/audio/settings";
import { CoreAutomation, wrapPosition } from "./coreAutomation";
import { MAX_GROUPS } from "../events/automation";


/** `PlayRequest` plus the core's World key. */
export interface CorePlayRequest extends PlayRequest {
  /** The World key of the playing World (0 or omitted: none). */
  world?: number;
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

/** What the backend needs of the host (an `AudioHost`, or a fake in tests). */
export interface CoreBackendHost {
  readonly link: Pick<CoreLink, "batchPool" | "nextSeq" | "post" | "onStatus"> & { statusDecoder: CoreLink["statusDecoder"] } & Partial<Pick<CoreLink, "connectStreamPort">>;
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
  };
  /** Worlds holding a share (an idle host has none). */
  readonly worldCount: number;
  readonly sampleRate: number;
  addLifecycleListener: AudioHost["addLifecycleListener"];
  /** Architecture §8 health counters (traps, recoveries, rebuilds) of the host, for `Audio.debug()` (A3.4a). */
  readonly health?: HostHealth;
}

/** What `createCoreBackend` takes beyond the host (tests inject fakes). */
export interface CoreBackendDeps {
  /** The registry for clips; defaults to one wired to the host (CoreLink, `fetch`, the decoder worker). */
  clips?: ClipRegistry;
  clock?: HostClock;
  mixer?: Mixer;
  /** The table; defaults to one of `host.preset.maxLogical` slots. */
  table?: VoiceTable;
  /** The HRTF table loader (H2); defaults to one on `clips` at the host rate. Tests inject a fake. */
  hrir?: HrirLoader;
  /** ADR 0162 (A5): the MagLS bed filters' loader (default: the real one). */
  magls?: MaglsLoader;
  /**
   * B3: stream plumbing. Defaults: the page's decoder client, `host.link.connectStreamPort`, a `MessageChannel`, and a
   * fetch of the asset's URL. Tests pass an in-process decoder and channel.
   */
  streams?: Partial<Pick<StreamManagerDeps, "decoder" | "connectWorklet" | "channel" | "fetchBytes">>;
  /** B4: warns once per asset the core can't decode (shared with the clip registry); default: the backend's own over `console.warn`. */
  warnOnce?: WarnOnce;
  /** ADR 0162 (K0, C9): zone IR preparation; default `createZoneIrService` (`zoneIr.ts`). Tests inject a fake. */
  zoneIr?: ZoneIrService;
}

const DIR_EPSILON = 0.005;
const GAIN_EPSILON = 0.001;
const MAX_PITCH = 16;
const MIN_PITCH = 0.0625;
const MAX_BUS = 32;
const ROLLOFF_NAMES = ["linear", "inverse", "exponential"] as const;
/** Architecture §4.7: promote and demote fade 5 ms; a voice stolen while on the core fades out as long. */
const STEAL_FADE_SECONDS = 0.005;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Maps a `BusEffect` to its wire record (§4.2 BUS_CONFIG: q in dB, p unused = 0). */
function wireEffect(e: BusEffect): BusConfigBusesEffects {
  const p = [0, 0, 0, 0, 0, 0, 0];
  switch (e.type) {
    case "lowpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: 0, p };
    case "highpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: 1, p };
    case "compressor":
      p[0] = e.threshold;
      p[1] = e.knee;
      p[2] = e.ratio;
      p[3] = e.attack;
      p[4] = e.release;
      return { type: 2, p };
    case "reverb":
      p[0] = e.send;
      return { type: 3, p };
  }
}

export class CoreBackend implements AudioBackend, StagedFrameHost {
  readonly name = "core";
  readonly table: VoiceTable;
  readonly mirror: StatusMirror;
  readonly writer: CommandWriter;
  readonly clockMap: ClockMap;
  readonly clips: ClipRegistry;
  readonly mixer: Mixer;
  /** The per-frame voice selection (A3.1). */
  readonly selection: Selection;
  /** Where each voice is in its clip (A3.4a), for a hard rebuild's replay. */
  readonly playheads: PlayheadTracker;
  /** The hard rebuild's replay (A3.4a; `replay.ts`). */
  readonly replayer: Replayer;
  /** ADR 0162 (K4): each voice's panner kind (`pannerPick.ts`; H3's HRTF pick until A5). */
  readonly panners: PannerPick;
  private readonly pannerSink: PannerSink;
  /** ADR 0162 (K4): the bed planner (`beds.ts`). */
  readonly beds: BedPlanner;
  /** ADR 0162 (K4): per-voice fx staging (`voiceFx.ts`: lpHz, SET_VOICE_FX). */
  readonly voiceFx: VoiceFx;
  /** ADR 0162 (K4, K0): zone IR preparation (`zoneIr.ts`). */
  readonly zoneIr: ZoneIrService;
  /** ADR 0162 (K4): the zone manager (`zones.ts`). */
  readonly zones: ZoneManager;
  /** ADR 0162 (K4): main's occlusion pass (`occlusion.ts`), run by the audio system. */
  readonly occlusion: OcclusionPass;
  /** ADR 0162 (K4): main's Doppler pass (`doppler.ts`), run by the audio system. */
  readonly doppler: DopplerPass;
  /** ADR 0162 (K4): LISTENER staging (`listener.ts`). */
  readonly listener: ListenerStage;
  /** ADR 0162 (K4): the interned send curves (`spatial.ts`). */
  readonly sendCurves = new SendCurveTable();
  /** ADR 0162 (K4): the voices as main's passes see them (`spatial.ts`). */
  readonly spatialVoices: TableSpatialView;
  /** ADR 0162 (K4): the M3 replay hooks, in the replay's order (`replay.ts`). */
  readonly spatial: ReplaySpatial;
  /** The listener frame `update(dt)` stages LISTENER from (the audio system passes its own to `frameStageListener`). */
  private readonly idleFrame = new ListenerFrame();
  /** B5: per slot, the FuMa import gain (`ambisonicImportGain`) the voice's volume already carries; 1 when none was known at its play. */
  private readonly gainApplied: Float32Array;
  /** B3: the stream voices' main side (`streams.ts`). */
  readonly streams: StreamManager;
  /** ADR 0158 (E3.1): the event runtime's automation sink on the core, and its mirror for a rebuild (`coreAutomation.ts`). */
  readonly automation: CoreAutomation;

  private readonly clock: HostClock;
  private readonly reader = new StatusReader();
  private readonly cleanups: (() => void)[] = [];
  private names: string[] = [];
  private readonly busIndexByName = new Map<string, number>();
  /** D5: voices played while locked. One-shots are capped (32 for 1 s); owned and looping voices wait. */
  readonly lockedQueue = new UnlockQueue<number>({
    onDrop: (id) => {
      if (this.table.isLive(id) && this.table.state[id & 0xffff] === VoiceState.LOCKED) this.table.free(id, VoiceReason.NONE);
    },
  });
  private spatialCount = 0;
  private readonly spatialDirty: Uint8Array;
  private listenerDirty = true;
  private readonly listenerPos: [number, number, number] = [0, 0, 0];
  private readonly listenerFwd: [number, number, number] = [0, 0, -1];
  private readonly listenerUp: [number, number, number] = [0, 1, 0];
  private readonly distance = new DistanceEffect();
  private readonly basis = new ListenerBasis();
  private readonly selectionSink: SelectionSink;
  private readonly playArgs: PlayArgs = { voiceId: 0, clip: 0, bus: 0, flags: 0, group: 0, gain: 1, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: BUS_LP_OFF_HZ, score: 0, startOffsetFrames: 0 };
  private readonly mixPool: BusMixBuses[] = [];
  /** M2 F3: selection's bus factor inputs, by bus index: effective gain without automation, parent, automated gain, chain product. */
  private readonly selBase = new Float64Array(MAX_BUS).fill(1);
  private readonly selParent = new Int16Array(MAX_BUS).fill(-1);
  private readonly selAuto = new Float64Array(MAX_BUS).fill(1);
  private readonly selChain = new Float64Array(MAX_BUS).fill(1);
  private selCount = 0;
  private readonly mixView: BusMixBuses[] = [];
  private idlePending = false;
  private master = 1;
  private isMuted = false;
  private disposed = false;
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
    this.clock = deps.clock;
    this.clips = deps.clips;
    this.hrir = deps.hrir ?? createHrirLoader({ clips: deps.clips, sampleRate: host.sampleRate });
    this.magls = deps.magls ?? createMaglsLoader({ clips: deps.clips, sampleRate: host.sampleRate });
    this.table = deps.table ?? new VoiceTable(host.preset.maxLogical);
    this.spatialDirty = new Uint8Array(this.table.capacity);
    this.gainApplied = new Float32Array(this.table.capacity).fill(1);
    this.selection = new Selection(this.table);
    this.panners = new PannerPick(this.table);
    this.pannerSink = { setPanner: (i, kind) => this.sendPanner(i, kind) };
    this.occlusion = new OcclusionPass(this.table.capacity);
    this.doppler = new DopplerPass(this.table.capacity);
    this.basis.set(this.listenerPos, this.listenerFwd, this.listenerUp);
    this.selectionSink = {
      setMixed: (i, mixed) => this.sendMixed(i, mixed),
      steal: (i) => this.stealSlot(i),
      setScore: (i, score) => this.sendScore(i, score),
    };
    this.mirror = new StatusMirror(this.table);
    this.writer = new CommandWriter(host.link, host.sampleRate);
    // ADR 0162 (K4): the M3 parts that write through the writer and read the mirror.
    const preset = host.preset;
    this.voiceFx = new VoiceFx(this.table, this.writer);
    this.beds = new BedPlanner(this.writer, preset.maxBeds ?? 0);
    this.zoneIr = deps.zoneIr ?? createZoneIrService({ sampleRate: host.sampleRate });
    this.zones = new ZoneManager({ writer: this.writer, fx: this.voiceFx, irs: this.zoneIr, mirror: this.mirror, maxZoneSlots: preset.maxZoneSlots ?? 0, zoneMaxSeconds: preset.zoneMaxSeconds ?? 0, sampleRate: host.sampleRate, wet: this.occlusion.wet });
    this.listener = new ListenerStage(this.writer);
    this.spatialVoices = new TableSpatialView(this.table, this.sendCurves, {
      setOcclusion: (i, gain, lpHz) => this.occlusionAt(i, gain, lpHz),
      setDopplerRate: (i, factor) => this.dopplerAt(i, factor),
    });
    this.spatial = {
      replayBeds: (b: ReplayBuilder) => this.beds.replay(b),
      replayListener: (b: ReplayBuilder) => this.listener.replay(b),
      replayZones: (b: ReplayBuilder) => this.zones.replay(b),
      replayVoiceFx: (b: ReplayBuilder, id: number, i: number) => this.voiceFx.replayVoice(b, id, i),
    };
    this.clockMap = new ClockMap(this.clock, host.sampleRate, limiterLatencyFrames(host.sampleRate, host.preset.limiterLookaheadMs));
    const streamDeps = deps.streams ?? {};
    this.streams = new StreamManager({
      table: this.table,
      // B4: the AAC build's worker when the project decodes AAC, else the default one.
      decoder: streamDeps.decoder ?? (() => sharedDecoderClient(this.aac ? "aac" : "default")),
      connectWorklet:
        streamDeps.connectWorklet ??
        ((port) => {
          if (!host.link.connectStreamPort) throw new Error("audio: this host can't connect streams to the worklet");
          host.link.connectStreamPort(port as MessagePort);
        }),
      channel: streamDeps.channel,
      fetchBytes:
        streamDeps.fetchBytes ??
        (async (path) => {
          const response = await fetch(Assets.url(path));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        }),
      onError: (id, asset, message, code) => this.streamFailed(id, asset, message, code),
      sendSeek: (id, frame, epoch) => this.writer.seek(id, frame, epoch),
      // ADR 0162 B4: a FuMa stream's headroom scale multiplies its volume, as a FuMa clip's import volume.
      onImportGain: (id, gain) => this._setVolume(id, this.table.volume[id & 0xffff]! * gain),
      // E4.4: a stream loop's change lands at the end of the voice's current pass, predicted from its STATUS playhead
      // at the playhead estimate's rate (the estimate itself before the voice sounds).
      positionAt: (id, frame) => (this.table.isLive(id) ? this.playheads.positionNow(id & 0xffff, frame) : null),
      rateOf: (id) => this.playheads.rate[id & 0xffff] ?? 0,
    });
    this.streams.afterSeek = (voice, frame) => this.reanchorSeek(voice, frame);
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
    this.playheads.wrap = (i, pos) => this.wrapPlayhead(i, pos);
    this.automation = new CoreAutomation({
      table: this.table,
      writer: this.writer,
      clockMap: this.clockMap,
      playheads: this.playheads,
      clipInfo: (i) => ((this.table.flags[i]! & VoiceFlag.STREAM) !== 0 ? this.streams.clipInfo(this.table.clip[i]!) : this.clips.info(this.table.clip[i]!)),
      busIndex: (name) => this.busIndexByName.get(name) ?? -1,
      sending: () => !this.disposed && !this.recovering && this.host.status !== "failed",
      streamLoop: (i, loop, at) => this.streams.setLoop(this.table.clip[i]!, loop, at),
      writerBatches: () => this.writer.stats.batches,
      busView: (name, gain) => this.mixer._setAutomationView(name, gain),
      busSelection: (name, gain) => {
        const b = this.busIndexByName.get(name);
        if (b === undefined || b >= MAX_BUS) return;
        this.selAuto[b] = gain;
        this.refreshBusGain();
      },
    });
    this.replayer = new Replayer(this, host.link);
    for (let i = 0; i < MAX_BUS; i++) this.mixPool.push({ gain: 1, lpHz: BUS_LP_OFF_HZ });
    this.clipSink = { event: (id, code) => this.clips.applyClipEvent(id, code) };

    // STATUS: decode into one block, apply in onmessage.
    host.link.statusDecoder = (buffer) => this.reader.read(buffer);
    this.cleanups.push(this.mirror.attach(host.link));
    // B3, after the mirror: a stream voice that moves again is no longer waiting for data.
    this.cleanups.push(this.streams.attach(host.link));
    this.streamSink = { event: (id, code) => this.streams.streamEvent(id, code) };
    // Voice ends free the slot's clip reference and the bus count (api §3 "Mixer counting").
    this.table.onFree = (id, bus) => this.onFree(id, bus);
    this.cleanups.push(connectVoiceTable(this.table, host));
    this.cleanups.push(
      host.addLifecycleListener({
        onBusRemap: () => this.configureBuses(this.mixer),
        onIdle: () => {
          this.idlePending = true;
        },
        onClose: () => this.dispose(),
        onRebuildStart: () => this.beginRecovery(),
        onContextReplaced: (rate) => this.contextReplaced(rate),
        onRebuilt: () => this.endRecovery(),
        onRecoveryFailed: () => this.recoveryFailed(),
      }),
    );
    this.cleanups.push(
      this.mixer.onChange(() => {
        this.replanBedsOnSettings();
        this.applyMix(this.mixer.resolveAll());
      }),
    );
    this.configureBuses(this.mixer);
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
    this.mirror.freeEndedInMessage = hidden;
    if (hidden && !this.disposed) this.table.freeEnded();
  }

  /** @internal §3.8: MASTER to 0 (or back) over `rampMs`, flushed now since no frame will. `Audio.muted` and the volume are kept. */
  hiddenMute(on: boolean, rampMs: number): void {
    if (this.disposed) return;
    this.hiddenMuteOn = on;
    this.writer.master(this.master, this.isMuted || on, Math.max(1, Math.round((rampMs / 1000) * this.host.sampleRate)));
    this.writer.flush(this.clockMap.nextFirstFrame());
  }

  /** @internal §3.8: the next frame re-anchors the clock map. */
  reanchor(): void {
    this.clockMap.reanchor();
  }

  /** The bus names by index (root first), as last configured. */
  get busNames(): readonly string[] {
    return this.names;
  }

  /** Starts a clip. Returns null only when the backend can't play at all (the host failed). */
  play(req: CorePlayRequest): CoreVoice | null {
    if (this.disposed || this.host.status === "failed") return null;
    const world = req.world ?? 0;
    const group = req.group !== undefined && Number.isInteger(req.group) && req.group >= 1 && req.group <= MAX_GROUPS ? req.group : 0;
    // B5: `audio.ambisonic.maxClips` caps concurrent ambisonic voices; main steals the lowest priority first (the core's steal is a backstop).
    if (req.ambisonic === true && !this.admitAmbisonic(req.path, req.priority ?? 128)) return null;
    // B3: a stream voice takes a stream id where a clip voice takes a registry clip (no clip load).
    const stream = req.stream === true;
    const clip = stream ? this.streams.allocate() : this.clips.acquire(req.path, world);
    const bus = this.busIndex(req.bus);
    const priority = req.priority ?? 128;
    // A3.4a: while a hard rebuild runs, new plays wait in the locked queue and start once the new core is up.
    const running = this.host.status === "running" && !this.recovering;
    const id = this.table.allocate(bus, priority, world, running ? VoiceState.WAITING_FOR_DATA : VoiceState.LOCKED);
    if (id === 0) {
      if (!stream) this.clips.release(clip);
      return null;
    }
    const t = this.table;
    const i = id & 0xffff;
    t.clip[i] = clip;
    t.group[i] = group;
    t.volume[i] = req.volume !== undefined && Number.isFinite(req.volume) ? Math.max(0, req.volume) : 1;
    this.gainApplied[i] = req.ambisonic === true && !stream ? ambisonicImportGain(req.path) : 1;
    t.pitch[i] = req.pitch !== undefined && Number.isFinite(req.pitch) ? clamp(req.pitch, MIN_PITCH, MAX_PITCH) : 1;
    t.flags[i] = (req.loop ? VoiceFlag.LOOP : 0) | (req.oneShot ? VoiceFlag.ONE_SHOT : 0) | (stream ? VoiceFlag.STREAM | VoiceFlag.WANTS_PLAYHEAD : 0);
    if (stream) this.streams.register(clip, id, req.path, req.loop === true);
    t.lpHz[i] = BUS_LP_OFF_HZ;
    t.dirX[i] = 0;
    t.dirY[i] = 0;
    t.dirZ[i] = -1;
    if (req.attenuation) this.applyAttenuation(i, req.attenuation);
    if (req.position) this.applyPosition(i, req.position);
    this.applyM3Request(i, req);
    this.refreshGain(i);
    // `at` is ignored while locked (API §1); the stamp-or-asap choice is made when the PLAY is sent (`sendPlay`).
    t.startFrame[i] = running ? this.clockMap.frameOfTime(req.at) : 0;
    this.mixer.voiceStarted(this.names[bus] ?? "");
    if (running) this.launch(id);
    else if (req.oneShot && !req.loop) this.lockedQueue.pushOneShot(id, performance.now());
    else this.lockedQueue.pushOwned(id);
    const voice = new Voice(this, id);
    this.automation.onPlay(voice, req);
    return voice;
  }

  setListener(pose: ListenerPose): void {
    const p = pose.position;
    const f = pose.forward;
    const u = pose.up;
    const pos = this.listenerPos;
    const fwd = this.listenerFwd;
    const up = this.listenerUp;
    if (pos[0] !== p.x || pos[1] !== p.y || pos[2] !== p.z || fwd[0] !== f.x || fwd[1] !== f.y || fwd[2] !== f.z || up[0] !== u.x || up[1] !== u.y || up[2] !== u.z) {
      pos[0] = p.x;
      pos[1] = p.y;
      pos[2] = p.z;
      fwd[0] = f.x;
      fwd[1] = f.y;
      fwd[2] = f.z;
      up[0] = u.x;
      up[1] = u.y;
      up[2] = u.z;
      this.listenerDirty = true;
      this.basis.set(pos, fwd, up);
    }
  }

  /** BUS_MIX from the resolved buses: each bus's own gain (the core multiplies down the tree) and snapshot low-pass. */
  applyMix(buses: readonly ResolvedBus[]): void {
    if (this.disposed) return;
    const view = this.mixView;
    view.length = 0;
    const n = Math.min(buses.length, MAX_BUS);
    for (let b = 0; b < n; b++) {
      const item = this.mixPool[b]!;
      item.gain = buses[b]!.gain;
      item.lpHz = buses[b]!.snapshotLowpass ?? BUS_LP_OFF_HZ;
      this.snapLp[b] = item.lpHz;
      view.push(item);
      // Selection's audibility uses the effective gain down the tree (A3.1), without bus automation (below).
      const g = buses[b]!.effectiveGain;
      this.selBase[b] = Number.isFinite(g) && g > 0 ? g : 0;
      const p = buses[b]!.parent;
      this.selParent[b] = p === null ? -1 : (this.busIndexByName.get(p) ?? -1);
    }
    this.selCount = n;
    this.refreshBusGain();
    this.writer.busMix(view, this.clockMap.rampFrames());
    this.refreshSharedLowpass();
  }

  /**
   * ADR 0162 (A5, S3): the sharing chain's snapshot low-pass. A voice on the bed (kind 2) of an ancestor's slot skips the
   * buses between its own and the host, so main folds their snapshot cutoffs into its low-pass (`LowpassBy.SNAPSHOT`,
   * the lowest wins); the core folds the gains. Run where a snapshot's cutoff or the bed plan changes.
   */
  private refreshSharedLowpass(): void {
    if (!this.beds.foldLowpass(this.snapLp, this.selCount)) return;
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] === VoiceState.FREE) continue;
      this.voiceFx.setLowpass(i, LowpassBy.SNAPSHOT, this.panners.kindOf(i) === PannerKind.BED ? this.beds.chainLowpass[t.bus[i]!]! : BUS_LP_OFF_HZ);
    }
  }
  /** Each bus's snapshot cutoff as last sent in BUS_MIX (`BUS_LP_OFF_HZ`: none), for the sharing chain's fold. */
  private readonly snapLp = new Float32Array(MAX_BUS).fill(BUS_LP_OFF_HZ);
  /** R13: game time, ms (the kind dwell's clock). */
  private gameMs = 0;

  /**
   * M2 F3: selection's bus factor: the mixer's effective gain times each bus's automated gain (selection's no-gap
   * estimate, `CoreAutomation.publishSelection`) and its ancestors', root first. Run where either input changes.
   */
  private refreshBusGain(): void {
    const busGain = this.selection.busGain;
    const chain = this.selChain;
    for (let b = 0; b < this.selCount; b++) {
      const p = this.selParent[b]!;
      const own = this.selAuto[b]!;
      const c = p >= 0 && p < b ? chain[p]! * own : own;
      chain[b] = c;
      const g = this.selBase[b]! * c;
      busGain[b] = Number.isFinite(g) && g > 0 ? g : 0;
    }
  }

  /** The settings object the beds were last planned from (E7: a settings change that keeps the bus names plans them again). */
  private bedsPlannedFrom: AudioSettings | null = null;

  /** ADR 0162 (C2, E7): plans the beds for the current tree and `audio.bed` / each bus's `bed` and `bedPriority`; BED_CONFIG goes with the next batch. */
  private planBeds(mixer: Mixer): void {
    const settings = mixer.audioSettings;
    const buses = settings.buses;
    const parents = this.planParents;
    parents.fill(-1);
    for (let b = 0; b < buses.length && b < MAX_BUSES; b++) {
      const parent = buses[b]!.parent;
      parents[b] = parent === undefined ? -1 : (this.busIndexByName.get(parent) ?? 0);
    }
    this.bedsPlannedFrom = settings;
    this.beds.plan(settings, this.names, parents);
  }

  /**
   * E7: `Engine.create` gave the mixer a new settings object and the bus names are the same, so the host reported no remap
   * and `configureBuses` didn't run. The bed settings (`bed.maxBeds`, a bus's `bed`, `bedPriority`) still apply to the
   * running core: plan the beds again. A changed tree is `configureBuses`' (the remap runs before the mixer's next update).
   */
  private replanBedsOnSettings(): void {
    const settings = this.mixer.audioSettings;
    if (settings === this.bedsPlannedFrom || settings.buses.length !== this.names.length || settings.buses.some((b, i) => b.name !== this.names[i])) return;
    this.planBeds(this.mixer);
  }

  /** Rebuilds the core's bus tree: BUS_CONFIG, the table's per-bus limits, and BUS_MIX. */
  configureBuses(mixer: Mixer): void {
    const settings = mixer.audioSettings.buses;
    this.names = settings.map((b) => b.name);
    this.busIndexByName.clear();
    this.names.forEach((n, i) => this.busIndexByName.set(n, i));
    this.lastBusName = null;
    this.selAuto.fill(1);
    this.writer.busConfig(this.busConfigWire(mixer));
    // ADR 0162 (K4, C2): the bed plan for the new tree, BED_CONFIG right after BUS_CONFIG (none while no bed is laid out).
    this.planBeds(mixer);
    // ADR 0158: bus bindings follow their buses to the new indices.
    this.automation.onBusesConfigured();
    // The mixer's counts restart at 0 when it is reconfigured; the table knows every live voice (virtual and locked
    // included), so ducking keeps counting them across a remap. Peaks reported for the old indices are dropped.
    this.names.forEach((n, i) => mixer._setVoiceCount(n, this.table.busLive[i]!));
    this.mirror.resetPeaks();
    this.table.setBusLimits(settings.map((b) => b.maxVoices ?? 0));
    // A remap (A0.8) has already moved the table's voices to the new tree's indices; the core's
    // voices still carry the old ones, so each voice on the core is re-routed (after BUS_CONFIG, in
    // the same batch).
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      if (!this.onCore(i)) continue;
      this.writer.setParams(((t.gen[i]! << 16) | i) >>> 0, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, t.bus[i]!);
    }
    this.applyMix(mixer.resolveAll());
  }

  /** BUS_CONFIG's buses for the tree last configured, root first (also the hard rebuild's replay, A3.4a). */
  busConfigWire(mixer: Mixer = this.mixer): BusConfigBuses[] {
    return mixer.audioSettings.buses.map((b) => ({
      parent: b.parent === undefined ? BUS_ROOT : (this.busIndexByName.get(b.parent) ?? 0),
      effects: b.effects.map(wireEffect),
    }));
  }

  get masterVolume(): number {
    return this.master;
  }

  set masterVolume(v: number) {
    this.master = clamp(Number.isFinite(v) ? v : 1, 0, 1);
    this.writer.master(this.master, this.isMuted || this.hiddenMuteOn, this.clockMap.rampFrames());
  }

  get muted(): boolean {
    return this.isMuted;
  }

  set muted(m: boolean) {
    this.isMuted = m;
    this.writer.master(this.master, m || this.hiddenMuteOn, this.clockMap.rampFrames());
  }

  /** B4: `audio.codecs.aac` (read when used, like the rest of the settings). */
  private get aac(): boolean {
    return this.mixer.audioSettings.codecs?.aac === true;
  }

  /**
   * B3, architecture §7: a stream failed (the decoder's error, a failed fetch, no ring free): its voice stops with a
   * 50 ms fade and one warning names the asset. B4: a file the decoder can't read warns once per asset, naming its
   * format and the supported list; the voice reads `reason` "failed" from now on, and once it has ended.
   */
  private streamFailed(id: number, asset: string, message: string, code?: number): void {
    const unsupported = unsupportedFormat(asset, this.aac, code, message);
    if (unsupported) this.warnOnce(asset, unsupported);
    else console.warn(`[myco] audio: streaming "${asset}" failed: ${message}`);
    const t = this.table;
    if (!t.isLive(id)) return;
    const s = t.state[id & 0xffff];
    if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return;
    t.reason[id & 0xffff] = VoiceReason.FAILED;
    t.requestStop(id, STREAM_ERROR_FADE_SECONDS);
  }

  /** The per-frame step; see the header. The audio system runs the same stages with main's M3 passes between them. */
  update(dt: number): void {
    if (this.disposed) return;
    this.frameAttenuate(dt);
    this.frameSelect();
    this.framePickPanners();
    this.frameStageFx();
    this.frameStageListener(this.idleFrame);
    this.frameCommit();
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
    this.mirror.beginFrame();
    this.publishPeaks();
    this.table.freeEnded();
    this.mirror.drainClipEvents(this.clipSink);
    this.mirror.drainStreamEvents(this.streamSink);
    this.replayer.flush();
    this.automation.beginFrame();
    if (this.lockedQueue.size > 0 && this.host.status === "running" && !this.recovering) this.unlock();
    if (this.spatialCount > 0) this.moveSpatial();
  }

  /** ADR 0162 (K4) `SpatialPassHost`: this frame's voices for main's passes (after attenuation, before Doppler). */
  collectSpatialVoices(): void {
    if (this.disposed) return;
    this.spatialVoices.collect();
  }

  /** ADR 0162 (K4) `StagedFrameHost`: audibility = `audibility0` × `occGain`, and the selection. */
  frameSelect(): void {
    if (this.disposed) return;
    this.select();
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
    this.table.drainCommands(this.writer);
    // A3.4a: during a rebuild (or after recovery gave up) no core keeps what is sent; the replay re-derives it all.
    if (this.recovering || this.host.status === "failed") this.writer.clear();
    else if (this.writer.pending > 0) this.writer.flush(this.clockMap.nextFirstFrame());
  }

  // --- The hard rebuild (A3.4a; `recovery.ts` drives the host, `replay.ts` restores the voices) ---

  private recovering = false;

  /** True between the old core's loss and the new core's first STATUS. */
  get isRecovering(): boolean {
    return this.recovering;
  }

  /** `onRebuildStart`: the old core is gone; voices keep their handles and state, new plays queue. */
  private beginRecovery(): void {
    if (this.disposed) return;
    this.recovering = true;
    // B3: the new core gets a new node; streams connect to it when they reopen (`reopenStreams`).
    this.streams.disconnect();
    this.replayer.begin();
  }

  /** STATUS blocks that came from a context since replaced: the clock map's fallback ignores them (A3.4c). */
  private staleBlocks = 0;

  /**
   * `onContextReplaced` (A3.4c, architecture §3.7): the rebuild made a new context at `rate`, whose frames start at 0.
   * The voices' playheads and the trap frame are carried in `Audio.time` seconds (`Replayer.newContext`); the clock
   * map takes the new rate and the limiter latency at it, and keeps `Audio.time` continuous (`ClockMap.rebase`); the
   * writer converts seconds at the new rate; the HRIR is resampled for it from the original asset. Clips keep their
   * own rate (the registry re-decodes them at it; the core's resampler absorbs the difference).
   */
  private contextReplaced(rate: number): void {
    if (this.disposed) return;
    const clock = this.clockMap;
    this.replayer.newContext(clock.sampleRate, clock.timeOffset);
    // The old clock's newest estimate (its last frame's offset, extrapolated with the page clock) and its frame's time.
    clock.rebase(rate, limiterLatencyFrames(rate, this.host.preset.limiterLookaheadMs), clock.carryPoint());
    this.writer.sampleRate = rate;
    this.hrir.retarget?.(rate);
    this.magls.retarget(rate);
    this.zones.contextReplaced(rate);
    this.staleBlocks = this.mirror.blocks;
  }

  /** `onRebuilt`: the new core answered: RESET 0, buses, MASTER, the clips again, then the voices as their clips return. */
  private endRecovery(): void {
    if (this.disposed) return;
    this.recovering = false;
    this.mirror.resetPeaks();
    this.replayer.restore();
  }

  /** `onRecoveryFailed`: the host is Failed and silent for the session: every voice ends with reason "failed". */
  private recoveryFailed(): void {
    if (this.disposed) return;
    this.recovering = false;
    this.lockedQueue.clear();
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] !== VoiceState.FREE) t.free(((t.gen[i]! << 16) | i) >>> 0, VoiceReason.FAILED);
    }
    this.writer.clear();
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
    return effectiveMixedCap(configured, this.mirror.mixedCap);
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
    return this.mirror.hrtfLoadFailure || (this.hrir.failed ? 1 : 0);
  }

  /** H3: the panner kind the core holds for slot `i` (0 equal-power, 1 HRTF), which a rebuild's replayed PLAY carries. */
  hrtfPanner(i: number): number {
    return this.panners.panner(i);
  }

  /** H3's name for the panner pick (`debug.ts`, tests). */
  get hrtf(): PannerPick {
    return this.panners;
  }

  /** `Audio.debug()` (K10): delegates to `debug.ts`. */
  debug(): AudioDebugInfo {
    return buildDebugInfo(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lockedQueue.clear();
    for (const c of this.cleanups.splice(0)) c();
    this.streams.dispose();
    this.zones.dispose();
    this.table.onFree = null;
    this.host.link.statusDecoder = readStatus;
    this.writer.clear();
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

  // --- Voice operations (`Voice` calls these) ---

  /** @internal */
  _setVolume(id: number, v: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(v)) return;
    this.table.volume[i] = Math.max(0, v);
    this.refreshGain(i);
    this.sendGain(id, i);
  }

  /** @internal */
  _setPitch(id: number, rate: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(rate)) return;
    this.table.pitch[i] = clamp(rate, MIN_PITCH, MAX_PITCH);
    if (this.onCore(i)) this.playheads.retime(i, this.clockMap.framesNow());
    if (this.onCore(i)) this.writer.setParams(id, SET_PARAMS_MASK_PITCH, 0, this.sentPitch(i), 0, 0, 0, 0, this.clockMap.rampFrames());
  }

  // --- ADR 0162 (K4): main's M3 results and options for one voice ---

  /** @internal K0 `AudioVoice.setOcclusion` on a core voice (the view's `setOcclusion` comes here too). */
  _setOcclusion(id: number, gain: number, lpHz: number): void {
    const i = this.slot(id);
    if (i >= 0) this.occlusionAt(i, gain, lpHz);
  }

  /**
   * Slot `i`'s smoothed occlusion (D2a hands it over through the view): `occGain` for selection and the dry gain (sent to
   * a mixed voice when it moved), the cutoff as the voice's occlusion low-pass (`voiceFx`, sent at the fx stage).
   */
  private occlusionAt(i: number, gain: number, lpHz: number): void {
    const t = this.table;
    if (t.state[i] === VoiceState.FREE || !Number.isFinite(gain)) return;
    const old = t.occGain[i]!;
    t.occGain[i] = clamp(gain, 0, 1);
    this.voiceFx.setLowpass(i, LowpassBy.OCCLUSION, lpHz);
    if (Math.abs(t.occGain[i]! - old) > GAIN_EPSILON) this.sendGain(((t.gen[i]! << 16) | i) >>> 0, i);
  }

  /** @internal K0 `AudioVoice.setDopplerRate` on a core voice (the view's `setDopplerRate` comes here too). */
  _setDopplerRate(id: number, factor: number): void {
    const i = this.slot(id);
    if (i >= 0) this.dopplerAt(i, factor);
  }

  /** Slot `i`'s Doppler factor (D3 hands it over through the view): folded into the pitch sent; the playhead estimate follows. */
  private dopplerAt(i: number, factor: number): void {
    const t = this.table;
    if (t.state[i] === VoiceState.FREE || !Number.isFinite(factor) || factor <= 0) return;
    if (t.dopplerFactor[i] === factor) return;
    t.dopplerFactor[i] = factor;
    if (!this.onCore(i)) return;
    this.playheads.retime(i, this.clockMap.framesNow());
    this.writer.setParams(((t.gen[i]! << 16) | i) >>> 0, SET_PARAMS_MASK_PITCH, 0, this.sentPitch(i), 0, 0, 0, 0, this.clockMap.rampFrames());
  }

  /** @internal D3 `AudioSource.velocity`: voice `id`'s velocity (the estimate, or `setVelocity`'s value) into `out`; false when the voice is gone. */
  _velocityOf(id: number, out: { x: number; y: number; z: number }): boolean {
    const i = this.slot(id);
    if (i < 0) return false;
    out.x = this.doppler.velX[i]!;
    out.y = this.doppler.velY[i]!;
    out.z = this.doppler.velZ[i]!;
    return true;
  }

  /** @internal K0 `AudioVoice.setVelocity` on a core voice: the source's velocity from physics (Doppler, D3). */
  _setVelocity(id: number, v: Vec3Like | null): void {
    const i = this.slot(id);
    if (i >= 0) this.doppler.setVelocity(i, v);
  }

  /** @internal §1.2 Play edits on a playing voice (`VoiceSpatialOptions`): the table's options (the passes read them next frame). */
  _setSpatialOptions(id: number, o: VoiceSpatialOptions): void {
    const i = this.slot(id);
    if (i >= 0) this.applySpatialOptions(i, o, false);
  }

  /** The pitch the core gets: the voice's pitch times its Doppler factor, clamped (exactly the pitch at factor 1). */
  private sentPitch(i: number): number {
    const t = this.table;
    const f = t.dopplerFactor[i]!;
    return f === 1 ? t.pitch[i]! : clamp(t.pitch[i]! * f, MIN_PITCH, MAX_PITCH);
  }

  /** The dry gain the core gets: volume × distance gain × occlusion (`occGain`, 1 open). */
  private dryGain(i: number): number {
    return this.table.gain[i]! * this.table.occGain[i]!;
  }

  /** ADR 0162 (K4): a new voice's M3 request fields (K0's `PlayRequest` members) into the table and the fx staging. */
  private applyM3Request(i: number, req: PlayRequest): void {
    const t = this.table;
    t.flags2[i] = req.ambisonic === true ? VoiceFlag2.AMBISONIC : 0;
    if (req.ambisonic === true) this.listener.noteAmbisonicPlay(); // B5: LISTENER goes with the next frame even if the rotation is unchanged (C4)
    this.applySpatialOptions(i, req, true);
    const f = req.filter;
    if (f) {
      if (f.lowpass !== undefined) this.voiceFx.setLowpass(i, LowpassBy.EVENT, f.lowpass);
      if (f.highpass !== undefined) this.voiceFx.setHighpass(i, f.highpass);
    }
    if (req.aux) {
      const bus = this.busIndexByName.get(req.aux.bus);
      if (bus !== undefined) {
        this.voiceFx.setAux(i, bus, req.aux.level);
        t.flags2[i]! |= VoiceFlag2.AUX;
      }
    }
  }

  /**
   * §1.2 options at play (`initial`: omitted fields take K0's defaults: occlusion on, Doppler 0, send 1, the default
   * curve, yaw 0) or as a Play edit (omitted fields are kept). Callers clamp; this clamps again.
   */
  private applySpatialOptions(i: number, o: VoiceSpatialOptions, initial: boolean): void {
    const t = this.table;
    let f2 = t.flags2[i]!;
    // The bits say what the voice asks for; the view adds whether it is positioned (a source's position comes after its play).
    if (initial || o.occlusion !== undefined) f2 = (o.occlusion ?? true) ? f2 | VoiceFlag2.OCCLUSION : f2 & ~VoiceFlag2.OCCLUSION;
    if (o.dopplerLevel !== undefined && Number.isFinite(o.dopplerLevel)) t.dopplerLevel[i] = clamp(o.dopplerLevel, 0, 5);
    if (o.reverbSend !== undefined && Number.isFinite(o.reverbSend)) t.reverbSend[i] = clamp(o.reverbSend, 0, 2);
    if (o.reverbSendCurve !== undefined) t.sendCurve[i] = this.sendCurves.intern(o.reverbSendCurve);
    if (o.yaw !== undefined && Number.isFinite(o.yaw)) {
      t.yaw[i] = (clamp(o.yaw, -180, 180) * Math.PI) / 180;
      if ((f2 & VoiceFlag2.AMBISONIC) !== 0) this.voiceFx.setYaw(i, t.yaw[i]!);
    }
    f2 = t.reverbSend[i]! > 0 ? f2 | VoiceFlag2.SENDS : f2 & ~VoiceFlag2.SENDS;
    t.flags2[i] = f2;
  }

  /** @internal */
  _setPriority(id: number, priority: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(priority)) return;
    this.table.priority[i] = clamp(Math.round(priority), 0, 255);
    this.refreshGain(i);
  }

  /** @internal */
  _setAttenuation(id: number, a: Attenuation): void {
    const i = this.slot(id);
    if (i < 0) return;
    this.applyAttenuation(i, a);
    this.spatialDirty[i] = 1;
  }

  /** @internal */
  _setPosition(id: number, p: Vec3Like): void {
    const i = this.slot(id);
    if (i < 0) return;
    this.applyPosition(i, p);
    this.spatialDirty[i] = 1;
  }

  /** @internal */
  _setBus(id: number, bus: string): void {
    const i = this.slot(id);
    if (i < 0) return;
    const t = this.table;
    const old = t.bus[i]!;
    const next = this.busIndex(bus);
    if (old === next) return;
    t.bus[i] = next;
    if (t.busLive[old]! > 0) t.busLive[old]!--;
    t.busLive[next]!++;
    this.mixer.voiceEnded(this.names[old] ?? "");
    this.mixer.voiceStarted(this.names[next] ?? "");
    if (this.onCore(i)) this.writer.setParams(id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, next);
  }

  /** @internal */
  _setPaused(id: number, paused: boolean): void {
    const i = this.slot(id);
    if (i < 0) return;
    const t = this.table;
    t.flags[i] = paused ? t.flags[i]! | VoiceFlag.PAUSED : t.flags[i]! & ~VoiceFlag.PAUSED;
    if (this.onCore(i)) this.playheads.retime(i, this.clockMap.framesNow());
    if (this.onCore(i)) this.writer.setPaused(id, paused);
  }

  /**
   * @internal B3b: moves voice `id` to `seconds` of its sound. A stream voice restarts at the new epoch (`streams.ts`:
   * the old audio fades out over 5 ms in the core, the ring is flushed, the new audio fades in once decoded, and the
   * voice reads "waitingForData" meanwhile); a clip voice fades out, jumps and fades in. A loop wraps the time into
   * the sound; otherwise it clamps to the end (the voice then ends). A voice not on the core yet (its clip still
   * loading, or locked) ignores it.
   */
  _seek(id: number, seconds: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(seconds)) return;
    const t = this.table;
    const time = Math.max(0, seconds);
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) {
      const frame = this.streams.seek(t.clip[i]!, time);
      if (frame !== null) this.reanchorSeek(id, frame);
      return;
    }
    if (!this.onCore(i)) return;
    const info = this.clips.info(t.clip[i]!);
    if (!info || info.sampleRate <= 0) return;
    let frame = Math.round(time * info.sampleRate);
    if (info.frames > 0) frame = (t.flags[i]! & VoiceFlag.LOOP) !== 0 ? frame % info.frames : Math.min(frame, info.frames);
    this.writer.seek(id, frame, 0);
    this.reanchorSeek(id, frame);
  }

  /** E4.4: the playhead tracker's wrap (see the constructor). */
  private wrapPlayhead(i: number, pos: number): number {
    const t = this.table;
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) return this.streams.fileFrame(t.clip[i]!, pos);
    const frames = this.clips.info(t.clip[i]!)?.frames ?? 0;
    const region = this.automation.loopOf(i);
    if (region) return region.looping ? wrapPosition(pos, region.start, region.end, frames) : pos;
    return (t.flags[i]! & VoiceFlag.LOOP) !== 0 && frames > 0 ? pos % frames : pos;
  }

  /** B3b: the playhead tracker follows a seek: the voice is at `frame` from now on. */
  private reanchorSeek(id: number, frame: number): void {
    const i = this.slot(id);
    if (i >= 0) this.playheads.start(i, this.clockMap.framesNow(), frame);
  }

  // --- Internals ---

  private slot(id: number): number {
    return this.table.isLive(id) ? id & 0xffff : -1;
  }

  private onCore(i: number): boolean {
    const s = this.table.state[i]!;
    return s === VoiceState.PLAYING || s === VoiceState.VIRTUAL;
  }

  private busIndex(name: string): number {
    // M2 F1: plays mostly name the bus the last one did (the same string), so that one skips the map.
    if (name === this.lastBusName) return this.lastBusIndex;
    const index = this.busIndexByName.get(name) ?? 0;
    this.lastBusName = name;
    this.lastBusIndex = index;
    return index;
  }
  private lastBusName: string | null = null;
  /** ADR 0162 (K4): each bus's parent index for the bed planner (-1: the root), reused. */
  private readonly planParents = new Int16Array(MAX_BUSES);
  private lastBusIndex = 0;

  private applyAttenuation(i: number, a: Attenuation): void {
    this.table.minDist[i] = a.minDistance;
    this.table.maxDist[i] = a.maxDistance;
    this.table.rolloff[i] = a.rolloff === "linear" ? VoiceRolloff.LINEAR : a.rolloff === "exponential" ? VoiceRolloff.EXPONENTIAL : VoiceRolloff.INVERSE;
  }

  private applyPosition(i: number, p: Vec3Like): void {
    const t = this.table;
    t.posX[i] = p.x;
    t.posY[i] = p.y;
    t.posZ[i] = p.z;
    if ((t.flags[i]! & VoiceFlag.SPATIAL) === 0) {
      t.flags[i]! |= VoiceFlag.SPATIAL;
      this.spatialCount++;
    }
  }

  /** `gain` = volume times the distance gain (spatial), and the direction for a spatial voice; audibility from both and priority. */
  private refreshGain(i: number): void {
    const t = this.table;
    let gain = t.volume[i]!;
    if ((t.flags[i]! & VoiceFlag.SPATIAL) !== 0) {
      const basis = this.basis;
      basis.locate(t.posX[i]!, t.posY[i]!, t.posZ[i]!);
      const d = this.distance;
      d.model = ROLLOFF_NAMES[t.rolloff[i]!] ?? "inverse";
      d.refDistance = t.minDist[i]!;
      d.maxDistance = t.maxDist[i]!;
      gain *= Math.max(0, d.gain(basis.distance));
      t.dirX[i] = basis.dirX;
      t.dirY[i] = basis.dirY;
      t.dirZ[i] = basis.dirZ;
    }
    t.gain[i] = gain;
    this.selection.audibilityOf(i);
  }

  private sendGain(id: number, i: number): void {
    // Only a mixed voice is heard; a virtual one gets its gain with SET_MIXED when it is promoted (A3.1).
    if (this.table.state[i] === VoiceState.PLAYING) this.writer.setParams(id, SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, this.dryGain(i), 0, this.table.dirX[i]!, this.table.dirY[i]!, this.table.dirZ[i]!, 0, this.clockMap.rampFrames());
  }

  /** The voice's clip decides what happens next: play now, wait for the data, or fail. */
  private launch(id: number): void {
    const t = this.table;
    const i = id & 0xffff;
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) {
      // B4: AAC while `audio.codecs.aac` is off: never sent to the core, one warning per asset.
      const asset = this.streams.assetOf(t.clip[i]!) ?? "";
      const refused = aacRefusal(asset, this.aac);
      if (refused) {
        this.warnOnce(asset, refused);
        t.free(id, VoiceReason.FAILED);
        return;
      }
      return this.launchStream(id, i);
    }
    const clip = t.clip[i]!;
    const state = this.clips.state(clip);
    if (state === "ready") {
      this.applyImportGain(i, clip);
      // A3.1: mixed when there is room under the cap; otherwise virtual, and this frame's selection may promote it.
      const mixed = this.selection.admit(i, this.mixedCap());
      t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
      t.reason[i] = mixed ? VoiceReason.NONE : VoiceReason.VIRTUAL;
      this.sendPlay(id, i);
    } else if (state === "failed") {
      this.clipFailed(id, i);
    } else {
      t.state[i] = VoiceState.WAITING_FOR_DATA;
      t.reason[i] = VoiceReason.WAITING_FOR_DATA;
      this.clips.onResident(clip, (info: ClipInfo) => {
        if (!t.isLive(id) || t.state[i] !== VoiceState.WAITING_FOR_DATA) return;
        if (info.state === "ready") this.launch(id);
        else this.clipFailed(id, i);
      });
    }
  }

  /**
   * B5 (§2.4): a FuMa clip's import gain is known only once its decode reported, so a voice played before that carries a
   * volume without it (up to 3 dB too quiet). When the clip is ready, fold the gain in (the volume the caller gave
   * already holds `gainApplied[i]`). Only an ambisonic clip voice has a gain other than 1.
   */
  private applyImportGain(i: number, clip: number): void {
    const t = this.table;
    if ((t.flags2[i]! & VoiceFlag2.AMBISONIC) === 0) return;
    const path = this.clips.info(clip)?.path;
    if (path === undefined) return;
    const gain = ambisonicImportGain(path);
    const had = this.gainApplied[i]!;
    if (gain === had) return;
    t.volume[i] = t.volume[i]! * (gain / had);
    this.gainApplied[i] = gain;
    this.refreshGain(i);
  }

  /**
   * B5 (ADR 0162 §2.4): the voice's clip failed to load. A long ambisonic clip that was not decoded ("streamInstead")
   * restarts the voice as a stream voice (the same slot, id and options); any other failure ends the voice.
   */
  private clipFailed(id: number, i: number): void {
    const t = this.table;
    const info = this.clips.info(t.clip[i]!);
    if (info?.failure !== "streamInstead") {
      t.free(id, VoiceReason.FAILED);
      return;
    }
    this.clips.release(t.clip[i]!);
    const stream = this.streams.allocate();
    t.clip[i] = stream;
    t.flags[i] = t.flags[i]! | VoiceFlag.STREAM | VoiceFlag.WANTS_PLAYHEAD;
    this.streams.register(stream, id, info.path, (t.flags[i]! & VoiceFlag.LOOP) !== 0);
    this.launch(id);
  }

  /**
   * B3: a stream voice starts on the core at once, mixed or virtual like a clip voice, and waits there for its data
   * ("waitingForData"); the worker is asked to open the stream from `startFrame`.
   */
  private launchStream(id: number, i: number, startFrame = 0): void {
    const t = this.table;
    const mixed = this.selection.admit(i, this.mixedCap());
    t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
    t.reason[i] = VoiceReason.WAITING_FOR_DATA;
    this.sendPlay(id, i, startFrame);
    this.streams.open(t.clip[i]!, startFrame);
  }

  /**
   * B3, a hard rebuild (`Replayer.restore` hands over the live stream voices): each reopens on the new core with a new
   * stream id, from where its playhead is now (wrapped for loops; a finished one is dropped).
   */
  reopenStreams(ids: readonly number[]): void {
    const t = this.table;
    const frame = this.clockMap.framesNow();
    for (const id of ids) {
      if (!t.isLive(id)) continue;
      const i = id & 0xffff;
      const info = this.streams.clipInfo(t.clip[i]!);
      const frames = info?.frames ?? 0;
      // E4.4: the file frame by the stream's map: inside its loop region while it loops; a released (or plain) stream past its end is dropped.
      const pos = Math.max(0, Math.floor(this.playheads.wrappedNow(i, frame)));
      if (!this.streams.looping(t.clip[i]!) && frames > 0 && pos >= frames) {
        t.free(id, VoiceReason.NONE);
        continue;
      }
      t.clip[i] = this.streams.rekey(t.clip[i]!);
      this.launchStream(id, i, pos);
    }
  }

  private sendPlay(id: number, i: number, startOffsetFrames = 0): void {
    const t = this.table;
    // B5: a sidecar on a 1-2 channel clip is ignored (the registry warned): the voice isn't ambisonic.
    if ((t.flags2[i]! & VoiceFlag2.AMBISONIC) !== 0 && (t.flags[i]! & VoiceFlag.STREAM) === 0 && (this.clips.info(t.clip[i]!)?.channels ?? 3) <= 2) t.flags2[i] = t.flags2[i]! & ~VoiceFlag2.AMBISONIC;
    const a = this.playArgs;
    a.voiceId = id;
    a.clip = t.clip[i]!;
    a.bus = t.bus[i]!;
    const f = t.flags[i]!;
    a.group = t.group[i]!;
    a.flags =
      (t.state[i] === VoiceState.PLAYING ? PLAY_FLAGS_MIXED : 0) |
      (f & VoiceFlag.LOOP ? PLAY_FLAGS_LOOP : 0) |
      (f & VoiceFlag.SPATIAL ? PLAY_FLAGS_SPATIAL : 0) |
      (f & VoiceFlag.STREAM ? PLAY_FLAGS_STREAM | PLAY_FLAGS_WANTS_PLAYHEAD : 0) |
      (t.flags2[i]! & VoiceFlag2.AMBISONIC ? PLAY_FLAGS_AMBISONIC : 0);
    a.startOffsetFrames = startOffsetFrames;
    // ADR 0162 (K4): the dry gain with occlusion, the pitch with Doppler, and main's lpHz (`voiceFx`), all M2's values at the defaults.
    a.gain = this.dryGain(i);
    a.pitch = this.sentPitch(i);
    a.dirX = t.dirX[i]!;
    a.dirY = t.dirY[i]!;
    a.dirZ = t.dirZ[i]!;
    a.lpHz = t.lpHz[i]!;
    a.score = t.audibility[i]!;
    this.selection.noteScoreSent(i, a.score);
    const start = t.startFrame[i]!;
    // A3.2: stamped at its frame while that is ahead of F_now; past (or asap) goes asap (§1 `at`, `lookahead.ts`).
    const stamp = this.clockMap.stampFor(start);
    this.writer.play(a, stamp);
    this.playheads.start(i, stamp ?? this.clockMap.framesNow(), a.startOffsetFrames);
    // ADR 0158: the voice's bindings and loop, right behind its PLAY.
    this.automation.onPlaySent(id, i, stamp);
    // ADR 0162 (C3): its SET_VOICE_FX at the same frame, when mixed and non-default.
    this.voiceFx.onPlay(i, stamp);
    // A3.7: paused before it reached the core (locked, or its clip loading): it waits there, paused, until resumed.
    if (f & VoiceFlag.PAUSED) this.writer.setPaused(id, true);
    if (start > 0) t.startFrame[i] = 0;
    this.spatialDirty[i] = 0;
  }

  /** The context started running: voices that waited for it start now. */
  private unlock(): void {
    this.lockedQueue.drain(performance.now(), (id) => {
      const i = id & 0xffff;
      if (this.table.isLive(id) && this.table.state[i] === VoiceState.LOCKED) {
        this.table.startFrame[i] = 0;
        this.refreshGain(i);
        this.launch(id);
      }
    });
  }

  /** Spatial voices whose source or the listener moved: new gain and direction when they changed beyond epsilon. */
  private moveSpatial(): void {
    const t = this.table;
    const all = this.listenerDirty;
    this.listenerDirty = false;
    const ramp = this.clockMap.rampFrames();
    for (let i = 0; i < t.capacity; i++) {
      if ((t.flags[i]! & VoiceFlag.SPATIAL) === 0 || t.state[i] === VoiceState.FREE) continue;
      if (!all && this.spatialDirty[i] === 0) continue;
      if (!this.onCore(i)) continue;
      this.spatialDirty[i] = 0;
      if (t.state[i] === VoiceState.VIRTUAL) {
        // Virtual (A3.1): fresh gain and direction for its audibility; nothing is sent until it is promoted.
        this.refreshGain(i);
        continue;
      }
      const g = t.gain[i]!;
      const x = t.dirX[i]!;
      const y = t.dirY[i]!;
      const z = t.dirZ[i]!;
      this.refreshGain(i);
      if (Math.abs(t.gain[i]! - g) > GAIN_EPSILON || Math.abs(t.dirX[i]! - x) > DIR_EPSILON || Math.abs(t.dirY[i]! - y) > DIR_EPSILON || Math.abs(t.dirZ[i]! - z) > DIR_EPSILON) {
        const id = ((t.gen[i]! << 16) | i) >>> 0;
        this.writer.setParams(id, SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, this.dryGain(i), 0, t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, 0, ramp);
      } else {
        t.gain[i] = g;
        t.dirX[i] = x;
        t.dirY[i] = y;
        t.dirZ[i] = z;
      }
    }
  }

  /** A3.1: the frame's selection over every logical voice, at the current mixed cap. */
  private select(): void {
    if (this.table.liveCount === 0) return;
    this.selection.run(this.mixedCap(), this.selectionSink);
  }

  /** SET_MIXED for slot `i` (selection's change); a promote carries the voice's current gain, direction and `lpHz`. */
  private sendMixed(i: number, mixed: boolean): void {
    const t = this.table;
    const id = ((t.gen[i]! << 16) | i) >>> 0;
    if (mixed) this.spatialDirty[i] = 0;
    this.writer.setMixed(id, mixed, this.dryGain(i), t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, t.lpHz[i]!);
    // ADR 0162 (C20): a promote re-sends the voice's send, high-pass, yaw and aux targets with its SET_MIXED.
    if (mixed) this.voiceFx.onPromote(i);
    else this.voiceFx.onDemote(i);
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
    if ((limit <= 0 && !beds) || this.spatialCount === 0) {
      if (this.panners.count > 0 || this.panners.bedCount > 0) this.panners.clear(this.pannerSink);
      return;
    }
    if (beds && hrtfOn) this.magls.ensure();
    const limits = this.pannerLimits;
    limits.hrtf = limit;
    limits.nowMs = this.gameMs;
    limits.bedSlot = this.beds.bedSlot;
    if (this.panners.run(limits, this.pannerSink) > 0) this.hrir.ensure();
  }
  /** ADR 0162 (K4): the panner pick's inputs, reused (`bedSlot` is the bed planner's live map). */
  private readonly pannerLimits: { hrtf: number; nowMs: number; bedSlot: ArrayLike<number> } = { hrtf: 0, nowMs: 0, bedSlot: new Uint8Array(0) };

  /** H3, ADR 0162 C1: SET_PARAMS `flags` for slot `i`'s panner kind (0 equal-power, 1 HRTF, 2 bed). */
  private sendPanner(i: number, kind: PannerKindCode): void {
    const t = this.table;
    this.writer.setPanner(((t.gen[i]! << 16) | i) >>> 0, kind);
    // A voice on the bed takes its sharing chain's snapshot low-pass; one leaving it drops it.
    if (kind === PannerKind.BED || this.beds.slotCount > 0) this.voiceFx.setLowpass(i, LowpassBy.SNAPSHOT, kind === PannerKind.BED ? this.beds.chainLowpass[t.bus[i]!]! : BUS_LP_OFF_HZ);
  }

  /** A3.3: selection re-sends slot `i`'s score (its audibility moved), the core's key for its own lowest-score demote. */
  private sendScore(i: number, score: number): void {
    const t = this.table;
    this.writer.setScore(((t.gen[i]! << 16) | i) >>> 0, score);
  }

  /**
   * B5 (architecture §2.3): whether a new ambisonic voice at `priority` may start. `min(max_wide laid out, audio.ambisonic.
   * maxClips)` voices of either kind (a clip or a stream, mixed or virtual) may be live; past that the lowest priority is
   * stolen (the lowest audibility among equals), unless every one of them is at or above `priority` (the play is refused,
   * as `VoiceTable.allocate` does). A limit of 0 refuses with one warning.
   */
  private admitAmbisonic(path: string, priority: number): boolean {
    const t = this.table;
    const limit = Math.min(this.host.preset.maxWide ?? 0, this.mixer.audioSettings.ambisonic?.maxClips ?? 0);
    if (limit <= 0) {
      this.warnOnce(`${path}#ambisonic-refused`, `audio: "${path}" is an ambisonic clip, but ${this.mixer.audioSettings.ambisonic?.maxClips === 0 ? "audio.ambisonic.maxClips is 0" : "the audio core has no room for ambisonic voices"}; not played (ADR 0162)`);
      return false;
    }
    let count = 0;
    let victim = -1;
    let victimPriority = 256;
    let victimAudibility = Number.POSITIVE_INFINITY;
    for (let i = 0; i < t.capacity; i++) {
      const s = t.state[i]!;
      if (s === VoiceState.FREE || s === VoiceState.STOPPING || s === VoiceState.ENDING || (t.flags2[i]! & VoiceFlag2.AMBISONIC) === 0) continue;
      count++;
      const p = t.priority[i]!;
      const a = t.audibility[i]!;
      if (p < victimPriority || (p === victimPriority && a < victimAudibility)) {
        victim = i;
        victimPriority = p;
        victimAudibility = a;
      }
    }
    if (count < limit) return true;
    if (victim < 0 || victimPriority >= priority) {
      t.refusedCount++;
      return false;
    }
    this.stealSlot(victim);
    return true;
  }

  /** Selection stole slot `i` (its bus is past `maxVoices`): free it as STOLEN; `onFree` stops it on the core. */
  private stealSlot(i: number): void {
    const t = this.table;
    t.stolenCount++;
    t.free(((t.gen[i]! << 16) | i) >>> 0, VoiceReason.STOLEN);
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

  private onFree(id: number, bus: number): void {
    const i = id & 0xffff;
    const t = this.table;
    // Freed while still on the core (a steal: allocation's, or selection's past a bus's `maxVoices`): stop it there,
    // or it would sound on until a PLAY reuses the slot (the new voice may be waiting for its clip). The state is
    // still the old one here; natural ends (ENDING) are already gone from the core.
    const s = t.state[i]!;
    if (s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING) this.writer.stop(id, STEAL_FADE_SECONDS);
    // B3: a stream voice's stream closes on the worker (the worklet frees its ring); a clip voice drops its reference.
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) this.streams.close(t.clip[i]!);
    else this.clips.release(t.clip[i]!);
    this.panners.forget(i);
    this.automation.forget(i);
    // ADR 0162 (K4): the M3 per-slot state goes with the voice.
    this.voiceFx.forget(i);
    this.occlusion.forget(i);
    this.doppler.forget(i);
    this.zones.forget(i);
    this.mixer.voiceEnded(this.names[bus] ?? "");
    if ((t.flags[i]! & VoiceFlag.SPATIAL) !== 0) this.spatialCount--;
    t.flags[i] = 0;
    this.spatialDirty[i] = 0;
  }
}

/** One voice; every call checks the id is still live. */
/**
 * One voice. M2 F1: the voice is its own `AudioHandle` (one object per voice start, not two): `playing`, `alive`,
 * `reason`, `stop` and `fade` are the handle's, with M1's semantics; `handle` is the voice itself.
 */
class Voice extends AudioHandle implements CoreVoice {
  constructor(
    private readonly backend: CoreBackend,
    id: number,
  ) {
    super(backend.table, id);
  }

  get handle(): AudioHandle {
    return this;
  }

  setVolume(v: number): void {
    this.backend._setVolume(this.id, v);
  }

  setPitch(rate: number): void {
    this.backend._setPitch(this.id, rate);
  }

  setAttenuation(a: Attenuation): void {
    this.backend._setAttenuation(this.id, a);
  }

  setPosition(p: Vec3Like): void {
    this.backend._setPosition(this.id, p);
  }

  setBus(bus: string): void {
    this.backend._setBus(this.id, bus);
  }

  setPriority(priority: number): void {
    this.backend._setPriority(this.id, priority);
  }

  pause(): void {
    this.backend._setPaused(this.id, true);
  }

  resume(): void {
    this.backend._setPaused(this.id, false);
  }

  seek(seconds: number): void {
    this.backend._seek(this.id, seconds);
  }

  // ADR 0162 (K0, K4): main's M3 results and options.
  setVelocity(v: Vec3Like): void {
    this.backend._setVelocity(this.id, v);
  }

  setOcclusion(gain: number, lpHz: number): void {
    this.backend._setOcclusion(this.id, gain, lpHz);
  }

  setDopplerRate(factor: number): void {
    this.backend._setDopplerRate(this.id, factor);
  }

  setSpatialOptions(o: VoiceSpatialOptions): void {
    this.backend._setSpatialOptions(this.id, o);
  }
}

/**
 * ADR 0162 (K4): the core's `SpatialVoiceView` over its voice table (`spatial.ts`). `collect` lists the voices on the core
 * (PLAYING or VIRTUAL) once per frame and computes their view flags; the per-slot arrays are the table's own. Results go
 * to the backend (`occlusionAt`, `dopplerAt`), so the passes never touch the table.
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

/**
 * The factory `service.ts` registers with `registerCoreBackend`: wires the registry to the host (its messages go
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
  };
  const backend = new CoreBackend(backendHost, { ...deps, clips, warnOnce, clock: deps.clock ?? browserHostClock(() => host.context) });
  attachBackground(backend, host);
  return backend;
}

/** A3.4b: the visibility, device-event and stall controller (`background.ts`) for a backend on the page's host. */
function attachBackground(backend: CoreBackend, host: AudioHost): void {
  const controller = new BackgroundController({ host, target: backend });
  backend.health = controller.counters;
  backend.addCleanup(() => controller.dispose());
  controller.start();
}
