/**
 * The internal audio backend interface (ADR 0098) and the `audio.backend` selector (K3). `AudioSource` and
 * `Audio` talk to this, never to a library. Not part of the public API.
 *
 * Lives in the audio plugin (ADR 0157 §6); the engine imports the mixer from `engine/audio/mixer`.
 */
import type { Vec3Like } from "../../../engine/core/math";
import { mixer, type Mixer, type ResolvedBus } from "../../../engine/audio/mixer";
import type { AudioSettings } from "../../../engine/audio/settings";
import { onAudioConfigured } from "../../../engine/core/audioConfigure";
import type { AutomationSink } from "./events/automation";
import type { Curve } from "../../../engine/core/curve";
import type { AudioLatency, MusicEventHandle } from "../../../engine/audio/musicTypes";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import type { DuckingRule } from "../../../engine/audio/settings";
import type { ProfileSink } from "./mix/profileSink";

export type Rolloff = "linear" | "inverse" | "exponential";

/** Why a sound isn't audible right now; null while it is (api-and-models §1). */
export type AudioReason = "virtual" | "stolen" | "busMuted" | "locked" | "failed" | "waitingForData";
/** `Audio.status` (§1). */
export type AudioStatus = "locked" | "running" | "failed";
/** `audio.background` (§2): what the host does when the page is hidden. */
export type AudioBackground = "mute" | "pause" | "play";

/** One sound started with `Audio.playOneShot` (§1). A value, safe to keep: once the voice ends or its slot is reused, every call is a no-op. */
export interface AudioHandle {
  /** True from the call to `playOneShot` until the sound ends or is stopped. Virtual, bus-muted, locked and waiting-for-data sounds are playing (they exist and keep time). Stolen and failed sounds are not. Natural ends are seen up to one frame late. */
  readonly playing: boolean;
  /** Why it isn't audible (while `playing`) or why it ended early ("stolen", "failed"); null when audible, or finished or stopped normally. */
  readonly reason: AudioReason | null;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. A second call is a no-op. */
  stop(fadeSeconds?: number): void;
  /** Ease this sound's own gain multiplier to `to` (linear, 0..4) over `seconds` (0 = at once). */
  fade(to: number, seconds: number): void;
  /** ADR 0162 §1.1: the panner the sound uses ("flat", "equalPower", "hrtf", "bed" or "ambisonic"), read from the main-thread mirror; null once it has ended. */
  readonly panner: AudioPanner | null;
  /** ADR 0162 §1.1: the smoothed dry occlusion gain (1 open, lower as walls muffle it), read from the main-thread mirror. */
  readonly occlusion: number;
}

/**
 * ADR 0162 (contract K0): which panner a voice is using. "flat" for a non-spatial voice, "equalPower" and "hrtf" as in
 * 0157, "bed" for a distant voice mixed into its bus's ambisonic bed, "ambisonic" for an ambisonic clip (api-and-models §1.1).
 */
export type AudioPanner = "flat" | "equalPower" | "hrtf" | "bed" | "ambisonic";

/**
 * ADR 0162 §1.1 (K0): a send's level against distance (0158 `Curve`): x is the distance as a fraction of
 * minDistance..maxDistance (clamped 0..1), y multiplies the send.
 */
export type SendCurve = Curve;
/** ADR 0162 §1.1 (K0): the default send curve, full send up close, half at `maxDistance`. D5 exports it publicly. */
export const DEFAULT_SEND_CURVE: SendCurve = [[0, 1], [1, 0.5]];

/**
 * ADR 0162 §1.6 and contract C24 (K0): the M3 counters `AudioDebugInfo.counters` gains. All optional until the task
 * that fills each one merges; a backend without the feature leaves it out.
 */
export interface AudioM3Counters {
  bedVoices?: number; beds?: number; bedDenied?: number; bedsRefused?: number; bedSwitches?: number; bedFilterLoadFailure?: number; belowHorizonVoices?: number;
  fxVoices?: number; ambisonicVoices?: number;
  zonesActive?: number; zonesRinging?: number; zonesFaded?: number; zoneMemoryKB?: number; kernelRefused?: number; irFailures?: number; irTruncated?: number; irPrepInCore?: number; irPrepares?: number;
  occlusionRays?: number; occlusionUsedMs?: number; occlusionOverruns?: number; occlusionSources?: number; occlusionNoPhysics?: number; oldestOcclusionAgeFrames?: number;
  dopplerClamps?: number; dopplerTeleports?: number; dopplerGuardTrips?: number;
  wideStarved?: number; m3Shed?: number;
}

/** ADR 0162 §1.6 (K0): one bed slot in `AudioDebugInfo.beds`. */
export interface AudioBedDebug {
  slot: number;
  /** The bus that hosts the bed. */
  bus: string;
  /** Buses mixing into this bed (`parent` beds and buses folded in by gain). */
  sharing: string[];
  /** Buses that asked for a bed and didn't get one, and why (C15). */
  denied: { bus: string; reason: string }[];
  voices: number;
  /** Ambisonic clips decoded into this bed. */
  clips: number;
  costUs: number;
}

/** ADR 0162 §1.6 (K0): one reverb zone in `AudioDebugInfo.zones`. */
export interface AudioZoneDebug {
  node: string;
  world: string | null;
  /** The core slot, or -1 without one. */
  slot: number;
  state: string;
  /** The IR asset, or the preset name. */
  ir: string;
  irSeconds: number;
  kernelKB: number;
  prepareMs: number;
  /** Who prepared the kernel (C15). */
  by: "worker" | "core";
  sendEnergy: number;
  rank: number;
  /** Why the zone is silent ("faded: preset has 2 reverbs", "IR failed: …", "wet 0", "no sources inside"), or "". */
  why: string;
}

/** ADR 0162 §1.6 (K0): the occlusion pass in `AudioDebugInfo.occlusion`. */
export interface AudioOcclusionDebug {
  enabled: boolean;
  /** Why it is inert ("2D world", "no 3D physics service"), or "". */
  note: string;
  budgetRays: number;
  rays: number;
  rayCostUs: number;
  oldestAgeFrames: number;
}

/** ADR 0162 §1.6 (K0): M3's fixed memory in `AudioDebugInfo.memory`, bytes. */
export interface AudioMemoryDebug {
  beds: number;
  zones: number;
  kernels: number;
  kernelBudget: number;
  wideRings: number;
}

/** ADR 0162 §1.6 (K0): what a voice row gains in `AudioDebugInfo.voices`. All optional until the tasks that fill them merge. */
export interface AudioVoiceM3Debug {
  panner?: AudioPanner;
  /** The bed slot this voice mixes into, or null. */
  bed?: number | null;
  kindDwellMs?: number;
  /** The Doppler factor folded into its pitch (1 none). */
  doppler?: number;
  occlusion?: { gain: number; cutoffHz: number; ageFrames: number; hits: number; material: string; collider: string | null };
  filter?: { lowpassHz: number; highpassHz: number; lowpassBy: "occlusion" | "event" | "automation" | "bus" | "snapshot" | "parent" | null };
  sends?: { zone: string; level: number }[];
  aux?: { bus: string; level: number } | null;
}

