// The shape of `Audio.debug()` (api-and-models §1, architecture §8): the types every backend's `debug()` returns and the
// editor's Audio Debug panel, Profiler and audition read. Split out of `backend.ts` by ADR 0179 so that file reads as the
// backend seam; `backend.ts` re-exports every name, so importers did not change. Not part of the public API beyond the
// types `runtime/index.ts` re-exports for `Audio.debug()`.
import type { AudioBackground, AudioPanner, AudioStatus } from "./backend";

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
  /** Live adds waiting for a slot now (of `liveDeferred`, those not yet applied). */
  liveDeferredPending: number;
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

/** `AudioDebugInfo.counters`' fourteen base fields at zero: the start of a backend's counters where it has no core (the Babylon fallback, the pending backend, the fake). */
export function zeroCounters(): AudioDebugInfo["counters"] {
  return { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, mixedCap: 0, logicalVoices: 0, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 };
}
