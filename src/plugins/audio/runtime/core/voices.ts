// ADR 0176: the core voice, as one module. `CoreVoices` owns a voice's state and changes on main, from its start to its
// free: what a play writes into the voice table, whether it launches, waits for its clip or fails, every setter
// (volume, pitch, bus, pause, seek, priority, attenuation, position, occlusion, Doppler, spatial options), what goes to
// the core for it (the dry gain, the pitch with Doppler, mixed or virtual, its score), a music stem's lookahead and
// stale re-sends (F-9b, F-12), and the refusals it reports (§5.6 `voiceRefused`, warnings). It is the one writer of the
// voice table's columns for those concerns; everything else reads them through the effective views below.
//
// Interface (what a caller must know):
// - Voices are named by id (`gen << 16 | slot`); every by-id call checks the id is live and does nothing otherwise. The
//   slot-level calls (`…At(i, …)`, `refreshGain`, `onFree`) are for the backend's own frame passes, which already hold
//   a live slot.
// - `start(req)` allocates and fills a slot and returns the id (0: refused); unless the core session may send now (ADR
//   0291: locked, or a rebuild running) the voice queues in `lockedQueue` and `unlock()` launches it once it may.
// - What reaches the core: only a mixed (PLAYING) voice gets SET_PARAMS for gain and direction; a virtual one keeps
//   fresh values in the table, and its promote's SET_MIXED carries them. Pitch, pause and bus go to any voice on the
//   core (PLAYING or VIRTUAL). Nothing goes before the voice's PLAY.
// - Ordering: the frame calls `moveSpatial` (after the clock's frame start and the stems' resolve), `select`, and at
//   commit `resendStaleStems` (before the BATCH flush). A rebuild calls `beginRecovery` (the pending stamped frames
//   change meaning) and the replay reads the effective views; `recoveryFailed` and `dispose` end every voice or queue.
// - The effective views (`effectiveDryGain`, `dryGainBeforeStem`, `effectivePitch`, `reportedGain`, `reportedPitch`)
//   are the only definitions of those quantities: the replay, `Audio.debug()`, the capture's keyframes and musicOps read
//   them. Selection's audibility (`selection.ts`) is a different quantity (`audibility0 × occGain`, with the fade,
//   automation, stem audible level, bus and priority) and stays selection's.
// - The hot paths (start, a setter, a frame with nothing moving) allocate nothing beyond the voice object the backend
//   makes per start (`eventBench`'s start+stop heap gate).
import type { Vec3Like } from "../../../../engine/core/math";
import type { Mixer } from "../../../../engine/audio/mixer";
import type { Attenuation, AudioPanner, FadeLaw, ListenerPose, PlayRequest, ShapedFade, VoiceEnvelope, VoiceSpatialOptions } from "../backend";
import { fitAmpEnvelope } from "../../../../engine/audio/effects/ampEnvelope";
import { generatorKindIndex } from "../../../../engine/audio/generators/catalogue";
import { GEN_MASK_ALL } from "./commandWriter";
import { AMP_ENV_KEY_OFF_NONE, BUS_LP_OFF_HZ, ClipFormat, GEN_CLIP_ID_FIRST, PLAY_FLAGS_AMBISONIC, PLAY_FLAGS_LOOP, PLAY_FLAGS_MIXED, PLAY_FLAGS_REVERSE, PLAY_FLAGS_SPATIAL, PLAY_FLAGS_STREAM, PLAY_FLAGS_WANTS_PLAYHEAD, SET_PARAMS_MASK_BUS, SET_PARAMS_MASK_DIR, SET_PARAMS_MASK_GAIN, SET_PARAMS_MASK_PITCH } from "../wire.generated";
import type { ClockMap } from "./clock";
import type { CommandWriter, FramesEnvelope, PlayArgs } from "./commandWriter";
import { ambisonicImportGain, type ClipInfo, type ClipRegistry } from "./clipRegistry";
import { aacRefusal, unsupportedFormat, type WarnOnce } from "./codecs";
import type { CoreAutomation } from "./coreAutomation";
import { wrapPosition } from "./coreAutomation";
import type { CorePlayRequest } from "./coreBackend";
import type { SendGate } from "./session";
import type { DopplerPass } from "./doppler";
import type { CoreMusicOps } from "./musicOps";
import { pannerName, type PannerPick } from "./pannerPick";
import type { Presence } from "./presence";
import type { PlayheadTracker } from "./replay";
import { generatorVoiceCost, ListenerBasis, type Selection, type SelectionSink } from "./selection";
import { DistanceEffect, type SendCurveTable } from "./spatial";
import { STREAM_ERROR_FADE_SECONDS, type StreamManager } from "./streams";
import type { StructuralDip } from "./structuralDip";
import { UnlockQueue } from "./unlockQueue";
import { MAX_STEM_PENDING, VoiceFlag, VoiceFlag2, VoiceReason, VoiceRolloff, VoiceState, type VoiceTable } from "./voiceTable";
import { LowpassBy, type VoiceFx } from "./voiceFx";
import { MAX_GROUPS } from "../automation";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";

const DIR_EPSILON = 0.005;
const GAIN_EPSILON = 0.001;
const MAX_PITCH = 16;
const MIN_PITCH = 0.0625;
const ROLLOFF_NAMES = ["linear", "inverse", "exponential"] as const;
/** Architecture §4.7: promote and demote fade 5 ms; a voice stolen while on the core fades out as long. */
const STEAL_FADE_SECONDS = 0.005;
/** The core's promote, demote and pause fade (`MIX_FADE_SECONDS` in `voices.rs`): a mixed voice fades out this long before it holds. */
const MIX_FADE_SECONDS = 0.005;
/** `flipTo`: the stamped change a slot's mirror takes at `flipAt` (ADR 0362 §1). */
const FLIP_NONE = 0;
const FLIP_PAUSE = 1;
const FLIP_RESUME = 2;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const idAt = (t: VoiceTable, i: number): number => ((t.gen[i]! << 16) | i) >>> 0;

// --- The effective views: the one definition of each quantity (read by the replay, debug, keyframes, musicOps) ---

/**
 * Slot `i`'s dry gain without a music stem's level: volume × distance gain (`gain`) × occlusion (`occGain`, 1 open).
 * A stem's in-voice gain ramp multiplies this (`musicOps.paramsShaped`, the F-9b re-sends), so its level is never
 * applied twice.
 */
export function dryGainBeforeStem(t: VoiceTable, i: number): number {
  return t.gain[i]! * t.occGain[i]!;
}

/**
 * The dry gain the core gets for slot `i`: `dryGainBeforeStem` × a music stem's level (F-9b: `stemDry`, 1 for other
 * voices). Every dry-gain write (PLAY, SET_MIXED's promote, a volume set, occlusion, a spatial move, the rebuild's
 * replay) sends this, so none resets the stem's in-voice ramp to the plain dry gain. (The branch keeps an ordinary
 * voice's start as it was: a third multiply there costs eventBench's start+stop about 32 B of heap.)
 */
export function effectiveDryGain(t: VoiceTable, i: number): number {
  const dry = t.gain[i]! * t.occGain[i]!;
  const stem = t.stemDry[i]!;
  return stem === 1 ? dry : dry * stem;
}

/** The pitch the core gets for slot `i`: its pitch times its Doppler factor, clamped (exactly the pitch at factor 1). */
export function effectivePitch(t: VoiceTable, i: number): number {
  const f = t.dopplerFactor[i]!;
  return f === 1 ? t.pitch[i]! : clamp(t.pitch[i]! * f, MIN_PITCH, MAX_PITCH);
}

/**
 * The gain `Audio.debug()` and the capture's keyframes report for slot `i`: volume × distance gain × the automation's
 * gain (`autoGain`: main's estimate of the core's smoothed parameter, 1 without one) × a music stem's audible level
 * (`stemGain`, as its audibility has it). Occlusion is reported in its own column.
 */
export function reportedGain(t: VoiceTable, i: number, autoGain: number): number {
  return t.gain[i]! * autoGain * t.stemGain[i]!;
}

/** The pitch `Audio.debug()` and the capture's keyframes report for slot `i`: its pitch × the automation's (1 without one). */
export function reportedPitch(t: VoiceTable, i: number, autoPitch: number): number {
  return t.pitch[i]! * autoPitch;
}