// --- ADR 0171 amended by 0172 (M5, contract K0): the mix debug shape (api-and-models §1.3; Dbg1, Cp2, Rc2 fill it) ---

/** What a backend can do for the M5 mix (§1.3). The core: all true, `capture: "full"`; the Babylon fallback: false, `"mainSideOnly"`. */
export interface AudioMixCaps {
  /** Loudness meters (`Bus.loudness`). */
  loudness: boolean;
  /** Level-mode ducking rules run (presence rules run everywhere). */
  levelDucking: boolean;
  /** The CPU figure is available. */
  cpu: boolean;
  /** Why `cpu` is false ("Babylon fallback: no CPU line", "clock too coarse"), else null. */
  cpuReason: string | null;
  /** Script fades and snapshots start on their stamp (`BUS_RAMP` class B). */
  stampedBusRamps: boolean;
  /** What a capture records: everything, or main-side events and keyframes only (§9). */
  capture: "full" | "mainSideOnly";
}

/** `Audio.debug().cpu` (§1.3, architecture §4.3; Cp2 fills it). */
export interface AudioCpuDebug {
  /** Main's load figure, permille; null before the first window fills ("CPU not yet measured"), never 0 for unknown. */
  loadPermille: number | null;
  /** The window the figure covers, ms. */
  windowMs: number;
  /** The smallest non-zero `Date.now` step seen in the worklet, ms; 0 = none yet. */
  clockStepMs: number;
  /** Wall-clock steps clamped (count). */
  clockSteps: number;
  /** The live work-unit refit's residual; null until fitted. */
  refitResidual: number | null;
  /** Estimated share per section, permille; null until fitted. */
  sections: { voices: number; buses: number; spatial: number; music: number; loudness: number } | null;
  /** Why the figure is hidden (the clock is too coarse), else null. */
  hidden: string | null;
}

/** One slot of the session slot table in `Audio.debug().mix.slots` (§1.3, §6.3). */
export interface AudioMixSlotDebug { name: string | null; slot: number; state: "live" | "tombstone" | "free" }

/** `Audio.debug().mix` (§1.3; Dbg1 fills it). Counts are cumulative unless stated. */
export interface AudioMixDebug {
  /** The session slot table (the identity layout until Ma1 wires the table in). */
  slots: AudioMixSlotDebug[];
  /** A monitor mute or solo is on. */
  monitorActive: boolean;
  /** Meters paused now (by script or by the ladder). */
  metersPaused: number;
  /** The ladder's loudness step in force (STATUS `loudShed`). */
  loudnessLadderStep: 0 | 1;
  /** STATUS `busRecordsEarly`: bus records applied at a quantum's start because the due list was full. */
  busRecordsEarly: number;
  /** STATUS `sidechainLate`. */
  sidechainLate: number;
  /** Live edits refused. */
  liveRefused: number;
  /** Live adds deferred for want of a free slot (architecture §4.7, debug-only). */
  liveDeferred: number;
  /** Each ducking rule's target gain now. */
  ducking: { target: string; trigger: string; mode: "level" | "presence"; gain: number }[];
}

/** `Audio.debug().recorder` (§1.3; Rc2 fills it): the shared capture ring, null while none runs. */
export interface AudioRecorderDebug {
  state: string;
  /** Owners holding the ring (the Profiler panel, `Audio.capture`, the export's trigger). */
  owners: number;
  bytes: number;
  segments: number;
  evicted: number;
  truncated: boolean;
}

/** One of a bus's main-written gain lanes (ADR 0172 §1.3; `LANE_AUTHORED`..`LANE_DIP` of the wire). */
export type MixLane = "authored" | "runtime" | "snapshot" | "monitor" | "dip";

/**
 * One `BUS_RAMP` (§4.2) as main asks for it: ramp `lane` of `bus` (null: the output gain, `BUS_MASTER_OUT`) to `gain`
 * and/or `lpHz` (the snapshot lane only) over `seconds`, from heard time `at` (omitted: asap). `seconds` 0 is a literal
 * step (replay and RESET only, R2). `sequenceId` tags a dip's records (13 bits, 0 none, C27).
 */
export interface BusLaneRamp {
  bus: string | null;
  lane: MixLane;
  gain?: number;
  lpHz?: number;
  seconds: number;
  at?: number;
  sequenceId?: number;
}

/** One `BUS_SLOT` (§4.2, R7): one slot's configuration, so a parameter edit no longer resends the tree. */
export interface BusSlotWrite {
  slot: number;
  /** Parent slot; `BUS_ROOT` (0xFFFF) for a root. */
  parent: number;
  /** In wire form; at most 4 are kept. */
  effects: { type: number; p: number[] }[];
  /** Applies at quantum granularity under the gate (a dip's middle record). */
  structural?: boolean;
  /** The slot starts zeroed with unity lanes (a re-add after recycling). */
  fresh?: boolean;
  sequenceId?: number;
  /** Heard time it applies (omitted: asap). */
  at?: number;
}

/** `LOUD_CONFIG` (§4.2) as main asks for it: the true-peak gate and the metered buses (master is implicit). */
export interface LoudnessConfigWrite {
  tpGateDbfs: number;
  meters: readonly string[];
}

/**
 * The recorder's copy of a STATUS block (architecture §2.1, §4.2), called in `CoreLink.handleMessage` between the decode
 * and the RECYCLE: `data` is the pooled buffer, valid only during the call; `byteLength` the block's bytes. Must not
 * allocate (ground rules). Rc2 fills it from `capture/recorder.ts`.
 */
export type RecorderTap = (data: ArrayBuffer, byteLength: number) => void;

