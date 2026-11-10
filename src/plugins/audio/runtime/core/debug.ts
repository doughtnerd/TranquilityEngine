// `Audio.debug()` for the core (K10; api-and-models §1 `AudioDebugInfo`; architecture §8). `coreBackend.debug()` calls
// `buildDebugInfo`, which reads the voice table, the status mirror, the mixer and the clip registry: nothing is
// stored here, so every call is a fresh copy.
import type { AudioBackground, AudioDebugInfo, AudioStatus } from "../backend";
import type { Mixer } from "../../../../engine/audio/mixer";
import type { ClipInfo } from "./clipRegistry";
import type { ClockMap } from "./clock";
import type { StatusMirror } from "./mirror";
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
  readonly streams?: { clipInfo(id: number): ClipInfo | null; readonly size: number; readonly stats: { readonly starves: number; readonly errors: number; readonly coreErrors: number } };
  readonly mixer: Pick<Mixer, "resolveAll" | "audioSettings">;
  readonly lockedQueue: { readonly size: number; readonly droppedCount: number };
  /** ADR 0158 (E3.1): the automation mirror's counts; absent in hand-built sources. */
  readonly automation?: { readonly counts: { readonly curves: number; readonly voices: number; readonly pending: number } };
  readonly hrtfReady: boolean;
  /** H3: STATUS `hrtfLoadFailure` with main's fetch failure (1); absent in hand-built sources (STATUS's alone). */
  readonly hrtfLoadFailure?: number;
  /** H3: voices main flags for HRTF this frame (at most `voices.hrtf`); absent in hand-built sources. */
  readonly hrtf?: { readonly count: number };
  /** A3.4b: the background controller's counters (§8 `backgroundEnters`, `interruptions`); absent without one. */
  readonly health?: { readonly backgroundEnters: number; readonly interruptions: number } | null;
  /** A3.4b: whether the page is hidden. */
  readonly pageHidden?: boolean;
  /** The mixed cap selection runs at (A3.3: `min(voices.mixed, STATUS mixedCap)`); hand-built sources may omit it. */
  mixedCap?(): number;
  /** The clock map, for §8's timing figures in `core` (A3.2); hand-built test sources may omit it. */
  readonly clockMap?: Pick<ClockMap, "lookaheadFrames" | "leadFrames" | "rampFrames" | "anchored" | "rejected" | "reanchors">;
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

/** Playhead in seconds, only for voices the core reports playheads for (`WANTS_PLAYHEAD`) whose clip rate is known. */
function playheadSeconds(table: VoiceTable, i: number, clip: ClipInfo | null): number | null {
  if ((table.flags[i]! & VoiceFlag.WANTS_PLAYHEAD) === 0) return null;
  const rate = clip?.sampleRate ?? 0;
  return rate > 0 ? table.playhead[i]! / rate : null;
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
    return {
      name,
      gain: r?.gain ?? 0,
      effectiveGain: r?.effectiveGain ?? 0,
      peakL: b < m.peakCount ? m.peakL[b]! : 0,
      peakR: b < m.peakCount ? m.peakR[b]! : 0,
      voices: table.busLive[b] ?? 0,
      maxVoices: settingsBuses[b]?.maxVoices ?? null,
    };
  });

  const voices: AudioDebugInfo["voices"] = [];
  for (let i = 0; i < table.capacity; i++) {
    if (table.state[i] === VoiceState.FREE) continue;
    const stream = (table.flags[i]! & VoiceFlag.STREAM) !== 0 && backend.streams;
    const clip = stream ? backend.streams!.clipInfo(table.clip[i]!) : backend.clips.info(table.clip[i]!);
    const world = table.world[i]!;
    const owner = table.owner[i]!;
    voices.push({
      id: ((table.gen[i]! << 16) | i) >>> 0,
      clip: clip?.path ?? "",
      bus: busNames[table.bus[i]!] ?? "",
      world: world === 0 ? null : String(world),
      state: stateName(table, i),
      priority: table.priority[i]!,
      gain: table.gain[i]!,
      pitch: table.pitch[i]!,
      audibility: clamp01(table.audibility[i]!),
      playheadSeconds: playheadSeconds(table, i, clip),
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
    },
    buses,
    voices,
    // `backend` names the backend the way babylonBackend does, so the panel can show it for either.
    core: { backend: "core", hrtfReady: backend.hrtfReady, ...hrtf(backend), ...timing(backend), ...hostHealth(backend), ...health(backend), ...streamHealth(backend), ...automation(backend) },
  };
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