/** What `CoreVoices` needs of the backend: its per-concern parts, and closures for what the backend decides. */
export interface CoreVoicesHost {
  readonly table: VoiceTable;
  readonly writer: CommandWriter;
  readonly clockMap: ClockMap;
  readonly clips: ClipRegistry;
  readonly mixer: Mixer;
  readonly selection: Selection;
  readonly playheads: PlayheadTracker;
  readonly voiceFx: VoiceFx;
  readonly listener: { noteAmbisonicPlay(): void };
  readonly sendCurves: SendCurveTable;
  readonly panners: PannerPick;
  readonly doppler: DopplerPass;
  readonly occlusion: { forget(i: number): void };
  readonly zones: { forget(i: number): void };
  readonly streams: StreamManager;
  readonly musicOps: CoreMusicOps;
  readonly automation: CoreAutomation;
  readonly dip: StructuralDip;
  readonly presence: Presence;
  readonly warnOnce: WarnOnce;
  /** The bus names by index (`busIndex.ts`). */
  busNames(): readonly string[];
  busIndexByName(): ReadonlyMap<string, number>;
  /** §6.3 a bus index's `busRef`, for `voiceRefused`. */
  busRef(bus: number): number;
  /** The capture's event taps (the null object until a recorder runs). */
  profile(): ProfileSink;
  /** B4 `audio.codecs.aac`. */
  aac(): boolean;
  /** Selection's mixed cap (`CoreBackend.mixedCap`). */
  mixedCap(): number;
  /** B5: the wide (ambisonic) voices the core laid out (`preset.maxWide`). */
  maxWide(): number;
  /** ADR 0291: the core session, asked whether a voice may start now (`maySend`) or must wait in the locked queue. */
  readonly session: Pick<SendGate, "maySend">;
  /** F-12: true while stale stem changes must wait (a rebuild, or the replay waiting for the new context's clock). */
  holdStemResends(): boolean;
}

/**
 * ADR 0362 item 2: a voice's Amp envelope in frames at `rate` (the context's: the envelope moves one frame per output
 * frame), fitted to its span as `fitAmpEnvelope` (and the core's `Adsr::fit`) fit it, from frames rounded once.
 */
export function envelopeFrames(env: VoiceEnvelope, rate: number): FramesEnvelope {
  const f = (s: number): number => Math.max(0, Math.min(0xfffffffe, Math.round((Number.isFinite(s) ? s : 0) * rate)));
  const s = env.stages;
  const fit = fitAmpEnvelope({ attack: f(s.attack), hold: f(s.hold), decay: f(s.decay), sustain: s.sustain, release: f(s.release) }, env.length === null ? null : f(env.length));
  return { attack: fit.attack, hold: fit.hold, decay: fit.decay, sustain: fit.sustain, release: fit.release, keyOff: fit.keyOff === null ? AMP_ENV_KEY_OFF_NONE : fit.keyOff };
}

/** The core voice (see the header). */
export class CoreVoices {
  /** @internal Each slot's `PlayRequest.owner` (the playing node's name), for `debug()`'s voice rows; null for none. */
  readonly owners: (string | null)[] = [];
  /** D5: voices played while locked. One-shots are capped (32 for 1 s); owned and looping voices wait. */
  readonly lockedQueue: UnlockQueue<number>;
  /** A3.1: the selection's sink (SET_MIXED, steals, scores). */
  readonly selectionSink: SelectionSink;
  private readonly t: VoiceTable;
  /** B5: per slot, the FuMa import gain (`ambisonicImportGain`) the voice's volume already carries; 1 when none was known at its play. */
  private readonly gainApplied: Float32Array;
  private spatialVoices = 0;
  private readonly spatialDirty: Uint8Array;
  /**
   * F-12: per slot, pending stem changes the core holds with an old dry gain (sent before a later dry write, further out
   * than its lookahead): those stamped after `stemStaleAfter` and not after `stemStaleTo` (0: none) go again, with the
   * dry gain as it is then, once each comes within a lookahead (`resendStaleStems`).
   */
  private readonly stemStaleAfter: Float64Array;
  private readonly stemStaleTo: Float64Array;
  /** `PlayRequest.offset` per slot, seconds into the source, until the voice's PLAY carries it (0: the start). */
  private readonly startOffset: Float64Array;
  /** W12: per slot, the stream frame a stream voice opens at (`CorePlayRequest.streamStartFrame`: after a head clip), else 0. */
  private readonly streamStart: Uint32Array;
  /** ADR 0362: per slot, the voice's Amp envelope (`PlayRequest.envelope`), or null. */
  private readonly envelopes: (VoiceEnvelope | null)[] = [];
  /** ADR 0362: per slot, the context frame its PLAY went out for (its envelope's offset counts from there). */
  private readonly envelopeFrom: Float64Array;
  private stemStaleCount = 0;
  /**
   * F-24: per slot, the id of the voice whose PLAY went out flat (non-spatial, not ambisonic), else 0. The core reads
   * `spatial` from PLAY only, so such a voice stays flat: a position given afterwards is refused (`setPosition`).
   */
  private readonly flatPlayId: Uint32Array;
  private listenerDirty = true;
  private readonly listenerPos: [number, number, number] = [0, 0, 0];
  private readonly listenerFwd: [number, number, number] = [0, 0, 1];
  private readonly listenerUp: [number, number, number] = [0, 1, 0];
  private readonly distance = new DistanceEffect();
  private readonly basis = new ListenerBasis();
  private readonly playArgs: PlayArgs = { voiceId: 0, clip: 0, bus: 0, flags: 0, group: 0, gain: 1, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: BUS_LP_OFF_HZ, score: 0, startOffsetFrames: 0 };
  private lastBusName: string | null = null;
  private lastBusIndex = 0;
  /**
   * ADR 0362 §1: per slot, a stamped pause or resume (`flipTo`) the core applies at a frame, and the context frame the
   * mirror takes it at (`flipAt`: where the voice holds, or where it continues). Until then the mirror keeps the old
   * state: main must not force the voice virtual before the core holds it, nor promote it before the core resumes it
   * (the core drops a promote while paused). `flips` counts the slots with one.
   */
  private readonly flipTo: Uint8Array;
  private readonly flipAt: Float64Array;
  private flips = 0;

  constructor(private readonly host: CoreVoicesHost) {
    const t = (this.t = host.table);
    this.spatialDirty = new Uint8Array(t.capacity);
    this.stemStaleAfter = new Float64Array(t.capacity);
    this.stemStaleTo = new Float64Array(t.capacity);
    this.startOffset = new Float64Array(t.capacity);
    this.streamStart = new Uint32Array(t.capacity);
    this.envelopeFrom = new Float64Array(t.capacity);
    this.flatPlayId = new Uint32Array(t.capacity);
    this.flipTo = new Uint8Array(t.capacity);
    this.flipAt = new Float64Array(t.capacity);
    this.gainApplied = new Float32Array(t.capacity).fill(1);
    this.basis.set(this.listenerPos, this.listenerFwd, this.listenerUp);
    this.lockedQueue = new UnlockQueue<number>({
      onDrop: (id) => {
        if (t.isLive(id) && t.state[id & 0xffff] === VoiceState.LOCKED) t.free(id, VoiceReason.NONE);
      },
    });
    this.selectionSink = {
      setMixed: (i, mixed) => this.sendMixed(i, mixed),
      steal: (i) => this.stealSlot(i),
      setScore: (i, score) => this.sendScore(i, score),
    };
  }

  // --- The effective views, by slot (see the free functions) ---

  /** The dry gain the core gets for slot `i` (`effectiveDryGain`). */
  private dryGain(i: number): number {
    return effectiveDryGain(this.t, i);
  }

  /** Slot `i`'s dry gain without its stem level (`dryGainBeforeStem`). */
  private dryGainBeforeStem(i: number): number {
    return dryGainBeforeStem(this.t, i);
  }

  /** The pitch the core gets for slot `i` (`effectivePitch`). */
  private sentPitch(i: number): number {
    return effectivePitch(this.t, i);
  }

  /** Spatial voices live (the panner pick runs only with one). */
  get spatialCount(): number {
    return this.spatialVoices;
  }

  // --- Start: allocate, fill, launch (or queue) ---