/** A copy of the audio state for tools and "why is there no sound?" (§1, architecture §8). */
export interface AudioDebugInfo {
  status: AudioStatus;
  sampleRate: number;
  time: number;
  background: AudioBackground;
  counters: { underruns: number; lateCommands: number; minSlackFrames: number; workUnits: number; workUnitsMax: number; mixedVoices: number; mixedCap: number; logicalVoices: number; queuedPlays: number; droppedPlays: number; traps: number; refusedLoads: number; hrtfVoices: number; hrtfLoadFailure: number } & AudioM3Counters;
  /** ADR 0162 (K0) adds `bed` (the bus's `bed` setting), `bedHost` (the bus whose bed it mixes into) and `bedLost` (it asked for a bed and has none). */
  buses: { name: string; gain: number; effectiveGain: number; peakL: number; peakR: number; voices: number; maxVoices: number | null; bed?: "own" | "parent" | "none"; bedHost?: string | null; bedLost?: boolean; /** ADR 0171 (K0; Mx2 fills it in W3): the start frame (core frames) of the bus's last stamped `BUS_RAMP`; undefined until then. */ lastRampStartFrame?: number }[];
  voices: ({ id: number; clip: string; bus: string; world: string | null; state: "playing" | "virtual" | "stolen" | "waitingForData" | "busMuted" | "locked"; priority: number; gain: number; pitch: number; audibility: number; playheadSeconds: number | null; owner: string | null; /** ADR 0158 §5 (contract C3): the event instance this voice belongs to, null for none. Filled by E3.1 (core) and E3.2 (Babylon). */ event?: number | null } & AudioVoiceM3Debug)[];
  /** Architecture 8: context state, latencies, lookahead, transport, memory and health groups. */
  core: Record<string, number | string | boolean>;
  /** ADR 0158: playing event instances (`Audio.debug()` adds them; a backend leaves it out). */
  events?: { id: number; asset: string; world: number; voices: number; parameters: Record<string, number | string> }[];
  /** ADR 0162 §1.6 (K0): bed slots (filled by A5; absent on a backend without beds). */
  beds?: AudioBedDebug[];
  /** ADR 0162 §1.6 (K0): reverb zones (filled by C5; absent on the Babylon fallback, where zones are inert). */
  zones?: AudioZoneDebug[];
  /** ADR 0162 §1.6 (K0): the occlusion pass (filled by D2a). */
  occlusion?: AudioOcclusionDebug;
  /** ADR 0162 §1.6 (K0): M3's fixed memory (filled by D5 from the core's preset). */
  memory?: AudioMemoryDebug;
  /** ADR 0166 §1.6, C11 (Q0): one row per playing music instance (filled by P10; absent on a backend without music). */
  music?: MusicDebugRow[];
  /** ADR 0166 §1.6, C11 (Q0): engine-wide music totals (filled by P10). */
  musicTotals?: MusicDebugTotals;
  /** ADR 0171 §1.3 (K0; Dbg1): what the backend can do for the mix. Optional until Dbg1 gives every backend one. */
  mixCaps?: AudioMixCaps;
  /** ADR 0171 §1.3 (K0; Cp2): the CPU figure. */
  cpu?: AudioCpuDebug;
  /** ADR 0171 §1.3 (K0; Dbg1): the slot table, monitor and ladder state, mix counters, ducking. */
  mix?: AudioMixDebug;
  /** ADR 0171 §1.3 (K0; Rc2): the shared capture ring, null while none runs. */
  recorder?: AudioRecorderDebug | null;
}

// --- ADR 0166 interactive music (M4): the debug shape (§1.6, C11; contract Q0, filled by P10) ---------------------

/** A music instance's state (§1.6). */
export type MusicDebugState = "priming" | "playing" | "transitioning" | "recovering" | "ending";

/** One playing music instance in `Audio.debug().music` (api-and-models §1.6, architecture §9, C11). Every field states its unit. */
export interface MusicDebugRow {
  /** The event instance id (as `AudioDebugInfo.events[].id`). */
  id: number;
  /** The event asset path. */
  asset: string;
  state: MusicDebugState;
  /** Node id of the playing segment; null while priming the first one. */
  segment: string | null;
  /** The playing segment's pass (loop count), from 1. */
  pass: number;
  /** 1-based position; `tick` 0..(ticks per beat - 1), §2.2. */
  bar: number;
  beat: number;
  tick: number;
  /** Beats per minute. */
  tempo: number;
  beatsPerBar: number;
  /** Heard time of the position, seconds. */
  time: number;
  /** The pending change and the rule that supplied it, or null. */
  pending: MusicDebugPending | null;
  /** Live groups: id, state, primed members of `of`. */
  groups: { id: number; state: "admitted" | "priming" | "stamped" | "playing" | "held" | "ending"; primed: number; of: number }[];
  /** Stems of the playing segment: track name, primed, streamed, the music ring (index in the pool) or null. */
  stems: { name: string; primed: boolean; streamed: boolean; ring: number | null }[];
  /** Milliseconds: the last group prime time, the estimator Ê, and the prime lead (1.25 Ê + L + Δ̄, ADR 0167 §1.2). */
  primeLastMs: number;
  primeEmaMs: number;
  leadMs: number;
  /** Re-plans by reason (`deadline`, `primeLate`, `groupLate`, `groupHeld`, `rebuild`, ...); counts. */
  replans: Record<string, number>;
  /** Refusals by cause (`poolFull`, `neverFits`, `tailRefused`, ...); counts. */
  refusals: Record<string, number>;
  /** Counts: groups that started late, groups held by a starving member, groups the core gave up on. */
  lateGroups: number;
  groupsHeld: number;
  groupTimeouts: number;
  /** Audio frames: the slip of the last late or held group. */
  lastSlipFrames: number;
  /** Recoveries by cause (`rebuild`, `hidden`, `reload`, `crash`); counts. */
  recoveries: Record<string, number>;
  /** Beats coalesced into `missed` since the instance started. */
  missedBeats: number;
  /** Stinger outcomes; counts. */
  stingers: { played: number; late: number; skipped: number; dropped: number };
}

/** `MusicDebugRow.pending` (§1.6): the change, when it lands, and the rule that supplied it. */
export interface MusicDebugPending {
  /** Target child id. */
  to: string;
  /** Where it lands, `"bar:beat"` in the playing segment. */
  time: string;
  /** Index of the matched rule in its container's list; -1 for the default rule. */
  rule: number;
  /** `"from>to"` as the rule names them (`*` for a wildcard). */
  ruleKey: string;
  /** Specificity tier 1..4 (§2.4). */
  tier: 1 | 2 | 3 | 4;
  /** Id of the container that supplied the rule (the common parent). */
  parent: string;
  /** The rule's exit and enter points as written (`"nextBar"`, `"cue:outro"`, ...). */
  exit: string;
  enter: string;
}

/** `Audio.debug().musicTotals` (§1.6): engine-wide; counts unless stated. */
export interface MusicDebugTotals {
  /** Music rings in use, the pool's size (`music.rings`), and the most ever in use at once. */
  poolUsed: number;
  poolSize: number;
  poolHighWater: number;
  musicRingRefused: number;
  streamStartsLate: number;
  /** Audio frames: the largest slip since init. */
  maxSlipFrames: number;
  /** Whole-quantum splits and voice-local splits, cumulative (R3). */
  splitQuanta: number;
  voiceSplits: number;
  curvePoolFull: number;
  /** A PLAY whose group found no core table entry (a bug signal, architecture §4.3). */
  groupTableFull: number;
  /** The worker's encoded music cache went over its budget with nothing evictable (F-5; counts). */
  encodedOverBudget: number;
}

// --- ADR 0166 interactive music (M4): the backend seam (§4.6, C10; contract Q0) ------------------------------------

/**
 * What a backend can do for music (§4.6, C10). The player branches on this record, never on the backend type. The core:
 * all true. The Babylon fallback: `stampedFades` for decoded clips only, no priming, `currentTime` clock, no rhythm.
 */
export interface MusicBackendCaps {
  /** Streamed stems can be primed and started together by a gate (the core's music pool and group table). */
  readonly primes: boolean;
  /** Fades and stops can be stamped at a frame with a law (in-voice records, M4-0). */
  readonly stampedFades: boolean;
  /** `timeAt` maps `performance.now()` to the heard clock (the core's `ClockMap`); false: `currentTime` only. */
  readonly heardClock: boolean;
  /** Rhythm mode (numeric `latencyHint`, latency read-back, stamped recovery) is available. */
  readonly rhythm: boolean;
}

