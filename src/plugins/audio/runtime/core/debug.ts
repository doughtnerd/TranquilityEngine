// `Audio.debug()` for the core (K10; api-and-models §1 `AudioDebugInfo`; architecture §8). `coreBackend.debug()` calls
// `buildDebugInfo`, which reads the voice table, the status mirror, the mixer and the clip registry: nothing is
// stored here, so every call is a fresh copy.
import type { AudioBackground, AudioDebugInfo, AudioStatus } from "../backend";
import type { Mixer } from "../../../../engine/audio/mixer";
import type { ClipInfo } from "./clipRegistry";
import type { ClockMap } from "./clock";
import type { BedPlanner } from "./beds";
import type { StatusMirror } from "./mirror";
import type { PlayheadTracker } from "./replay";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";

export type { AudioDebugInfo };

type VoiceStateName = AudioDebugInfo["voices"][number]["state"];

/** What `buildDebugInfo` reads of the backend: `CoreBackend` satisfies it, and tests build it by hand. */
export interface DebugSource {
  /** `health` (A3.4a): the host's traps, recoveries and rebuilds over every core it ran; absent in hand-built sources. */
  readonly host: { readonly sampleRate: number; readonly health?: { readonly traps: number; readonly recoveries: number; readonly rebuilds: number } };
  readonly status: AudioStatus;
  readonly time: number;
  readonly backgroundMode: AudioBackground;
  /** Bus names by bus index (root first), as the core was last configured. */
  readonly busNames: readonly string[];
  readonly mirror: StatusMirror;
  readonly table: VoiceTable;
  readonly clips: { info(id: number): ClipInfo | null };
  /** B3: the stream voices' clip info (asset and rate) and counts; absent in hand-built sources. */
  readonly streams?: { clipInfo(id: number): ClipInfo | null; readonly size: number; readonly stats: { readonly starves: number; readonly errors: number; readonly coreErrors: number; readonly wideStarved?: number } };
  readonly mixer: Pick<Mixer, "resolveAll" | "audioSettings">;
  readonly lockedQueue: { readonly size: number; readonly droppedCount: number };
  /**
   * ADR 0158 (E3.1): the automation mirror's counts; absent in hand-built sources. E3.9: main's estimate of a voice's
   * automated gain and pitch now (false: none) and of a bus's automated gain, multiplied into the rows.
   */
  readonly automation?: {
    readonly counts: { readonly curves: number; readonly voices: number; readonly pending: number };
    voiceAutomation?(i: number, out: { gain: number; pitch: number; lowpass: number }): boolean;
    busAutomationGain?(bus: string): number;
  };
  /** E3.9: the playhead estimate (event voices' `playheadSeconds`; the core reports none for them); absent in hand-built sources. */
  readonly playheads?: Pick<PlayheadTracker, "wrappedNow">;
  readonly hrtfReady: boolean;
  /** H3: STATUS `hrtfLoadFailure` with main's fetch failure (1); absent in hand-built sources (STATUS's alone). */
  readonly hrtfLoadFailure?: number;
  /** H3: voices main flags for HRTF this frame (at most `voices.hrtf`); absent in hand-built sources. A5 adds the bed's. */
  readonly hrtf?: { readonly count: number; readonly bedCount?: number; readonly bedSwitches?: number };
  /** ADR 0162 (A5): the bed planner (`beds.ts`); absent in hand-built sources. Nothing is reported while no bed is laid out. */
  readonly beds?: Pick<BedPlanner, "maxBeds" | "counters" | "debug" | "busDebug">;
  /** ADR 0162 (A5): the MagLS loader's failure (`bedFilterLoadFailure`); absent in hand-built sources. */
  readonly maglsFailed?: boolean;
  /** A3.4b: the background controller's counters (§8 `backgroundEnters`, `interruptions`); absent without one. */
  readonly health?: { readonly backgroundEnters: number; readonly interruptions: number } | null;
  /** A3.4b: whether the page is hidden. */
  readonly pageHidden?: boolean;
  /** The mixed cap selection runs at (A3.3: `min(voices.mixed, STATUS mixedCap)`); hand-built sources may omit it. */
  mixedCap?(): number;
  /** The clock map, for §8's timing figures in `core` (A3.2); hand-built test sources may omit it. */
  readonly clockMap?: Pick<ClockMap, "lookaheadFrames" | "leadFrames" | "rampFrames" | "anchored" | "rejected" | "reanchors"> & Partial<Pick<ClockMap, "framesNow">>;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** A voice's state as the API names it (§1 `AudioReason`, plus "playing"). STOPPING and ENDING voices still read as playing. */
function stateName(table: VoiceTable, i: number): VoiceStateName {
  switch (table.state[i]) {
    case VoiceState.LOCKED:
      return "locked";
    case VoiceState.WAITING_FOR_DATA:
      return "waitingForData";
    case VoiceState.VIRTUAL:
      // A3.1: selection makes a voice on a silent bus virtual with reason BUS_MUTED.
      return table.reason[i] === VoiceReason.BUS_MUTED ? "busMuted" : table.reason[i] === VoiceReason.WAITING_FOR_DATA ? "waitingForData" : "virtual";
    case VoiceState.PLAYING: {
      const reason = table.reason[i];
      if (reason === VoiceReason.BUS_MUTED) return "busMuted";
      if (reason === VoiceReason.WAITING_FOR_DATA) return "waitingForData";
      return "playing";
    }
    default:
      return "playing";
  }
}

/** @internal How long a steal stays listed in `Audio.debug()` ("stolen"), in selection frames (about 1 s at 60 fps). */
export const STOLEN_LISTED_FRAMES = 60;

/**
 * Playhead in seconds, for voices the core reports playheads for (`WANTS_PLAYHEAD`) whose clip rate is known. E3.9: an
 * event voice (the core reports none for clip voices) gets main's estimate (`PlayheadTracker`, wrapped in its loop or
 * clamped to the clip's end) once its PLAY has gone out.
 */
function playheadSeconds(backend: DebugSource, i: number, clip: ClipInfo | null): number | null {
  const table = backend.table;
  const rate = clip?.sampleRate ?? 0;
  if (!(rate > 0)) return null;
  if ((table.flags[i]! & VoiceFlag.WANTS_PLAYHEAD) !== 0) return table.playhead[i]! / rate;
  const tracker = backend.playheads;
  const now = backend.clockMap?.framesNow;
  const s = table.state[i];
  const sent = s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING || s === VoiceState.ENDING;
  if (table.group[i]! === 0 || !tracker || !now || !sent) return null;
  let pos = tracker.wrappedNow(i, now.call(backend.clockMap));
  const frames = clip?.frames ?? 0;
  if (frames > 0 && pos > frames) pos = frames;
  return Math.max(0, pos) / rate;
}

/** E3.9: bus `name`'s automation and its parents' (the core runs it; the mixer's resolve leaves it out), multiplied. */
function chainAutomation(backend: DebugSource, resolved: ReadonlyMap<string, { parent: string | null }>, name: string): number {
  const gainOf = backend.automation?.busAutomationGain;
  if (!gainOf) return 1;
  let g = 1;
  let n: string | null | undefined = name;
  for (let depth = 0; n && depth < 64; depth++) {
    g *= gainOf.call(backend.automation, n);
    n = resolved.get(n)?.parent;
  }
  return g;
}

/** The debug copy: the header fields and counters the backend has, plus one entry per bus and per live voice. */
export function buildDebugInfo(backend: DebugSource): AudioDebugInfo {
  const m = backend.mirror;
  const table = backend.table;
  const mixer = backend.mixer;
  const busNames = backend.busNames;
  const settingsBuses = mixer.audioSettings.buses;
  const resolved = new Map(mixer.resolveAll().map((b) => [b.name, b]));

  const buses: AudioDebugInfo["buses"] = busNames.map((name, b) => {
    const r = resolved.get(name);
    // E3.9: with the bus automation the core applies, as the Babylon fallback's mixer shows it.
    const own = backend.automation?.busAutomationGain?.(name) ?? 1;
    return {
      name,
      gain: (r?.gain ?? 0) * own,
      effectiveGain: (r?.effectiveGain ?? 0) * chainAutomation(backend, resolved, name),
      peakL: b < m.peakCount ? m.peakL[b]! : 0,
      peakR: b < m.peakCount ? m.peakR[b]! : 0,
      voices: table.busLive[b] ?? 0,
      maxVoices: settingsBuses[b]?.maxVoices ?? null,
      // ADR 0162 (A5): the bed rows, once a bed is laid out.
      ...(backend.beds && backend.beds.maxBeds > 0 ? backend.beds.busDebug(b) : {}),
    };
  });

  const voices: AudioDebugInfo["voices"] = [];
  const auto = { gain: 1, pitch: 1, lowpass: 0 };
  for (let i = 0; i < table.capacity; i++) {
    if (table.state[i] === VoiceState.FREE) continue;
    const stream = (table.flags[i]! & VoiceFlag.STREAM) !== 0 && backend.streams;
    const clip = stream ? backend.streams!.clipInfo(table.clip[i]!) : backend.clips.info(table.clip[i]!);
    const world = table.world[i]!;
    const owner = table.owner[i]!;
    // E3.9: an event voice's automated gain and pitch (main's estimate of the core's smoothed parameters) multiply in.
    const automated = backend.automation?.voiceAutomation?.(i, auto) === true;
    voices.push({
      id: ((table.gen[i]! << 16) | i) >>> 0,
      clip: clip?.path ?? "",
      bus: busNames[table.bus[i]!] ?? "",
      world: world === 0 ? null : String(world),
      state: stateName(table, i),
      priority: table.priority[i]!,
      gain: automated ? table.gain[i]! * auto.gain : table.gain[i]!,
      pitch: automated ? table.pitch[i]! * auto.pitch : table.pitch[i]!,
      audibility: clamp01(table.audibility[i]!),
      playheadSeconds: playheadSeconds(backend, i, clip),
      owner: owner < 0 ? null : String(owner),
      // ADR 0158 §5 (C3): the voice's event instance, from PLAY's `group`.
      event: table.group[i]! === 0 ? null : table.group[i]!,
    });
  }

  // A3.1: voices stolen in about the last second (the table's ring; their slots are already reused or free).
  for (let k = 0; k < table.stolenSize; k++) {
    const r = (table.stolenHead - 1 - k + 2 * table.stolenIds.length) % table.stolenIds.length;
    if (table.frame - table.stolenFrame[r]! > STOLEN_LISTED_FRAMES) break;
    const world = table.stolenWorld[r]!;
    voices.push({
      id: table.stolenIds[r]!,
      clip: backend.clips.info(table.stolenClip[r]!)?.path ?? "",
      bus: busNames[table.stolenBus[r]!] ?? "",
      world: world === 0 ? null : String(world),
      state: "stolen",
      priority: table.stolenPriority[r]!,
      gain: 0,
      pitch: 1,
      audibility: 0,
      playheadSeconds: null,
      owner: null,
      event: null,
    });
  }

  return {
    status: backend.status,
    sampleRate: backend.host.sampleRate,
    time: backend.time,
    background: backend.backgroundMode,
    counters: {
      underruns: m.underruns,
      lateCommands: m.lateCommands,
      minSlackFrames: m.minSlackFrames,
      workUnits: m.workUnits,
      workUnitsMax: m.workUnitsMax,
      mixedVoices: m.mixedVoices,
      // A3.3: the cap selection runs at (the core's adaptive cap, or `voices.mixed` before its first STATUS).
      mixedCap: backend.mixedCap ? backend.mixedCap() : m.mixedCap,
      logicalVoices: table.liveCount,
      queuedPlays: backend.lockedQueue.size,
      droppedPlays: table.refusedCount + backend.lockedQueue.droppedCount,
      // The host's count over every core (A3.4a): a rebuilt core's STATUS starts again at 0.
      traps: backend.host.health ? Math.max(backend.host.health.traps, m.traps) : m.traps,
      refusedLoads: 0,
      // H3: the voices the core panned with HRTF in its last STATUS quantum (crossfading ones included).
      hrtfVoices: m.hrtfVoices,
      // H3: 2 the core found the table invalid, 1 its fetch failed (main), 0 none.
      hrtfLoadFailure: backend.hrtfLoadFailure ?? m.hrtfLoadFailure,
      ...bedCounters(backend),
      // ADR 0162 B4 (C24): starves of wide (ambisonic) streams, from STATUS stream events.
      ...(backend.streams?.stats.wideStarved !== undefined ? { wideStarved: backend.streams.stats.wideStarved } : {}),
    },
    buses,
    voices,
    ...bedRows(backend),
    // `backend` names the backend the way babylonBackend does, so the panel can show it for either.
    core: { backend: "core", hrtfReady: backend.hrtfReady, ...hrtf(backend), ...timing(backend), ...hostHealth(backend), ...health(backend), ...streamHealth(backend), ...automation(backend) },
  };
}

/** ADR 0162 (A5, C24): the bed counters (`bedVoices`, `beds`, `bedsRefused` from STATUS; `bedDenied`, `bedSwitches`, `bedFilterLoadFailure` main's), once a bed is laid out. */
function bedCounters(backend: DebugSource): Record<string, number> {
  const planner = backend.beds;
  if (!planner || planner.maxBeds <= 0) return {};
  const m = backend.mirror;
  return {
    bedVoices: m.bedVoices,
    beds: m.bedCount,
    bedDenied: planner.counters.bedDenied,
    bedsRefused: m.bedsRefused,
    bedSwitches: backend.hrtf?.bedSwitches ?? 0,
    bedFilterLoadFailure: backend.maglsFailed ? 1 : 0,
  };
}

/** ADR 0162 (A5): `AudioDebugInfo.beds` (one row per hosted slot), left out while no bed is laid out. */
function bedRows(backend: DebugSource): { beds?: NonNullable<AudioDebugInfo["beds"]> } {
  const rows = backend.beds?.debug(backend.mirror);
  return rows ? { beds: rows } : {};
}

/** ADR 0158 (E3.1): curves defined, voices with bindings or a loop, and resync records still waiting, for `core`. */
function automation(backend: DebugSource): Record<string, number> {
  const c = backend.automation?.counts;
  return c ? { automationCurves: c.curves, automationVoices: c.voices, automationPending: c.pending } : {};
}

/** H3: how many voices main flags for HRTF (`hrtfFlagged`; the core's own count is `counters.hrtfVoices`). */
function hrtf(backend: DebugSource): Record<string, number> {
  return backend.hrtf ? { hrtfFlagged: backend.hrtf.count } : {};
}

/** B3: open streams, starves (STATUS stream events) and stream errors (the worker's and the core's) for `core`. */
function streamHealth(backend: DebugSource): Record<string, number> {
  const s = backend.streams;
  return s ? { streams: s.size, streamStarves: s.stats.starves, streamErrors: s.stats.errors + s.stats.coreErrors } : {};
}

/** Architecture §8 "Health" for `core` (A3.4b): the background controller's counters and the hidden state. */
function hostHealth(backend: DebugSource): Record<string, number | boolean> {
  const h = backend.health;
  if (!h) return {};
  return { backgroundEnters: h.backgroundEnters, interruptions: h.interruptions, pageHidden: !!backend.pageHidden };
}

/** Architecture §8 "Health" for `core` (A3.4a): rebuilds after a trap (`recoveries`) and for other reasons (`rebuilds`). */
function health(backend: DebugSource): Record<string, number> {
  const h = backend.host.health;
  return h ? { recoveries: h.recoveries, rebuilds: h.rebuilds } : {};
}

/** Architecture §8 "Timing" for `core` (A3.2): L and Λ, the ramp, the newest block's max lateness, the clock map's health. */
function timing(backend: DebugSource): Record<string, number | boolean> {
  const clock = backend.clockMap;
  if (!clock) return {};
  return {
    lookaheadFrames: clock.lookaheadFrames(),
    leadFrames: Math.round(clock.leadFrames),
    rampFrames: clock.rampFrames(),
    maxLatenessFrames: backend.mirror.maxLatenessFrames,
    clockAnchored: clock.anchored,
    clockRejected: clock.rejected,
    clockReanchors: clock.reanchors,
  };
}