  /**
   * Starts a voice for `req`: allocates a slot and fills it (volume, pitch, flags, attenuation, position, the M3 options),
   * counts its bus and presence, then launches it when the session may send, else queues it until `unlock`. Returns its id, or 0
   * when refused (the ambisonic cap, a full table of higher priority; the clip reference is released).
   */
  start(req: CorePlayRequest): number {
    const host = this.host;
    const running = host.session.maySend;
    const world = req.world ?? 0;
    const group = req.group !== undefined && Number.isInteger(req.group) && req.group >= 1 && req.group <= MAX_GROUPS ? req.group : 0;
    // B5: `audio.ambisonic.maxClips` caps concurrent ambisonic voices; main steals the lowest priority first (the core's steal is a backstop).
    if (req.ambisonic === true && !this.admitAmbisonic(req.path, req.priority ?? 128, req.bus)) return 0;
    // ADR 0360 (G3): a generator voice plays its kind's reserved clip id (never uploaded: no registry reference).
    const gen = req.generator;
    const genKind = gen ? generatorKindIndex(gen.kind) : 0;
    // B3: a stream voice takes a stream id where a clip voice takes a registry clip (no clip load).
    const stream = !gen && req.stream === true;
    // ADR 0166 (Q2): a streamed group member plays the stream musicOps allocated and primed (P1).
    const member = req.music;
    const clip = gen ? GEN_CLIP_ID_FIRST + genKind : stream ? (member?.stream ?? host.streams.allocate()) : this.acquireClip(req, world);
    const bus = this.busIndex(req.bus);
    const priority = req.priority ?? 128;
    // A stream voice has no registry clip to name, so a refused stream play is named by its asset path.
    const t = this.t;
    const id = t.allocate(bus, priority, world, running ? VoiceState.WAITING_FOR_DATA : VoiceState.LOCKED, stream ? 0 : clip, stream ? req.path : undefined);
    if (id === 0) {
      if (!stream && !gen) host.clips.release(clip);
      return 0;
    }
    const i = id & 0xffff;
    t.clip[i] = clip;
    t.group[i] = group;
    // ADR 0345 levels (ABI 4.9): the voice's playlist level's submix, named by a ROUTE right after its PLAY.
    t.submix[i] = req.submix && Number.isInteger(req.submix.slot) && req.submix.slot >= 0 && req.submix.slot < 255 ? req.submix.slot + 1 : 0;
    this.owners[i] = req.owner ?? null;
    t.volume[i] = req.volume !== undefined && Number.isFinite(req.volume) ? Math.max(0, req.volume) : 1;
    this.gainApplied[i] = req.ambisonic === true && !stream ? ambisonicImportGain(req.path) : 1;
    t.pitch[i] = req.pitch !== undefined && Number.isFinite(req.pitch) ? clamp(req.pitch, MIN_PITCH, MAX_PITCH) : 1;
    t.flags[i] = (req.loop ? VoiceFlag.LOOP : 0) | (req.oneShot ? VoiceFlag.ONE_SHOT : 0) | (stream ? VoiceFlag.STREAM | VoiceFlag.WANTS_PLAYHEAD : 0);
    this.startOffset[i] = !gen && req.offset !== undefined && Number.isFinite(req.offset) && req.offset > 0 ? req.offset : 0;
    if (gen) {
      // ADR 0360: its parameters and seed for the GEN behind its PLAY (and a REPLAY); a silence is never mixed.
      t.setGenerator(i, genKind, gen.values, gen.seed, req.path, generatorVoiceCost(gen.kind, gen.values));
      if (gen.kind === "silence") t.flags[i] = t.flags[i]! | VoiceFlag.VIRTUAL_ONLY;
    }
    this.streamStart[i] = stream && req.streamStartFrame !== undefined && Number.isInteger(req.streamStartFrame) && req.streamStartFrame > 0 ? req.streamStartFrame : 0;
    if (member) host.musicOps.adoptMember(id, i, member);
    else if (stream) host.streams.register(clip, id, req.path, req.loop === true);
    t.lpHz[i] = BUS_LP_OFF_HZ;
    t.dirX[i] = 0;
    t.dirY[i] = 0;
    t.dirZ[i] = -1;
    if (req.attenuation) this.applyAttenuation(i, req.attenuation);
    if (req.position) this.applyPosition(i, req.position);
    this.applyM3Request(i, req);
    // ADR 0362: a clip voice read backwards, and a voice's Amp envelope (both behind its PLAY).
    if (req.reverse === true && !stream && !gen) t.flags2[i] = t.flags2[i]! | VoiceFlag2.REVERSE;
    this.envelopes[i] = req.envelope ?? null;
    this.refreshGain(i);
    // `at` is ignored while locked (API §1); the stamp-or-asap choice is made when the PLAY is sent (`sendPlay`).
    t.startFrame[i] = running ? host.clockMap.frameOfTime(req.at) : 0;
    host.mixer.voiceStarted(host.busNames()[bus] ?? "");
    host.presence.voiceStarted(bus, i);
    if (running) this.launch(id);
    else if (req.oneShot && !req.loop) this.lockedQueue.pushOneShot(id, performance.now());
    else this.lockedQueue.pushOwned(id);
    return id;
  }

  /** Once the session may send (the context runs, no rebuild), the voices that waited start (run every frame). */
  unlock(): void {
    if (this.lockedQueue.size === 0 || !this.host.session.maySend) return;
    const t = this.t;
    this.lockedQueue.drain(performance.now(), (id) => {
      const i = id & 0xffff;
      if (t.isLive(id) && t.state[i] === VoiceState.LOCKED) {
        t.startFrame[i] = 0;
        this.refreshGain(i);
        this.launch(id);
      }
    });
  }

  /** A clip voice's registry reference: the whole clip, or (C14, R4a) its decoded span when the request names one. */
  private acquireClip(req: CorePlayRequest, world: number): number {
    const clips = this.host.clips;
    const span = req.span;
    if (span && clips.acquireSpan) return clips.acquireSpan(req.path, span.startFrame, span.endFrame, world);
    return clips.acquire(req.path, world);
  }

  /**
   * B5 (architecture §2.3): whether a new ambisonic voice at `priority` may start. `min(max_wide laid out, audio.ambisonic.
   * maxClips)` voices of either kind (a clip or a stream, mixed or virtual) may be live; past that the lowest priority is
   * stolen (the lowest audibility among equals), unless every one of them is at or above `priority` (the play is refused,
   * as `VoiceTable.allocate` does). A limit of 0 refuses with one warning.
   */
  private admitAmbisonic(path: string, priority: number, bus: string): boolean {
    const t = this.t;
    const host = this.host;
    const settings = host.mixer.audioSettings;
    const limit = Math.min(host.maxWide(), settings.ambisonic?.maxClips ?? 0);
    if (limit <= 0) {
      host.warnOnce(`${path}#ambisonic-refused`, `audio: "${path}" is an ambisonic clip, but ${settings.ambisonic?.maxClips === 0 ? "audio.ambisonic.maxClips is 0" : "the audio core has no room for ambisonic voices"}; not played (ADR 0162)`);
      // A limit of 0 can never admit this voice.
      this.refused(path, this.busIndex(bus), "neverFits");
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
      this.refused(path, this.busIndex(bus), "capRefused");
      return false;
    }
    this.stealSlot(victim);
    return true;
  }

  /** §5.6: a refused voice, to the capture's taps (nothing while no recorder runs). */
  private refused(clip: string, bus: number, reason: "neverFits" | "loadFailed" | "capRefused"): void {
    const profile = this.host.profile();
    if (profile !== NULL_PROFILE_SINK) profile.voiceRefused(clip, this.host.busRef(bus), reason);
  }

  // --- Launch: play now, wait for the data, or fail ---