/** A fade law (§3.1, the `shape` word's `law`, §4.2). Laws run at control rate. */
export type FadeLaw = "linear" | "sCurve" | "equalPowerIn" | "equalPowerOut";

/**
 * A shaped, optionally stamped fade of one voice's `fade` ramp (§4.2; R5: crossfades run on `fade`, not `gain`). With
 * `stopAtEnd` it is a stamped STOP with a shape. Ranges: `to` 0..4 linear, `seconds` >= 0, `startPhase` 0..1.
 */
export interface ShapedFade {
  to: number;
  seconds: number;
  law: FadeLaw;
  /** u0: the ramp starts at `law(u0)` and runs the remaining `1 - u0` over `seconds` (REPLAY of a fade under way). Default 0. */
  startPhase?: number;
  /** Heard time (seconds) it starts at; past, non-finite or omitted: as soon as possible. */
  at?: number;
  /** Stop the voice when the fade ends (a FADE with `stopAtEnd`, or a shaped STOP). */
  stopAtEnd?: boolean;
}

/** One stem of a group (§4.6 `primeGroup` members, C8). Streamed members take a music ring; decoded ones play from the arena. */
export interface MusicGroupMember {
  /** The stem's track name, for debug rows. */
  stem: string;
  /** How the member plays: path, url, bus, volume, `stream`, `priority`, `world`, `group` (the event instance). `at` is ignored: the group's stamp sets it. */
  play: PlayRequest;
  /** File frame the member starts at (entry - pre-entry, a loop or seek offset). */
  startFrame: number;
  /** Loop the region `loopStartFrame..loopEndFrame` (file frames; end exclusive, 0 = the file's end). */
  loop: boolean;
  loopStartFrame?: number;
  loopEndFrame?: number;
  /** PLAY's `fadeZero` (§4.1): start with the `fade` ramp at 0, for a stamped fade-in. */
  fadeZero?: boolean;
}

/** A group: the stems of one segment, started together by the core's gate (§4.1, architecture §4.3). */
export interface MusicGroupRequest {
  /** The music instance (event instance id); the worker's encoded cache is per instance (R16). */
  instance: number;
  /** 1..1023, from main's counter that skips live ids (§3.2). */
  group: number;
  /** At most 64 on the wire, 32 in the core's table. */
  members: MusicGroupMember[];
}

/** The answer to `admitGroup` (architecture §4.2). A permanent refusal never fits this preset; a temporary one retries. */
export type MusicAdmitResult =
  | { ok: true }
  | { ok: false; reason: "poolFull" | "neverFits" | "groupTableFull" | "noMusicRings"; permanent: boolean };

/** `primedState`: a group's members primed in their current epoch (STATUS `musicRings`, R7), decoded members counting as primed. */
export interface MusicPrimedState {
  group: number;
  primed: number;
  of: number;
  /** Every member primed (`primed === of`). */
  ready: boolean;
}

/** A group's stamp (§4.1): its members start at `at` (heard seconds), with their first in-voice records. */
export interface MusicGroupStamp {
  group: number;
  /** Heard time the members start at (the stamp's frame). */
  at: number;
  /** Shaped fades for members, by index in the request's `members`, applied in-voice at their own `at` (or the stamp). */
  fades?: { member: number; fade: ShapedFade }[];
}

/** Group and member events from the core (STATUS `groupStarts`, starved, ended and error reports; §4.4, C4). */
export type MusicGroupEvent =
  | { kind: "start" | "resume" | "abandon"; group: number; late: boolean; slipFrames: number; startFrame: number }
  | { kind: "starve" | "end"; group: number; member: number }
  | { kind: "error"; group: number; member: number; message: string }
  | { kind: "refused"; group: number; member: number; reason: "musicFull" };

/**
 * The backend's music operations (§4.6, C10). Absent on a backend without music: the player then plays nothing and
 * warns once. The core implements this in `core/musicOps.ts` (Q2 wires it, P1 fills it); the fallback in B1.
 */
export interface MusicBackend {
  readonly caps: MusicBackendCaps;
  /** Check the pool and the group table for this group; nothing is opened. */
  admitGroup(req: MusicGroupRequest): MusicAdmitResult;
  /**
   * Prime an admitted group: post `primeGroup` to the worker (breadth-first, §4.6). With `retarget`, open members restart
   * at their new start frames under new epochs. `protect` is the instance's protected paths (playing, primed, candidate
   * successors) for the worker's encoded cache (C8).
   */
  primeGroup(req: MusicGroupRequest, options?: { retarget?: boolean; protect?: readonly string[] }): void;
  /** The group's primed state from the last STATUS; null for an unknown group. */
  primedState(group: number): MusicPrimedState | null;
  /** Stamp a primed group: PLAY every member gated, at the stamp's frame, in one BATCH. One voice per member, null where it couldn't start. */
  stampGroup(stamp: MusicGroupStamp): (AudioVoice | null)[];
  /** Cancel a group: close its streams, stop any member already playing, free its id. Unknown ids are ignored. */
  cancelGroup(group: number): void;
  /** The instance ended: the worker drops its encoded bytes (R16). */
  releaseInstance(instance: number): void;
  /** Tell the worker which paths of an instance are protected from eviction (on each planner change of candidates, C8). */
  protect(instance: number, paths: readonly string[]): void;
  /** The music ring pool's size (`preset.maxMusicRings` on the core); 0 on a backend without priming. */
  readonly ringPool: number;
  /** Group and member events, delivered in `update()` after the status mirror is read. */
  onGroupEvent: ((e: MusicGroupEvent) => void) | null;
  /** Milliseconds: the page-wide prime estimator Ê (architecture §4.2), seeded at 40 on a new context. */
  readonly primeEmaMs: number;
}

/**
 * ADR 0158 §5: a playing event. M1's four members keep their meaning across all of the instance's voices. ADR 0166 §1.2
 * adds `music`, `onMusic` and `trigger` (declared in `MusicEventHandle`).
 */
export interface AudioEventHandle extends AudioHandle, MusicEventHandle {
  /** Set one of the event's own parameters (labelled ones by label). Unknown names warn once. */
  setParameter(name: string, value: number | string): void;
  /** One of the event's parameters, else a global one; undefined if neither. */
  getParameter(name: string): number | string | undefined;
  /** Where a spatial event plays; set it to move it. Null for a flat event. */
  position: Vec3Like | null;
  /** Key-off: sustain loops leave their loops and play their tails; the event ends when they do. A no-op without sustain. */
  release(): void;
}

export interface Attenuation {
  minDistance: number;
  maxDistance: number;
  rolloff: Rolloff;
}

export interface PlayRequest {
  /** The name of the node that plays it, for debug tools only (Audio Debug's Source column); absent for one-shots and events. */
  owner?: string;
  /** Asset path (no `asset:` prefix). */
  path: string;
  url: string;
  loop: boolean;
  /** Import setting: stream rather than decode up front. On the core a streamed clip is a full voice (spatial, buses, effects); the Babylon fallback plays it as HTML5 audio, flat and unpitched. */
  stream: boolean;
  /** Mixer bus name (already resolved to an existing bus). */
  bus: string;
  /** Linear gain, default 1. */
  volume?: number;
  /** Ratio, default 1. */
  pitch?: number;
  /** 0..255, default 128. */
  priority?: number;
  /** A fire-and-forget `playOneShot` sound (the locked queue may drop these, D5). */
  oneShot?: boolean;
  /** The playing World's key on the core (0 or omitted: none); only the core uses it (A3.4b, architecture §3.9). */
  world?: number;
  /** Start at this audio-clock time (seconds, `Audio.time`'s base). Past, non-finite or omitted: as soon as possible. */
  at?: number;
  attenuation?: Attenuation;
  position?: Vec3Like;
  /** ADR 0158: the event instance this voice belongs to (1..1024; 0 or omitted: none). The core carries it in PLAY's `group`. */
  group?: number;

  // ADR 0162 (contract K0). Every field is optional and means "as 0157/0158" when omitted, so a backend that predates
  // the feature ignores it. Ranges are api-and-models §1.2, §1.3 and §2.5; callers clamp before they get here.
  /** §1.2: spatial voices only; walls between source and listener muffle it. Omitted: true for a positioned voice. */
  occlusion?: boolean;
  /** §1.2/§1.3: 0..5, scales the Doppler shift; 0 off. Omitted: 0 (the caller applies the source or one-shot default). */
  dopplerLevel?: number;
  /** §1.2: 0..2, the voice's send to the zones that hold it, taken before the distance gain (R11). Omitted: 1. */
  reverbSend?: number;
  /** §1.2: the send against distance. Omitted: `DEFAULT_SEND_CURVE`. */
  reverbSendCurve?: SendCurve;
  /** §1.6, §2.4: the clip is ambisonic (its sidecar says so); spatial fields, occlusion and Doppler are ignored. */
  ambisonic?: boolean;
  /** §1.2 `ambisonicYaw` / §1.3 `yaw`: degrees, -180..180, positive to the right (clockwise seen from above, ADR 0164). */
  yaw?: number;
  /** §1.3, §2.5 `filter`: per-voice low-pass and high-pass, Hz (10..24000; lowpass ≥ 20000 and highpass ≤ 20 are off). */
  filter?: { lowpass?: number; highpass?: number };
  /** §2.5 `sends`: one aux send to a bus by name, 0..2, post the voice's bus-chain gain. */
  aux?: { bus: string; level: number };

  // ADR 0166 (contract Q0). Optional; a backend without music ignores it.
  /** §4.1 `fadeZero`: the voice starts with its `fade` ramp at 0, silent until a stamped fade opens it. */
  fadeZero?: boolean;
  /**
   * C14 (R4a): play only the span `[startFrame, endFrame)` of the file (frames at the file's own rate), decoded as its
   * own clip (a loop tail). Decoded clips only; a backend without span clips (`holdSpan` absent) ignores it.
   */
  span?: { startFrame: number; endFrame: number };
}

/**
 * C14 (R4a): a reference to a decoded span clip, taken ahead of its plays so the span is resident when a voice is
 * stamped on it (`AudioBackend.holdSpan`). A refused span (bad range, over 30 s, over the clip ceiling) reads `failed`.
 */
export interface ClipSpanHold {
  readonly state: "loading" | "ready" | "failed";
  /** Why it failed (`refusedSpan`, `refusedCeiling`, `fetch`, `decode`, ...), null otherwise. */
  readonly failure: string | null;
  /** Drop the reference (once; later calls do nothing). Voices playing the span keep their own. */
  release(): void;
}

/**
 * ADR 0162 §1.2 (K4): the per-voice options a Play edit changes on a playing voice (`AudioSource.apply`). Omitted fields
 * are kept. Ranges as `PlayRequest`'s; callers clamp.
 */
export interface VoiceSpatialOptions {
  occlusion?: boolean;
  dopplerLevel?: number;
  reverbSend?: number;
  reverbSendCurve?: SendCurve;
  /** Degrees, -180..180, positive to the right (ambisonic clips). */
  yaw?: number;
}

/** One playing sound. */
export interface AudioVoice {
  readonly playing: boolean;
  /**
   * E3.10: false once the voice has been freed. A stopped voice fading out is not `playing` but is still alive; the event
   * runtime keeps an instance's group until every voice that carried it is gone. Absent: same as `playing`.
   */
  readonly alive?: boolean;
  readonly id: number;
  /** Why it isn't audible, or why it ended early (§1); null otherwise. */
  readonly reason: AudioReason | null;
  /** Ease the voice's own gain to `to` (linear, 0..4) over `seconds`. */
  fade(to: number, seconds: number): void;
  setPriority(priority: number): void;
  setVolume(v: number): void;
  setPitch(rate: number): void;
  setAttenuation(a: Attenuation): void;
  setPosition(p: Vec3Like): void;
  /** Move to another bus while playing. */
  setBus(bus: string): void;
  pause(): void;
  resume(): void;
  /**
   * Move to `seconds` of the sound (B3b; the core backend only). The old audio fades out over 5 ms and the new fades
   * in; a streamed sound is flushed (no old audio after the seek) and reads "waitingForData" until it is decoded from
   * there. A loop wraps the time, otherwise it clamps to the end. Absent on the Babylon fallback.
   */
  seek?(seconds: number): void;
  /**
   * ADR 0158 §4, for backends without an `automation` sink of their own (the Babylon fallback): loop `start..end` seconds
   * of the clip (`end` 0 is its end), or with `looping` false play on past the loop to the clip's end.
   */
  setLoop?(start: number, end: number, looping: boolean): void;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. */
  stop(fadeSeconds?: number): void;

  // ADR 0162 (contract K0). Optional: a backend without the feature leaves them out and callers skip the call.
  /** §3.2: the source's velocity, world units per second (Doppler, debug). */
  setVelocity?(v: Vec3Like): void;
  /**
   * §8, K4: main's smoothed occlusion result for this voice. `gain` is the dry gain (1 open); `lpHz` the cutoff it asks
   * for (≥ 20000 off). The core routes both into the per-voice filter (`voiceFx`); the Babylon fallback applies the gain
   * only, through its volume, and drops the cutoff.
   */
  setOcclusion?(gain: number, lpHz: number): void;
  /** §8, K4: main's clamped Doppler factor (1 none). The core folds it into pitch; Babylon into `playbackRate` (decoded clips only). */
  setDopplerRate?(factor: number): void;
  /**
   * §1.1, D5: the panner the voice uses and its smoothed dry occlusion gain (1 open), read from the main-thread tables
   * (the public handle's `panner` and `occlusion`). Absent on a backend without them: the handle reads null and 1.
   */
  readonly panner?: AudioPanner | null;
  readonly occlusion?: number;
  /** §1.2, K4: Play edits of the source's M3 options (`VoiceSpatialOptions`); a backend without them leaves it out. */
  setSpatialOptions?(o: VoiceSpatialOptions): void;
  /**
   * ADR 0166 §4.2 (Q0): a shaped fade of the voice's `fade` ramp, stamped at `f.at`; with `stopAtEnd` a shaped STOP.
   * Absent on a backend without stamped fades (`MusicBackendCaps.stampedFades`): callers use `fade`/`stop`.
   */
  fadeShaped?(f: ShapedFade): void;
  /**
   * ADR 0166 §4.6 (G-1): a stamped ramp of the voice's own gain and/or low-pass, with a law. `gain` multiplies the voice's
   * dry gain (not the `fade` ramp); `lowpassHz` is a cutoff; `at` the heard time it starts (omitted: as soon as possible).
   * Absent on a backend without stamped ramps (callers use `fade`).
   */
  paramsShaped?(r: { gain?: number; lowpassHz?: number; seconds: number; law?: FadeLaw; at?: number }): void;
}