  /** The voice's clip decides what happens next: play now, wait for the data, or fail. */
  private launch(id: number): void {
    const t = this.t;
    const host = this.host;
    const i = id & 0xffff;
    if (t.genKind[i] !== 0) {
      // ADR 0360: a generator has no data to wait for: it starts at once, mixed or virtual (a silence always virtual).
      const mixed = host.selection.admit(i, host.mixedCap());
      t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
      t.reason[i] = mixed ? VoiceReason.NONE : VoiceReason.VIRTUAL;
      this.sendPlay(id, i, 0);
      return;
    }
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) {
      // B4: AAC while `audio.codecs.aac` is off: never sent to the core, one warning per asset.
      const asset = host.streams.assetOf(t.clip[i]!) ?? "";
      const refused = aacRefusal(asset, host.aac());
      if (refused) {
        host.warnOnce(asset, refused);
        this.refused(asset, t.bus[i]!, "loadFailed"); // §5.6: as the clip's AAC failure
        t.free(id, VoiceReason.FAILED);
        return;
      }
      // W12: a stream after its head clip opens where the head ends (no seek, no fade-in).
      const from = this.streamStart[i]!;
      this.streamStart[i] = 0;
      this.launchStream(id, i, from);
      // A start offset: the stream seeks before its first chunk (or, its rate not known yet, once the worker opened it).
      const offset = this.startOffset[i]!;
      this.startOffset[i] = 0;
      if (offset > 0) this.seek(id, offset);
      return;
    }
    const clip = t.clip[i]!;
    const state = host.clips.state(clip);
    if (state === "ready" && (t.flags2[i]! & VoiceFlag2.REVERSE) !== 0 && host.clips.info(clip)?.format === ClipFormat.AdpcmIma) {
      // ADR 0362: an ADPCM clip's reader moves forward only; a reversed play of it would play the wrong audio.
      const path = host.clips.info(clip)?.path ?? "";
      host.warnOnce(`${path}#reverse-adpcm`, `audio: "${path}" ships compressed (ADPCM, load "compressed"), which the audio core reads forwards only; a reversed clip of it is silent. Set its load mode to decode to play it backwards (ADR 0362).`);
      t.free(id, VoiceReason.FAILED);
      return;
    }
    if (state === "ready") {
      this.applyImportGain(i, clip);
      // A3.1: mixed when there is room under the cap; otherwise virtual, and this frame's selection may promote it.
      const mixed = host.selection.admit(i, host.mixedCap());
      t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
      t.reason[i] = mixed ? VoiceReason.NONE : VoiceReason.VIRTUAL;
      this.sendPlay(id, i, this.offsetFrames(i, clip));
    } else if (state === "failed") {
      this.clipFailed(id, i);
    } else {
      t.state[i] = VoiceState.WAITING_FOR_DATA;
      t.reason[i] = VoiceReason.WAITING_FOR_DATA;
      host.clips.onResident(clip, (info: ClipInfo) => {
        if (!t.isLive(id) || t.state[i] !== VoiceState.WAITING_FOR_DATA) return;
        if (info.state === "ready") this.launch(id);
        else this.clipFailed(id, i);
      });
    }
  }

  /**
   * Slot `i`'s start offset (`PlayRequest.offset`) in frames of its ready clip, taken once: wrapped into the clip for a
   * looping voice, clamped to its end otherwise (the voice then ends at once). A span clip (C14) counts from the span's
   * first frame.
   */
  private offsetFrames(i: number, clip: number): number {
    const offset = this.startOffset[i]!;
    this.startOffset[i] = 0;
    if (!(offset > 0)) return 0;
    const info = this.host.clips.info(clip);
    if (!info || !(info.sampleRate > 0)) return 0;
    let frame = Math.round(offset * info.sampleRate);
    // ADR 0362: a reversed voice counts its positions from the clip's end (it starts at source second `offset`).
    if ((this.t.flags2[i]! & VoiceFlag2.REVERSE) !== 0 && info.frames > 0) frame = Math.max(0, info.frames - frame);
    if (info.frames <= 0) return frame;
    return (this.t.flags[i]! & VoiceFlag.LOOP) !== 0 ? frame % info.frames : Math.min(frame, info.frames);
  }

  /**
   * B5 (§2.4): a FuMa clip's import gain is known only once its decode reported, so a voice played before that carries a
   * volume without it (up to 3 dB too quiet). When the clip is ready, fold the gain in (the volume the caller gave
   * already holds `gainApplied[i]`). Only an ambisonic clip voice has a gain other than 1.
   */
  private applyImportGain(i: number, clip: number): void {
    const t = this.t;
    if ((t.flags2[i]! & VoiceFlag2.AMBISONIC) === 0) return;
    const path = this.host.clips.info(clip)?.path;
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
    const t = this.t;
    const host = this.host;
    const info = host.clips.info(t.clip[i]!);
    if (info?.failure !== "streamInstead") {
      // §5.6: a clip over the memory ceiling or a bad span can never fit (neverFits); a fetch, decode or grow failure is loadFailed.
      if (host.profile() !== NULL_PROFILE_SINK) {
        const never = info?.failure === "refusedCeiling" || info?.failure === "refusedSpan";
        this.refused(info?.path ?? "", t.bus[i]!, never ? "neverFits" : "loadFailed");
      }
      t.free(id, VoiceReason.FAILED);
      return;
    }
    host.clips.release(t.clip[i]!);
    const stream = host.streams.allocate();
    t.clip[i] = stream;
    t.flags[i] = t.flags[i]! | VoiceFlag.STREAM | VoiceFlag.WANTS_PLAYHEAD;
    host.streams.register(stream, id, info.path, (t.flags[i]! & VoiceFlag.LOOP) !== 0);
    this.launch(id);
  }

  /**
   * B3: a stream voice starts on the core at once, mixed or virtual like a clip voice, and waits there for its data
   * ("waitingForData"); the worker is asked to open the stream from `startFrame`.
   */
  private launchStream(id: number, i: number, startFrame = 0): void {
    const t = this.t;
    const host = this.host;
    const mixed = host.selection.admit(i, host.mixedCap());
    t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
    t.reason[i] = VoiceReason.WAITING_FOR_DATA;
    this.sendPlay(id, i, startFrame);
    // ADR 0166 (Q2): a music member's stream is already open and primed (musicOps, P1).
    if (!host.musicOps.ownsVoice(id)) host.streams.open(t.clip[i]!, startFrame);
  }

  /**
   * B3, architecture §7: a stream failed (the decoder's error, a failed fetch, no ring free): its voice stops with a
   * 50 ms fade and one warning names the asset. B4: a file the decoder can't read warns once per asset, naming its
   * format and the supported list; the voice reads `reason` "failed" from now on, and once it has ended.
   */
  streamFailed(id: number, asset: string, message: string, code?: number): void {
    const unsupported = unsupportedFormat(asset, this.host.aac(), code, message);
    if (unsupported) this.host.warnOnce(asset, unsupported);
    else console.warn(`[myco] audio: streaming "${asset}" failed: ${message}`);
    const t = this.t;
    if (!t.isLive(id)) return;
    const s = t.state[id & 0xffff];
    if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return;
    t.reason[id & 0xffff] = VoiceReason.FAILED;
    t.requestStop(id, STREAM_ERROR_FADE_SECONDS);
  }

  /**
   * B3, a hard rebuild (`Replayer.restore` hands over the live stream voices): each reopens on the new core with a new
   * stream id, stamped `at` (`reopenStamp`) from where its own position reaches there (FU2: its STATUS playhead run on at
   * its rate, wrapped for loops; a finished one is dropped). Music group members are skipped (their groups reopen as
   * groups, `musicOps.reopenGroups`, which the caller runs after).
   */
  reopenStreams(ids: readonly number[], at: number): void {
    const t = this.t;
    const streams = this.host.streams;
    for (const id of ids) {
      if (!t.isLive(id) || this.host.musicOps.ownsVoice(id)) continue;
      const i = id & 0xffff;
      const info = streams.clipInfo(t.clip[i]!);
      const frames = info?.frames ?? 0;
      // E4.4: the file frame by the stream's map: inside its loop region while it loops; a released (or plain) stream past its end is dropped.
      const pos = Math.max(0, Math.floor(streams.resumeFrame(t.clip[i]!, id, at)));
      if (!streams.looping(t.clip[i]!) && frames > 0 && pos >= frames) {
        t.free(id, VoiceReason.NONE);
        continue;
      }
      t.clip[i] = streams.rekey(t.clip[i]!);
      t.startFrame[i] = at;
      this.launchStream(id, i, pos);
    }
  }

  /** The voice's PLAY: the effective dry gain and pitch, direction, lpHz, score and flags, stamped at its start frame. */
  private sendPlay(id: number, i: number, startOffsetFrames = 0): void {
    const t = this.t;
    const host = this.host;
    // B5: a sidecar on a 1-2 channel clip is ignored (the registry warned): the voice isn't ambisonic.
    if ((t.flags2[i]! & VoiceFlag2.AMBISONIC) !== 0 && (t.flags[i]! & VoiceFlag.STREAM) === 0 && (host.clips.info(t.clip[i]!)?.channels ?? 3) <= 2) t.flags2[i] = t.flags2[i]! & ~VoiceFlag2.AMBISONIC;
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
      (t.flags2[i]! & VoiceFlag2.AMBISONIC ? PLAY_FLAGS_AMBISONIC : 0) |
      ((t.flags2[i]! & VoiceFlag2.REVERSE) !== 0 && (f & VoiceFlag.STREAM) === 0 ? PLAY_FLAGS_REVERSE : 0);
    a.startOffsetFrames = startOffsetFrames;
    // ADR 0162 (K4): the dry gain with occlusion, the pitch with Doppler, and main's lpHz (`voiceFx`), all M2's values at the defaults.
    a.gain = this.dryGain(i);
    a.pitch = this.sentPitch(i);
    a.dirX = t.dirX[i]!;
    a.dirY = t.dirY[i]!;
    a.dirZ = t.dirZ[i]!;
    a.lpHz = t.lpHz[i]!;
    a.score = t.audibility[i]!;
    host.selection.noteScoreSent(i, a.score);
    // ADR 0166 (Q2): a group member's PLAY carries its gate; every other PLAY clears it (`a` is reused; P1).
    host.musicOps.decoratePlay(id, i, a);
    const start = t.startFrame[i]!;
    const clockMap = host.clockMap;
    // A3.2: stamped at its frame while that is ahead of F_now; past (or asap) goes asap (§1 `at`, `lookahead.ts`).
    const stamp = clockMap.stampFor(start);
    host.writer.play(a, stamp);
    // ADR 0360: a generator's GEN with every parameter and its (non-zero) seed, at its PLAY's frame, right behind it.
    const genParams = t.genKind[i] !== 0 ? t.genParams[i] : null;
    if (genParams) host.writer.gen(id, stamp, GEN_MASK_ALL, genParams, t.genSeed[i]!, 0);
    this.flatPlayId[i] =(a.flags & (PLAY_FLAGS_SPATIAL | PLAY_FLAGS_AMBISONIC)) === 0 ? id : 0;
    host.playheads.start(i, stamp ?? clockMap.framesNow(), a.startOffsetFrames);
    // ADR 0158: the voice's bindings and loop, right behind its PLAY.
    host.automation.onPlaySent(id, i, stamp);
    // ADR 0362 (ABI 6.1): its Amp envelope, on arrival like the bindings, stamped as its PLAY to stay behind it.
    const env = this.envelopes[i];
    if (env) {
      this.envelopeFrom[i] = stamp ?? clockMap.framesNow();
      host.writer.ampEnvelope(id, envelopeFrames(env, clockMap.sampleRate), env.offset * clockMap.sampleRate, stamp);
    }
    // ADR 0345 levels (ABI 4.9): into its playlist level's submix (applies on arrival, like the bindings), stamped as
    // its PLAY so the frame-ordered batch keeps it after the PLAY (which would otherwise clear it).
    if (t.submix[i]! > 0) host.writer.route(id, t.submix[i]! - 1, stamp);
    // ADR 0162 (C3): its SET_VOICE_FX at the same frame, when mixed and non-default.
    host.voiceFx.onPlay(i, stamp);
    // A3.7: paused before it reached the core (locked, or its clip loading): it waits there, paused, until resumed. At
    // its PLAY's frame (ADR 0362 §1): the batch goes in frame order, and an asap record would reach the core before a
    // stamped PLAY does.
    if (f & VoiceFlag.PAUSED) host.writer.setPaused(id, true, stamp);
    if (start > 0) t.startFrame[i] = 0;
    this.spatialDirty[i] = 0;
  }

  /**
   * ADR 0362: slot `i`'s Amp envelope for a hard rebuild's REPLAY applying at context frame `frame`: its frames and the
   * envelope frame it has reached there (its offset plus the frames since its PLAY), or null without one.
   */
  replayEnvelope(i: number, frame: number): { readonly env: FramesEnvelope; readonly offsetFrames: number } | null {
    const env = this.envelopes[i];
    if (!env) return null;
    const rate = this.host.clockMap.sampleRate;
    return { env: envelopeFrames(env, rate), offsetFrames: env.offset * rate + Math.max(0, frame - this.envelopeFrom[i]!) };
  }

  // --- The setters (by id; each does nothing for a stale id) ---

  /**
   * ADR 0360: generator voice `id`'s parameters (by catalogue index) change, a hot reload: kept for a REPLAY, and on the
   * core a GEN with just those bits, the smooth ones gliding over `seconds`. Not a generator: nothing.
   */
  setGeneratorParams(id: number, params: ReadonlyMap<number, number>, seconds: number): void {
    const i = this.slot(id);
    const values = i >= 0 ? this.t.genParams[i] : null;
    if (!values) return;
    let mask = 0;
    for (const [k, v] of params) {
      if (!Number.isInteger(k) || k < 0 || k >= values.length || !Number.isFinite(v)) continue;
      values[k] = v;
      mask |= 1 << k;
    }
    if (mask === 0 || !this.onCore(i)) return;
    const rate = this.host.clockMap.sampleRate;
    this.host.writer.gen(id, undefined, mask >>> 0, values, 0, Math.max(0, seconds) * (rate > 0 ? rate : 0));
  }

  setVolume(id: number, v: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(v)) return;
    this.t.volume[i] = Math.max(0, v);
    this.refreshGain(i);
    this.sendGain(id, i);
  }

  /** B4, ADR 0162: a FuMa stream's headroom scale multiplies its volume, as a FuMa clip's import volume. */
  scaleVolume(id: number, gain: number): void {
    const i = this.slot(id);
    if (i >= 0) this.setVolume(id, this.t.volume[i]! * gain);
  }

  setPitch(id: number, rate: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(rate)) return;
    this.t.pitch[i] = clamp(rate, MIN_PITCH, MAX_PITCH);
    if (this.onCore(i)) this.host.playheads.retime(i, this.host.clockMap.framesNow());
    if (this.onCore(i)) this.host.writer.setParams(id, SET_PARAMS_MASK_PITCH, 0, this.sentPitch(i), 0, 0, 0, 0, this.host.clockMap.rampFrames());
  }

  setPriority(id: number, priority: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(priority)) return;
    this.t.priority[i] = clamp(Math.round(priority), 0, 255);
    this.refreshGain(i);
  }

  setAttenuation(id: number, a: Attenuation): void {
    const i = this.slot(id);
    if (i < 0) return;
    this.applyAttenuation(i, a);
    this.spatialDirty[i] = 1;
  }

  setPosition(id: number, p: Vec3Like): void {
    const i = this.slot(id);
    if (i < 0) return;
    // F-24: the core reads `spatial` from PLAY only (SET_PARAMS carries the panner kind, not the flag), so a voice that
    // started flat stays flat there. Marking it spatial here would have main pan, attenuate and report a voice the core
    // plays flat; it's refused, with one warning per voice. (A source that turns `spatial` on while playing is spatial
    // from its next play.)
    if (this.flatPlayId[i] === id) {
      this.warnFlatPosition(id, i);
      return;
    }
    this.applyPosition(i, p);
    this.spatialDirty[i] = 1;
  }

  setBus(id: number, bus: string): void {
    const i = this.slot(id);
    if (i < 0) return;
    const next = this.busIndex(bus);
    if (this.t.bus[i] === next) return;
    this.moveBus(i, next);
    if (!this.onCore(i)) return;
    // G7a (§4.7: a sound's bus is structural): a sounding voice dips alone (`StructuralDip.dipVoice`); one whose
    // stamped start is still ahead of F_now changes bus at once, at that start frame (it is not heard before it).
    const host = this.host;
    const start = host.playheads.anchorFrame[i]!;
    const ahead = host.clockMap.stampFor(start);
    if (ahead === undefined && host.dip.dipVoice(id, next, host.writer) >= 0) return;
    host.writer.setParams(id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, next, 0, ahead);
  }

  /**
   * Slot `i` moves to bus `next` on main: the table's bus and its per-bus counts, the mixer's counts and presence (no
   * record; `setBus` and the per-voice dip, `busIndex.moveVoices`, send what the core needs).
   */
  moveBus(i: number, next: number): void {
    const t = this.t;
    const host = this.host;
    const old = t.bus[i]!;
    if (old === next) return;
    t.bus[i] = next;
    if (t.busLive[old]! > 0) t.busLive[old]!--;
    t.busLive[next]!++;
    const names = host.busNames();
    host.mixer.voiceEnded(names[old] ?? "");
    host.mixer.voiceStarted(names[next] ?? "");
    host.presence.voiceStopped(old, i);
    host.presence.voiceStarted(next, i);
  }

  /**
   * A3.7: pause or resume voice `id`, as soon as possible, or (ADR 0362 §1) at heard time `at` (`Audio.time` seconds), so
   * every voice of a playback holds at the same frame and continues at the same frame. A stamped pause holds the voice
   * exactly at `at`: a mixed voice's SET_PAUSED goes the core's 5 ms fade earlier (it renders that fade, then holds), a
   * virtual one's at `at`. A stamped resume continues it from there at `at`, as a virtual voice keeping time; main's
   * selection promotes it once the mirror takes the resume (the first frame whose commands arrive after `at`), so the
   * sound continues sample-exact from where it held and is heard from that promote's 5 ms fade-in. A past `at`, or a
   * voice not on the core yet, goes as soon as possible (as without `at`).
   */
  setPaused(id: number, paused: boolean, at?: number): void {
    const i = this.slot(id);
    if (i < 0) return;
    const t = this.t;
    const host = this.host;
    const clock = host.clockMap;
    this.dropFlip(i);
    // A stamped start still ahead: its PLAY may be in this frame's batch, which goes in frame order, so nothing for the
    // voice is stamped before it (it would reach the core before the voice exists there). As `setBus` does.
    const playAt = this.onCore(i) ? clock.stampFor(host.playheads.anchorFrame[i]!) : undefined;
    const hold = at !== undefined && Number.isFinite(at) && this.onCore(i) ? clock.stampFor(clock.frameOfTime(at)) : undefined;
    if (hold === undefined) {
      t.flags[i] = paused ? t.flags[i]! | VoiceFlag.PAUSED : t.flags[i]! & ~VoiceFlag.PAUSED;
      if (this.onCore(i)) host.playheads.retime(i, clock.framesNow());
      if (this.onCore(i)) host.writer.setPaused(id, paused, playAt);
      return;
    }
    let frame = hold;
    if (paused && t.state[i] === VoiceState.PLAYING) frame = clock.stampFor(hold - Math.round(MIX_FADE_SECONDS * clock.sampleRate)) ?? hold;
    if (playAt !== undefined && playAt > frame) frame = playAt;
    host.writer.setPaused(id, paused, frame);
    this.flipTo[i] = paused ? FLIP_PAUSE : FLIP_RESUME;
    this.flipAt[i] = Math.max(hold, frame);
    this.flips++;
  }

  /**
   * ADR 0362 §1, once per frame before selection: the mirror takes each stamped pause or resume whose frame the core has
   * reached by the time this frame's commands arrive (flag, playhead anchored at the hold or resume frame), and sends it
   * again as soon as possible, a no-op for the core unless a rebuild dropped the stamped one meanwhile.
   */
  private landFlips(): void {
    const now = this.host.clockMap.framesNow();
    const t = this.t;
    for (let i = 0; i < this.flipTo.length && this.flips > 0; i++) {
      const to = this.flipTo[i]!;
      if (to === FLIP_NONE || this.flipAt[i]! > now) continue;
      const paused = to === FLIP_PAUSE;
      const frame = this.flipAt[i]!;
      this.dropFlip(i);
      t.flags[i] = paused ? t.flags[i]! | VoiceFlag.PAUSED : t.flags[i]! & ~VoiceFlag.PAUSED;
      if (!this.onCore(i)) continue;
      this.host.playheads.retime(i, frame);
      this.host.writer.setPaused(idAt(t, i), paused);
    }
  }

  private dropFlip(i: number): void {
    if (this.flipTo[i] === FLIP_NONE) return;
    this.flipTo[i] = FLIP_NONE;
    this.flips--;
  }

  /**
   * B3b: moves voice `id` to `seconds` of its sound. A stream voice restarts at the new epoch (`streams.ts`: the old
   * audio fades out over 5 ms in the core, the ring is flushed, the new audio fades in once decoded, and the voice reads
   * "waitingForData" meanwhile); a clip voice fades out, jumps and fades in. A loop wraps the time into the sound;
   * otherwise it clamps to the end (the voice then ends). A voice not on the core yet (its clip still loading, or
   * locked) ignores it.
   */
  seek(id: number, seconds: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(seconds)) return;
    const t = this.t;
    const host = this.host;
    const time = Math.max(0, seconds);
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) {
      const frame = host.streams.seek(t.clip[i]!, time);
      if (frame !== null) this.reanchorSeek(id, frame);
      return;
    }
    if (!this.onCore(i) || t.genKind[i] !== 0) return; // ADR 0360: a generator has no position to seek to
    const info = host.clips.info(t.clip[i]!);
    if (!info || info.sampleRate <= 0) return;
    let frame = Math.round(time * info.sampleRate);
    if (info.frames > 0) frame = (t.flags[i]! & VoiceFlag.LOOP) !== 0 ? frame % info.frames : Math.min(frame, info.frames);
    host.writer.seek(id, frame, 0);
    this.reanchorSeek(id, frame);
  }

  /** B3b: the playhead tracker follows a seek: the voice is at `frame` from now on. */
  reanchorSeek(id: number, frame: number): void {
    const i = this.slot(id);
    if (i >= 0) this.host.playheads.start(i, this.host.clockMap.framesNow(), frame);
  }

  /** E4.4: where slot `i`'s (unwrapped) playhead `pos` is in its sound: a stream by its map, a clip in its SET_LOOP region (or the whole clip for a plain loop). */
  wrapPlayhead(i: number, pos: number): number {
    const t = this.t;
    const host = this.host;
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) return host.streams.fileFrame(t.clip[i]!, pos);
    const frames = host.clips.info(t.clip[i]!)?.frames ?? 0;
    const region = host.automation.loopOf(i);
    if (region) return region.looping ? wrapPosition(pos, region.start, region.end, frames) : pos;
    return (t.flags[i]! & VoiceFlag.LOOP) !== 0 && frames > 0 ? pos % frames : pos;
  }

  /** K0 `AudioVoice.setOcclusion` (the spatial view's `setOcclusion` comes to `setOcclusionAt`). */
  setOcclusion(id: number, gain: number, lpHz: number): void {
    const i = this.slot(id);
    if (i >= 0) this.setOcclusionAt(i, gain, lpHz);
  }

  /**
   * Slot `i`'s smoothed occlusion (D2a hands it over through the view): `occGain` for selection and the dry gain (sent to
   * a mixed voice when it moved), the cutoff as the voice's occlusion low-pass (`voiceFx`, sent at the fx stage).
   */
  setOcclusionAt(i: number, gain: number, lpHz: number): void {
    const t = this.t;
    if (t.state[i] === VoiceState.FREE || !Number.isFinite(gain)) return;
    const old = t.occGain[i]!;
    t.occGain[i] = clamp(gain, 0, 1);
    this.host.voiceFx.setLowpass(i, LowpassBy.OCCLUSION, lpHz);
    if (Math.abs(t.occGain[i]! - old) > GAIN_EPSILON) this.sendGain(idAt(t, i), i);
  }

  /** K0 `AudioVoice.setDopplerRate` (the spatial view's `setDopplerRate` comes to `setDopplerRateAt`). */
  setDopplerRate(id: number, factor: number): void {
    const i = this.slot(id);
    if (i >= 0) this.setDopplerRateAt(i, factor);
  }

  /** Slot `i`'s Doppler factor (D3 hands it over through the view): folded into the pitch sent; the playhead estimate follows. */
  setDopplerRateAt(i: number, factor: number): void {
    const t = this.t;
    if (t.state[i] === VoiceState.FREE || !Number.isFinite(factor) || factor <= 0) return;
    if (t.dopplerFactor[i] === factor) return;
    t.dopplerFactor[i] = factor;
    if (!this.onCore(i)) return;
    const clockMap = this.host.clockMap;
    this.host.playheads.retime(i, clockMap.framesNow());
    this.host.writer.setParams(idAt(t, i), SET_PARAMS_MASK_PITCH, 0, this.sentPitch(i), 0, 0, 0, 0, clockMap.rampFrames());
  }

  /** K0 `AudioVoice.setVelocity`: the source's velocity from physics (Doppler, D3). */
  setVelocity(id: number, v: Vec3Like | null): void {
    const i = this.slot(id);
    if (i >= 0) this.host.doppler.setVelocity(i, v);
  }

  /** §1.2 Play edits on a playing voice (`VoiceSpatialOptions`): the table's options (the passes read them next frame). */
  setSpatialOptions(id: number, o: VoiceSpatialOptions): void {
    const i = this.slot(id);
    if (i >= 0) this.applySpatialOptions(i, o, false);
  }

  /**
   * F-9b: slot `i`'s music stem level becomes `level` at core frame `at` (undefined: asap; `nowFrame` is where asap
   * records land), ramping over `rampFrames` with `shape` (`musicOps.paramsShaped` sends the ramp itself, over
   * `dryGainBeforeStem`). The dry-gain writes multiply it in from the stamp, and audibility follows (R3a).
   */
  setStemLevel(i: number, level: number, at: number | undefined, nowFrame: number, rampFrames: number, shape: number): void {
    this.t.setStemLevel(i, level, at, nowFrame, rampFrames, shape);
  }

  /** ADR 0166 §4.2 (Q2): a shaped, stamped fade of voice `id`'s `fade` ramp (`musicOps.fadeShaped`, P1). */
  fadeShaped(id: number, f: ShapedFade): void {
    if (this.t.isLive(id)) this.host.musicOps.fadeShaped(id, f);
  }

  /** ADR 0166 (G-1), F-9b: a stamped gain (a stem's level) and/or low-pass ramp with a law (`musicOps.paramsShaped`). */
  paramsShaped(id: number, r: { gain?: number; lowpassHz?: number; seconds: number; law?: FadeLaw; at?: number }): void {
    if (this.t.isLive(id)) this.host.musicOps.paramsShaped(id, r);
  }

  // --- Reads by id (the handle's getters) ---

  /** ADR 0162 §1.1 `AudioHandle.panner`: voice `id`'s panner from the main-thread tables; null once it is gone. */
  pannerOf(id: number): AudioPanner | null {
    const i = this.slot(id);
    if (i < 0) return null;
    const t = this.t;
    return pannerName(this.host.panners.kindOf(i), (t.flags[i]! & VoiceFlag.SPATIAL) !== 0, (t.flags2[i]! & VoiceFlag2.AMBISONIC) !== 0);
  }

  /** ADR 0162 §1.1 `AudioHandle.occlusion`: voice `id`'s smoothed dry occlusion gain (1 open, or the voice is gone). */
  occlusionOf(id: number): number {
    const i = this.slot(id);
    return i < 0 ? 1 : this.t.occGain[i]!;
  }

  /** D3 `AudioSource.velocity`: voice `id`'s velocity (the estimate, or `setVelocity`'s value) into `out`; false when the voice is gone. */
  velocityOf(id: number, out: { x: number; y: number; z: number }): boolean {
    const i = this.slot(id);
    if (i < 0) return false;
    const d = this.host.doppler;
    out.x = d.velX[i]!;
    out.y = d.velY[i]!;
    out.z = d.velZ[i]!;
    return true;
  }

  // --- The listener and the frame's voice passes ---

  /** The listener pose the distance gains and directions are computed from; a change re-derives every spatial voice next frame. */
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

  /** ADR 0347: slot `i`'s distance from the listener, world units (0 for a voice that isn't positioned). */
  distanceOf(i: number): number {
    const t = this.t;
    if ((t.flags[i]! & VoiceFlag.SPATIAL) === 0) return 0;
    const p = this.listenerPos;
    return Math.hypot(t.posX[i]! - p[0], t.posY[i]! - p[1], t.posZ[i]! - p[2]);
  }

  /** Spatial voices whose source or the listener moved: new gain and direction when they changed beyond epsilon. */
  moveSpatial(): void {
    if (this.spatialVoices === 0) return;
    const t = this.t;
    const all = this.listenerDirty;
    this.listenerDirty = false;
    const ramp = this.host.clockMap.rampFrames();
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
        const id = idAt(t, i);
        this.host.writer.setParams(id, SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, this.dryGain(i), 0, t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, 0, ramp);
        if (t.stemCount[i] !== 0) this.resendStemLevels(id, i);
      } else {
        t.gain[i] = g;
        t.dirX[i] = x;
        t.dirY[i] = y;
        t.dirZ[i] = z;
      }
    }
  }

  /** A3.1: the frame's selection over every logical voice, at the current mixed cap. */
  select(): void {
    if (this.flips > 0) this.landFlips();
    if (this.t.liveCount === 0) return;
    this.host.selection.run(this.host.mixedCap(), this.selectionSink);
  }

  // --- What gets sent ---

  /** `gain` = volume times the distance gain (spatial), and the direction for a spatial voice; audibility from both and priority. */
  private refreshGain(i: number): void {
    const t = this.t;
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
    this.host.selection.audibilityOf(i);
  }

  private sendGain(id: number, i: number): void {
    const t = this.t;
    // Only a mixed voice is heard; a virtual one gets its gain with SET_MIXED when it is promoted (A3.1).
    if (t.state[i] !== VoiceState.PLAYING) return;
    this.host.writer.setParams(id, SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, this.dryGain(i), 0, t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, 0, this.host.clockMap.rampFrames());
    if (t.stemCount[i] !== 0) this.resendStemLevels(id, i);
  }

  /** SET_MIXED for slot `i` (selection's change); a promote carries the voice's current gain, direction and `lpHz`. */
  private sendMixed(i: number, mixed: boolean): void {
    const t = this.t;
    const id = idAt(t, i);
    if (mixed) this.spatialDirty[i] = 0;
    this.host.writer.setMixed(id, mixed, this.dryGain(i), t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, t.lpHz[i]!);
    if (mixed && t.stemCount[i] !== 0) this.resendStemLevels(id, i);
    // ADR 0162 (C20): a promote re-sends the voice's send, high-pass, yaw and aux targets with its SET_MIXED.
    if (mixed) this.host.voiceFx.onPromote(i);
    else this.host.voiceFx.onDemote(i);
  }

  /** A3.3: selection re-sends slot `i`'s score (its audibility moved), the core's key for its own lowest-score demote. */
  private sendScore(i: number, score: number): void {
    this.host.writer.setScore(idAt(this.t, i), score);
  }

  /** Selection (or the ambisonic cap) stole slot `i`: free it as STOLEN; `onFree` stops it on the core. */
  private stealSlot(i: number): void {
    const t = this.t;
    t.stolenCount++;
    t.free(idAt(t, i), VoiceReason.STOLEN);
  }

  // --- F-9b, F-12: a music stem's re-sends ---

  /**
   * F-9b: after a dry-gain write to slot `i` (which carries `stemDry`, the level before its pending changes), the stem's
   * pending level changes due within a lookahead go again, stamped, behind it. The core still holds the originals, which
   * land after the write; but one due that close may land before the write arrives (main's `framesNow` is an estimate),
   * and the write would then put the old level back. A re-sent change whose frame has passed applies at once. Changes
   * further out need nothing. Each multiplies the dry gain without the stem level, like `musicOps.paramsShaped`.
   */
  private resendStemLevels(id: number, i: number): void {
    const t = this.t;
    const n = t.stemCount[i]!;
    if (n === 0) return;
    const clockMap = this.host.clockMap;
    const until = clockMap.framesNow() + clockMap.lookaheadFrames();
    const dry = this.dryGainBeforeStem(i);
    const base = i * MAX_STEM_PENDING;
    for (let k = 0; k < n; k++) {
      const e = base + k;
      if (t.stemAt[e]! > until) break;
      this.host.writer.setParams(id, SET_PARAMS_MASK_GAIN, t.stemNext[e]! * dry, 0, 0, 0, 0, 0, t.stemRamp[e]!, 0, t.stemShape[e]!, t.stemAt[e]!);
    }
    // F-12: the changes further out still carry the old dry gain on the core; each goes again once within a lookahead.
    const last = t.stemAt[base + n - 1]!;
    if (last > until) {
      if (this.stemStaleTo[i] === 0) this.stemStaleCount++;
      this.stemStaleAfter[i] = until;
      this.stemStaleTo[i] = Math.max(this.stemStaleTo[i]!, last);
    }
  }

  /**
   * F-12: once a frame, the stale stem changes (see `stemStaleTo`) now within a lookahead go again, stamped as before,
   * carrying the dry gain as it is now, so a volume or occlusion change made after the original send wins when the
   * stamp lands. Each goes once; a virtual voice sends none (its promote's SET_MIXED carries the level that landed).
   */
  resendStaleStems(): void {
    if (this.stemStaleCount === 0) return;
    const t = this.t;
    const host = this.host;
    if (host.holdStemResends()) return;
    const until = host.clockMap.framesNow() + host.clockMap.lookaheadFrames();
    for (let i = 0; i < t.capacity; i++) {
      const to = this.stemStaleTo[i]!;
      if (to === 0) continue;
      const n = t.stemCount[i]!;
      if (t.state[i] === VoiceState.PLAYING && n > 0) {
        const after = this.stemStaleAfter[i]!;
        const id = idAt(t, i);
        const dry = this.dryGainBeforeStem(i);
        const base = i * MAX_STEM_PENDING;
        for (let k = 0; k < n; k++) {
          const e = base + k;
          const at = t.stemAt[e]!;
          if (at > until || at > to) break;
          if (at <= after) continue;
          host.writer.setParams(id, SET_PARAMS_MASK_GAIN, t.stemNext[e]! * dry, 0, 0, 0, 0, 0, t.stemRamp[e]!, 0, t.stemShape[e]!, at);
        }
      }
      if (until >= to || n === 0 || t.state[i] === VoiceState.FREE) {
        this.stemStaleTo[i] = 0;
        this.stemStaleCount--;
      } else this.stemStaleAfter[i] = until;
    }
  }

  // --- Lifecycle hooks (the backend's lifecycle calls them) ---

  /** A hard rebuild began: F-12's stale stem changes are forgotten (the replay sends every voice's gain again, and the pending frames change meaning). */
  beginRecovery(): void {
    if (this.stemStaleCount === 0) return;
    this.stemStaleTo.fill(0);
    this.stemStaleCount = 0;
  }

  /** Recovery gave up (the host is Failed and silent for the session): the queue empties and every voice ends with reason "failed". */
  recoveryFailed(): void {
    this.lockedQueue.clear();
    const t = this.t;
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] !== VoiceState.FREE) t.free(idAt(t, i), VoiceReason.FAILED);
    }
  }

  /** The backend is disposed: queued plays go. */
  dispose(): void {
    this.lockedQueue.clear();
  }

  /** The bus tree was rebuilt: the last-bus shortcut forgets its index. */
  busesReset(): void {
    this.lastBusName = null;
  }

  /**
   * The table freed voice `id` (its `onFree`, before the slot is cleared): stop it on the core when freed while still
   * there (a steal), close its stream or drop its clip, and forget its per-slot state in every part.
   */
  onFree(id: number, bus: number): void {
    const i = id & 0xffff;
    const t = this.t;
    const host = this.host;
    // Freed while still on the core (a steal: allocation's, or selection's past a bus's `maxVoices`): stop it there,
    // or it would sound on until a PLAY reuses the slot (the new voice may be waiting for its clip). The state is
    // still the old one here; natural ends (ENDING) are already gone from the core.
    const s = t.state[i]!;
    if (s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING) host.writer.stop(id, STEAL_FADE_SECONDS);
    // B3: a stream voice's stream closes on the worker (the worklet frees its ring); a clip voice drops its reference.
    // ADR 0166 (Q2): a music member's stream is musicOps's to close (P1).
    const member = host.musicOps.ownsVoice(id);
    if (member) host.musicOps.memberFreed(id, i);
    if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) {
      if (!member) host.streams.close(t.clip[i]!);
    } else if (t.genKind[i] === 0) host.clips.release(t.clip[i]!); // ADR 0360: a generator holds no clip
    this.dropFlip(i);
    host.panners.forget(i);
    host.automation.forget(i);
    // ADR 0162 (K4): the M3 per-slot state goes with the voice.
    host.voiceFx.forget(i);
    host.occlusion.forget(i);
    host.doppler.forget(i);
    host.zones.forget(i);
    host.mixer.voiceEnded(host.busNames()[bus] ?? "");
    host.presence.voiceStopped(bus, i);
    if ((t.flags[i]! & VoiceFlag.SPATIAL) !== 0) this.spatialVoices--;
    t.flags[i] = 0;
    this.spatialDirty[i] = 0;
  }

  // --- Internals ---

  private slot(id: number): number {
    return this.t.isLive(id) ? id & 0xffff : -1;
  }

  private onCore(i: number): boolean {
    const s = this.t.state[i]!;
    return s === VoiceState.PLAYING || s === VoiceState.VIRTUAL;
  }

  private busIndex(name: string): number {
    // M2 F1: plays mostly name the bus the last one did (the same string), so that one skips the map.
    if (name === this.lastBusName) return this.lastBusIndex;
    const index = this.host.busIndexByName().get(name) ?? 0;
    this.lastBusName = name;
    this.lastBusIndex = index;
    return index;
  }

  private warnFlatPosition(id: number, i: number): void {
    const t = this.t;
    const host = this.host;
    const asset = ((t.flags[i]! & VoiceFlag.STREAM) !== 0 ? host.streams.assetOf(t.clip[i]!) : host.clips.info(t.clip[i]!)?.path) ?? "";
    const owner = this.owners[i];
    const who = owner ? `"${asset}" on "${owner}"` : `"${asset}"`;
    host.warnOnce(`flatPosition:${id}`, `[myco] audio: ${who} started flat (non-spatial), so its position is ignored until it plays again; a voice can't turn spatial while it plays (play it with a position to make it spatial)`);
  }

  private applyAttenuation(i: number, a: Attenuation): void {
    const t = this.t;
    t.minDist[i] = a.minDistance;
    t.maxDist[i] = a.maxDistance;
    t.rolloff[i] = a.rolloff === "linear" ? VoiceRolloff.LINEAR : a.rolloff === "exponential" ? VoiceRolloff.EXPONENTIAL : VoiceRolloff.INVERSE;
  }

  private applyPosition(i: number, p: Vec3Like): void {
    const t = this.t;
    t.posX[i] = p.x;
    t.posY[i] = p.y;
    t.posZ[i] = p.z;
    if ((t.flags[i]! & VoiceFlag.SPATIAL) === 0) {
      t.flags[i]! |= VoiceFlag.SPATIAL;
      this.spatialVoices++;
    }
  }

  /** ADR 0162 (K4): a new voice's M3 request fields (K0's `PlayRequest` members) into the table and the fx staging. */
  private applyM3Request(i: number, req: PlayRequest): void {
    const t = this.t;
    const fx = this.host.voiceFx;
    t.flags2[i] = req.ambisonic === true ? VoiceFlag2.AMBISONIC : 0;
    if (req.ambisonic === true) this.host.listener.noteAmbisonicPlay(); // B5: LISTENER goes with the next frame even if the rotation is unchanged (C4)
    this.applySpatialOptions(i, req, true);
    const f = req.filter;
    if (f) {
      if (f.lowpass !== undefined) fx.setLowpass(i, LowpassBy.EVENT, f.lowpass);
      if (f.highpass !== undefined) fx.setHighpass(i, f.highpass);
    }
    if (req.aux) {
      const bus = this.host.busIndexByName().get(req.aux.bus);
      if (bus !== undefined) {
        fx.setAux(i, bus, req.aux.level);
        t.flags2[i]! |= VoiceFlag2.AUX;
      }
    }
  }

  /**
   * §1.2 options at play (`initial`: omitted fields take K0's defaults: occlusion on, Doppler 0, send 1, the default
   * curve, yaw 0, spread 0, no forced bed) or as a Play edit (omitted fields are kept). Callers clamp; this clamps again.
   */
  private applySpatialOptions(i: number, o: VoiceSpatialOptions, initial: boolean): void {
    const t = this.t;
    let f2 = t.flags2[i]!;
    // The bits say what the voice asks for; the view adds whether it is positioned (a source's position comes after its play).
    if (initial || o.occlusion !== undefined) f2 = (o.occlusion ?? true) ? f2 | VoiceFlag2.OCCLUSION : f2 & ~VoiceFlag2.OCCLUSION;
    if (o.dopplerLevel !== undefined && Number.isFinite(o.dopplerLevel)) t.dopplerLevel[i] = clamp(o.dopplerLevel, 0, 5);
    if (o.reverbSend !== undefined && Number.isFinite(o.reverbSend)) t.reverbSend[i] = clamp(o.reverbSend, 0, 2);
    if (o.reverbSendCurve !== undefined) t.sendCurve[i] = this.host.sendCurves.intern(o.reverbSendCurve);
    if (o.yaw !== undefined && Number.isFinite(o.yaw)) {
      // The engine's yaw follows the left-hand rule (ADR 0164: positive turns right, seen from above clockwise); the
      // native ambisonic code is right-handed (positive turns left), so the sign flips here, at the boundary.
      t.yaw[i] = 0 - (clamp(o.yaw, -180, 180) * Math.PI) / 180; // 0 - x: a yaw of 0 stays +0
      if ((f2 & VoiceFlag2.AMBISONIC) !== 0) this.host.voiceFx.setYaw(i, t.yaw[i]!);
    }
    if (o.spread !== undefined) this.host.voiceFx.setSpread(i, Number.isFinite(o.spread) ? clamp(o.spread, 0, 360) : 0);
    if (initial || o.bed !== undefined) f2 = o.bed === true ? f2 | VoiceFlag2.BED : f2 & ~VoiceFlag2.BED;
    f2 = t.reverbSend[i]! > 0 ? f2 | VoiceFlag2.SENDS : f2 & ~VoiceFlag2.SENDS;
    t.flags2[i] = f2;
  }
}