/**
 * ADR 0162 (contract K0, C9): main's side of zone impulse-response preparation. K4 constructs it in `coreBackend.ts`;
 * C2b implements it in `core/zoneIr.ts` over the decoder worker. The kernel itself goes from the worker straight to
 * the worklet (main never holds kernels or time-domain IRs); main hears only that it was prepared or failed.
 */
export interface ZoneIrService {
  /**
   * Ask for kernel `kernelId` from an IR asset (`assetUrl`) or a built-in preset (`preset`, R10) at `contextRate`, cut to
   * `maxFrames`. Returns the request's token. A request for a kernel already prepared at this rate is answered at once.
   */
  prepare(request: { kernelId: number; assetUrl?: string; preset?: string; contextRate: number; maxFrames: number }): number;
  /** Forget kernel `kernelId`: the worker drops its kept bytes and the core may reuse the slot. Unknown ids are ignored. */
  release(kernelId: number): void;
  /** Called when a kernel reached the worklet (`irPrepared`). */
  onPrepared: ((e: { token: number; kernelId: number; frames: number; truncated: boolean; prepareMs: number }) => void) | null;
  /** Called when preparing failed (`irFailed`): the zone reads "IR failed: <message>". */
  onFailed: ((e: { token: number; kernelId: number; code: number; message: string }) => void) | null;
  /** A rate change or hard rebuild: re-prepare every kernel still held from the worker's kept bytes. */
  reprepareAll?(contextRate: number): void;
  dispose?(): void;
}

export interface ListenerPose {
  position: Vec3Like;
  forward: Vec3Like;
  up: Vec3Like;
}

export interface AudioBackend {
  readonly name: string;
  /** Start a clip. Null if the backend can't (not ready, unknown clip). */
  play(req: PlayRequest): AudioVoice | null;
  setListener(pose: ListenerPose): void;
  /** Re-apply the mixer's resolved state to the backend's buses. */
  applyMix(buses: readonly ResolvedBus[]): void;
  /** Rebuild the bus graph after the project's buses changed. */
  configureBuses(mixer: Mixer): void;
  masterVolume: number;
  muted: boolean;
  readonly status: AudioStatus;
  /** The heard audio clock, seconds. */
  readonly time: number;
  debug(): AudioDebugInfo;
  setBackground(mode: AudioBackground): void;
  /** Per-frame hook. */
  update(dt: number): void;
  dispose?(): void;
  /**
   * ADR 0158: the backend's own automation (the core's tables). Absent: the event runtime evaluates automation on main
   * with `TsAutomation` once per frame and drives voices through their setters.
   */
  readonly automation?: AutomationSink;
  /** ADR 0158: a loaded clip's length in seconds at pitch 1, or null while it isn't known (still loading, streaming). */
  clipDuration?(path: string): number | null;
  /** ADR 0166 (G-1): the clock's frame-interval average Δ̄, seconds. Absent: callers estimate it. */
  frameInterval?(): number;
  /** ADR 0166 (G-1): a loaded clip's facts, or undefined while unknown (not loaded, failed). `gapless`: its length is exact. */
  clipFacts?(path: string): { frames: number; rate: number; channels: number; gapless: boolean } | undefined;
  /** ADR 0166 (P8): the asset file at `path` was edited: drop what is cached of it (decoded clips, the worker's encoded music bytes). */
  invalidateClip?(path: string): void;
  /** ADR 0158: the earliest audio-clock time (`time`'s base) a play with `at` lands on exactly, for gapless chains. */
  horizon?(): number;
  /**
   * ADR 0166 C14 (R4a): hold the decoded span `[startFrame, endFrame)` of the asset at `path` (frames at its own rate)
   * so a play with `PlayRequest.span` finds it resident. Absent: no span clips (no loop tails).
   */
  holdSpan?(path: string, startFrame: number, endFrame: number): ClipSpanHold;

  // ADR 0166 (contract Q0). Optional: a backend without the feature leaves them out.
  /** §4.6, C10: the music operations; absent: no music. */
  readonly music?: MusicBackend;
  /**
   * §6 step 0 (R17): advance the heard-clock map and read the status mirror for this display frame. Idempotent per frame
   * (`ClockMap.beginFrame` does nothing the second time at the same `rafTime`), so `update` may call it again.
   */
  beginFrame?(): void;
  /** §1.3 `Audio.timeAt`: the raw heard time (seconds) of a `performance.now()` instant (ms). Calibration is never applied (R18). */
  timeAt?(performanceTime: number): number;
  /** §1.3 `Audio.latency`, seconds. */
  latency?(): AudioLatency;

  // ADR 0171 amended by 0172 (M5, contract K0). Optional: a backend without the feature leaves them out.
  /** §1.3: what this backend can do for the mix (Dbg1 tests the flags per backend). */
  readonly mixCaps?: AudioMixCaps;
  /** §1.3, architecture §4.3: the CPU figure (Cp2's `CpuMeter`). */
  cpu?(): AudioCpuDebug;
  /** §1.3, §6.2: apply one live edit (Ma1–Ma3 fill the core's path; until then every op answers `restartRequired`). */
  applyOp?(op: MixOp): ApplyResult;
  /** §6.6: post the pending batch now (the fader's preview path, at most one post per `FADER_COALESCE_MS`). */
  flushNow?(): void;
  /** §4.2 `BUS_RAMP`: the lane writer (Wa2's interim body, then Mx2's). */
  rampLane?(r: BusLaneRamp): void;
  /** §4.2 `BUS_SLOT`: one slot's configuration (Ma1, Ma2). */
  writeSlot?(w: BusSlotWrite): void;
  /** §4.2 `BUS_DUCK`: every ducking rule, replace-all, asap (Dp1, Sc1). */
  writeDucking?(rules: readonly DuckingRule[]): void;
  /** §4.2 `LOUD_CONFIG`: the metered buses and the true-peak gate, replace-all, asap (Ld2, Ld4). */
  writeLoudnessConfig?(c: LoudnessConfigWrite): void;
  /** §1.1 `Bus.duckGain`: the duck lane's gain of `bus` from STATUS (1 = not ducked; Dp1 fills it on the core). */
  duckGain?(bus: string): number;
  /** Architecture §2.1: the recorder's STATUS tap, null when no recorder runs (Rc2 sets it through `capture.ts`). */
  recorderTap?: RecorderTap | null;
  /** §5.6: the capture's event taps (Rc3); null restores the null object. */
  setProfileSink?(sink: ProfileSink | null): void;
}

let backend: AudioBackend | null = null;
let factory: (() => AudioBackend) | null = null;
let coreFactory: (() => AudioBackend) | null = null;
let warnedCore = false;
let coreUnavailableReason: string | null = null;

/** Register how the `"babylon"` backend is made (`BabylonBackend` does this on import, from `AudioSource.ts`). */
export function registerDefaultBackend(make: () => AudioBackend): void {
  factory = make;
}

/**
 * @internal The core's backend factory, registered by `core/service.ts` once the core has loaded (A0.3, A1.4). Returns an
 * undo. Sound played while the core was still loading (the pending backend) moves onto the core now.
 */
export function registerCoreBackend(make: () => AudioBackend): () => void {
  coreFactory = make;
  settlePending();
  return () => { if (coreFactory === make) coreFactory = null; };
}

/**
 * @internal A0.6's fallback trigger: the probe (or a failed core load) says why the core can't run here. The
 * next `audioBackend()` that wanted the core logs one warning carrying `reason`, then uses "babylon" (§2.1 fallback
 * rule). Only the first reason is kept, so one failure gives one warning. Sound played while the core was loading
 * moves onto "babylon" now.
 */
export function noteCoreUnavailable(reason: string): void {
  coreUnavailableReason ??= reason;
  settlePending();
}

/** @internal Test hook: forget the warning state so each test starts clean. */
export function resetCoreFallbackState(): void {
  warnedCore = false;
  coreUnavailableReason = null;
}

/**
 * K3: which backend `audio.backend` picks. `"core"` is the core, the default (`defaultBackend()` in the settings; macOS
 * desktop defaults to "babylon" until its gate passes); `"babylon"` is `BabylonBackend` (Babylon's AudioEngineV2), the
 * fallback. The settings parse reports pre-0157 values as problems and uses the default.
 */
export function resolveBackendKind(configured: AudioSettings["backend"]): "babylon" | "core" {
  return configured === "core" ? "core" : "babylon";
}

/** The active backend, created on first use so servers and tests that never play sound don't touch a library. */
export function audioBackend(): AudioBackend {
  // The project left "core" while it was still loading (an editor settings change): its sound goes to "babylon".
  if (backend instanceof PendingCoreBackend && resolveBackendKind(mixer.audioSettings.backend) !== "core") settlePending();
  if (!backend) {
    let make = factory;
    if (resolveBackendKind(mixer.audioSettings.backend) === "core") {
      if (coreFactory) make = coreFactory;
      else if (coreUnavailableReason === null) {
        // §2.1, §3.1: the core loads (through the `myco.audio` World service) while sound is locked. Until it has
        // loaded or failed, plays wait as locked voices, then move to whichever backend the load settles on.
        backend = new PendingCoreBackend();
        applyBackgroundSetting(backend);
        return backend;
      } else if (!warnedCore) {
        // A real failure (probe refusal, load or start failure): one warning, then "babylon" for the page (§2 Fallback).
        warnedCore = true;
        console.warn(`[myco] ${coreUnavailableReason}`);
      }
    }
    if (!make) throw new Error("No audio backend registered.");
    backend = make();
    backend.configureBuses(mixer);
    backend.applyMix(mixer.resolveAll());
    applyBackgroundSetting(backend);
    mixer.onChange(() => backend?.applyMix(mixer.resolveAll()));
  }
  return backend;
}

let followingBackground = false;

/**
 * A3.4b: `audio.background` reaches the backend (§6 `setBackground`) when it is made and after each Engine's mixer
 * reconfigure, so a project switching mode is picked up at the next hide.
 */
function applyBackgroundSetting(target: AudioBackend): void {
  target.setBackground(mixer.audioSettings.background);
  if (followingBackground) return;
  followingBackground = true;
  onAudioConfigured((settings) => backend?.setBackground(settings.background));
}

/** Swap the backend (a test double). Sounds on the old one are stopped by its `dispose`. */
export function setAudioBackend(next: AudioBackend | null): void {
  backend?.dispose?.();
  backend = next;
  if (next) {
    next.configureBuses(mixer);
    next.applyMix(mixer.resolveAll());
    applyBackgroundSetting(next);
  }
}

/** The core load settled (registered, failed, or no longer wanted): the pending backend hands its sound to the real one. */
function settlePending(): void {
  if (!(backend instanceof PendingCoreBackend)) return;
  const pending = backend;
  backend = null;
  pending.handOver(audioBackend());
}

/** D5, as the core's locked queue: at most this many one-shots wait, and none older than `ONE_SHOT_WINDOW_MS`. */
const MAX_PENDING_ONE_SHOTS = 32;
const ONE_SHOT_WINDOW_MS = 1000;
/** Ids for voices that haven't reached a real backend yet (above the core's 16-bit slot ids' generations in use). */
let nextPendingId = 0x7fff_0000;

/**
 * A voice played while the core was loading (architecture §2.1, §3.1): `reason` "locked", `playing` true. It keeps
 * the request and every setter's latest value, then starts on the real backend at the hand-over and forwards to it.
 * Holders (an `AudioSource`, a music player, an `AudioHandle`) keep the same object throughout.
 */
class PendingVoice implements AudioVoice {
  private inner: AudioVoice | null = null;
  private stopped = false;
  private dropped = false;
  private failed = false;
  private paused = false;
  private fadeTo: number | null = null;
  /** ADR 0158 §4: the loop region the event runtime asked for while waiting (the latest call wins). */
  private loop: { start: number; end: number; looping: boolean } | null = null;
  /** ADR 0162 (K4): main's latest M3 values while waiting, applied at the hand-over where the real voice takes them. */
  private velocity: Vec3Like | null = null;
  private occlusionValue: { gain: number; lpHz: number } | null = null;
  private dopplerRate: number | null = null;
  private spatialOptions: VoiceSpatialOptions | null = null;
  private readonly localId = nextPendingId++;
  readonly queuedAt = performance.now();

  constructor(private readonly req: PlayRequest) {}

  get live(): boolean {
    return !this.stopped && !this.dropped && this.inner === null;
  }
  get oneShot(): boolean {
    return !!this.req.oneShot && !this.req.loop;
  }
  get id(): number {
    return this.inner?.id ?? this.localId;
  }
  get playing(): boolean {
    if (this.inner) return this.inner.playing;
    return this.live;
  }
  get alive(): boolean {
    if (this.inner) return this.inner.alive ?? this.inner.playing;
    return this.live;
  }
  get reason(): AudioReason | null {
    if (this.inner) return this.inner.reason;
    if (this.failed) return "failed";
    return this.stopped || this.dropped ? null : "locked";
  }

  /** Starts on `target` with the latest values; null from `target` ends it "failed". */
  attach(target: AudioBackend): void {
    const voice = target.play({ ...this.req });
    if (!voice) {
      this.stopped = true;
      this.failed = true;
      return;
    }
    this.inner = voice;
    if (this.fadeTo !== null) voice.fade(this.fadeTo, 0);
    if (this.paused) voice.pause();
    // The request's `group` went with `play`. A loop region is applied here only where the voice takes it itself (the
    // Babylon fallback; a state set, so the event runtime's re-send that follows repeats it harmlessly); a core voice
    // gets it from that re-send through the core's automation, by id.
    if (this.loop && voice.setLoop) voice.setLoop(this.loop.start, this.loop.end, this.loop.looping);
    this.loop = null;
    // ADR 0162 (K4): the M3 values given while waiting, where the voice takes them.
    if (this.spatialOptions && voice.setSpatialOptions) voice.setSpatialOptions(this.spatialOptions);
    if (this.velocity && voice.setVelocity) voice.setVelocity(this.velocity);
    if (this.occlusionValue && voice.setOcclusion) voice.setOcclusion(this.occlusionValue.gain, this.occlusionValue.lpHz);
    if (this.dopplerRate !== null && voice.setDopplerRate) voice.setDopplerRate(this.dopplerRate);
    this.spatialOptions = null;
    this.velocity = null;
    this.occlusionValue = null;
    this.dopplerRate = null;
  }
  /** Left out at the hand-over (D5: an old or surplus one-shot). */
  drop(): void {
    this.dropped = true;
  }

  fade(to: number, seconds: number): void {
    if (this.inner) this.inner.fade(to, seconds);
    else this.fadeTo = to;
  }
  setPriority(priority: number): void {
    if (this.inner) this.inner.setPriority(priority);
    else this.req.priority = priority;
  }
  setVolume(v: number): void {
    if (this.inner) this.inner.setVolume(v);
    else this.req.volume = v;
  }
  setPitch(rate: number): void {
    if (this.inner) this.inner.setPitch(rate);
    else this.req.pitch = rate;
  }
  setAttenuation(a: Attenuation): void {
    if (this.inner) this.inner.setAttenuation(a);
    else this.req.attenuation = { minDistance: a.minDistance, maxDistance: a.maxDistance, rolloff: a.rolloff };
  }
  setPosition(p: Vec3Like): void {
    if (this.inner) this.inner.setPosition(p);
    else this.req.position = { x: p.x, y: p.y, z: p.z };
  }
  setBus(bus: string): void {
    if (this.inner) this.inner.setBus(bus);
    else this.req.bus = bus;
  }
  /** Recorded while waiting (so the event runtime's `TsAutomation` doesn't warn that part of a clip can't loop), forwarded after. */
  setLoop(start: number, end: number, looping: boolean): void {
    if (this.inner) this.inner.setLoop?.(start, end, looping);
    else this.loop = { start, end, looping };
  }
  setVelocity(v: Vec3Like): void {
    if (this.inner) this.inner.setVelocity?.(v);
    else this.velocity = { x: v.x, y: v.y, z: v.z };
  }
  setOcclusion(gain: number, lpHz: number): void {
    if (this.inner) this.inner.setOcclusion?.(gain, lpHz);
    else this.occlusionValue = { gain, lpHz };
  }
  setDopplerRate(factor: number): void {
    if (this.inner) this.inner.setDopplerRate?.(factor);
    else this.dopplerRate = factor;
  }
  /** Merged while waiting (omitted fields keep earlier values), as on a playing voice. */
  setSpatialOptions(o: VoiceSpatialOptions): void {
    if (this.inner) this.inner.setSpatialOptions?.(o);
    else this.spatialOptions = { ...this.spatialOptions, ...o };
  }
  pause(): void {
    if (this.inner) this.inner.pause();
    else this.paused = true;
  }
  resume(): void {
    if (this.inner) this.inner.resume();
    else this.paused = false;
  }
  stop(fadeSeconds?: number): void {
    if (this.inner) this.inner.stop(fadeSeconds);
    else this.stopped = true;
  }
}

/**
 * The backend while `audio.backend` is "core" and the core is still loading: no library, no context of its own,
 * `status` "locked". Plays become `PendingVoice`s; `handOver` starts the live ones on the backend the load settled
 * on (the core, or "babylon" after a real failure) and passes on the master volume, mute, listener and background.
 */
class PendingCoreBackend implements AudioBackend {
  readonly name = "pending";
  readonly status: AudioStatus = "locked";
  readonly time = 0;
  masterVolume = 1;
  muted = false;
  private readonly voices: PendingVoice[] = [];
  private listener: ListenerPose | null = null;
  private background: AudioBackground | null = null;

  play(req: PlayRequest): AudioVoice | null {
    const voice = new PendingVoice({ ...req });
    this.voices.push(voice);
    return voice;
  }
  setListener(pose: ListenerPose): void {
    const copy = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y, z: p.z });
    this.listener = { position: copy(pose.position), forward: copy(pose.forward), up: copy(pose.up) };
  }
  applyMix(): void {}
  configureBuses(): void {}
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }
  update(): void {
    // Forget voices stopped before the hand-over, so a long load doesn't grow the list.
    if (this.voices.length > 0 && !this.voices[0]!.live) {
      let w = 0;
      for (const v of this.voices) if (v.live) this.voices[w++] = v;
      this.voices.length = w;
    }
  }
  debug(): AudioDebugInfo {
    const live = this.voices.filter((v) => v.live);
    return {
      status: "locked", sampleRate: 0, time: 0, background: this.background ?? "mute",
      counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, mixedCap: 0, logicalVoices: live.length, queuedPlays: live.length, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 },
      buses: [], voices: [], core: { backend: "pending", state: "loading" },
    };
  }
  handOver(target: AudioBackend): void {
    target.masterVolume = this.masterVolume;
    target.muted = this.muted;
    if (this.background !== null) target.setBackground(this.background);
    if (this.listener) target.setListener(this.listener);
    const now = performance.now();
    const live = this.voices.filter((v) => v.live);
    this.voices.length = 0;
    const fresh = (v: PendingVoice) => !v.oneShot || now - v.queuedAt <= ONE_SHOT_WINDOW_MS;
    // Oldest first: the surplus over the cap is the oldest one-shots.
    let surplus = live.filter((v) => v.oneShot && fresh(v)).length - MAX_PENDING_ONE_SHOTS;
    for (const v of live) {
      if (!fresh(v) || (v.oneShot && surplus-- > 0)) v.drop();
      else v.attach(target);
    }
  }
  dispose(): void {
    for (const v of this.voices) v.stop();
    this.voices.length = 0;
  }
}

/** @internal Whether `audioBackend()` is the stand-in used while the core loads (the audio system, tests). */
export const isPendingCoreBackend = (b: AudioBackend | null): boolean => b instanceof PendingCoreBackend;

/** @internal Whether a backend exists yet (the audio system skips work before first sound). */
export const hasAudioBackend = (): boolean => backend !== null;

/** The one mixer lives in `engine/audio/mixer` (ADR 0157 §6); re-exported here for the plugin's backends and tests. */
export { mixer } from "../../../engine/audio/mixer";
