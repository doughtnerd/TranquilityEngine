// `Audio.debug()` for the core (K10; api-and-models §1 `AudioDebugInfo`; architecture §8). `coreBackend.debug()` calls
// `buildDebugInfo`, which reads the voice table, the status mirror, the mixer and the clip registry: nothing is
// stored here, so every call is a fresh copy.
import type { AudioBackground, AudioDebugInfo, AudioMemoryDebug, AudioM3Counters, AudioStatus, AudioVoiceM3Debug, MusicDebugRow, MusicDebugState, MusicDebugTotals } from "../backend";
import { ticksToPosition, spanAtTicks } from "../../../../engine/audio/musicGrid";
import { playingGridOf, ticksAt } from "../music/anchors";
import { musicPlayers, type MusicPlayer, type MusicPlayerState } from "../music/musicSystem";
import type { Mixer } from "../../../../engine/audio/mixer";
import { MAX_BUSES } from "../../../../engine/audio/settings";
import { AUX_BUS_NONE } from "../wire.generated";
import { spatialRegionsBytes, zoneKernelBudgetBytes, zoneMaxFrames, zonesRegionBytes, type CorePreset } from "../worklet/coreDriver";
import type { ClipInfo } from "./clipRegistry";
import type { ClockMap } from "./clock";
import type { CoreMusicOps } from "./musicOps";
import type { BedPlanner } from "./beds";
import type { StatusMirror } from "./mirror";
import type { DopplerPass } from "./doppler";
import type { OcclusionPass } from "./occlusion";
import { pannerName, PannerKind, type PannerPick } from "./pannerPick";
import { LowpassBy, type VoiceFx } from "./voiceFx";
import type { ZoneManager } from "./zones";
import type { PlayheadTracker } from "./replay";
import { VoiceFlag, VoiceFlag2, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";

export type { AudioDebugInfo };

type VoiceStateName = AudioDebugInfo["voices"][number]["state"];

/** What `buildDebugInfo` reads of the backend: `CoreBackend` satisfies it, and tests build it by hand. */
export interface DebugSource {
  /** `health` (A3.4a): the host's traps, recoveries and rebuilds over every core it ran; absent in hand-built sources. */
  readonly host: {
    readonly sampleRate: number;
    readonly health?: { readonly traps: number; readonly recoveries: number; readonly rebuilds: number };
    /** ADR 0162 D5: the regions the core was laid out with, for `memory`; absent in hand-built sources. */
    readonly preset?: { readonly maxMixed?: number; readonly maxBeds?: number; readonly maxZoneSlots?: number; readonly zoneMaxSeconds?: number; readonly maxWide?: number };
  };
  readonly status: AudioStatus;
  readonly time: number;
  readonly backgroundMode: AudioBackground;
  /** Bus names by bus index (root first), as the core was last configured. */
  readonly busNames: readonly string[];
  readonly mirror: StatusMirror;
  readonly table: VoiceTable;
  readonly clips: { info(id: number): ClipInfo | null };
  /** Each slot's playing node name (`PlayRequest.owner`), for the voice rows' `owner`; absent in hand-built sources. */
  readonly owners?: readonly (string | null)[];
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
  readonly beds?: Pick<BedPlanner, "maxBeds" | "counters" | "debug" | "busDebug" | "bedSlot">;
  /** ADR 0162 D5: the panner pick (voice rows' `panner`, `bed`, `kindDwellMs`); absent in hand-built sources. */
  readonly panners?: Pick<PannerPick, "kindOf" | "dwellMs">;
  /** ADR 0162 D5: per-voice fx targets (voice rows' `filter`, `sends`, `aux`); absent in hand-built sources. */
  readonly voiceFx?: Pick<VoiceFx, "lowpass" | "lowpassBy" | "highpass" | "send" | "auxBus" | "auxLevel">;
  /** ADR 0162 C5 (D5): the zone manager (`zones[]`, the zone counters); absent in hand-built sources. */
  readonly zones?: Pick<ZoneManager, "debug" | "counters">;
  /** ADR 0162 D2a (D5): the occlusion pass (`occlusion`, voice rows' `occlusion`, its counters); absent in hand-built sources. */
  readonly occlusion?: Pick<OcclusionPass, "debug" | "voiceDebug" | "counters">;
  /** ADR 0162 D3 (D5): the Doppler pass (`doppler` per voice, its counters); absent in hand-built sources. */
  readonly doppler?: Pick<DopplerPass, "counters" | "factor">;
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
  /**
   * ADR 0166 §1.6, C11 (Q2's hook; P10 builds `music` and `musicTotals` from it and the players, `music/musicSystem.ts`
   * `musicPlayers()`): the core's side of music (pool, groups); absent in hand-built sources.
   */
  readonly musicOps?: Pick<CoreMusicOps, "debugView" | "primeEmaMs"> & Partial<Pick<CoreMusicOps, "clipInfo">>;
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
  const zoneRows = backend.zones?.debug();
  const auto = { gain: 1, pitch: 1, lowpass: 0 };
  for (let i = 0; i < table.capacity; i++) {
    if (table.state[i] === VoiceState.FREE) continue;
    const stream = (table.flags[i]! & VoiceFlag.STREAM) !== 0 && backend.streams;
    // F-16: a music group member's stream is musicOps's, not the stream manager's.
    const clip = stream ? (backend.streams!.clipInfo(table.clip[i]!) ?? backend.musicOps?.clipInfo?.(table.clip[i]!) ?? null) : backend.clips.info(table.clip[i]!);
    const world = table.world[i]!;
    // E3.9: an event voice's automated gain and pitch (main's estimate of the core's smoothed parameters) multiply in.
    const automated = backend.automation?.voiceAutomation?.(i, auto) === true;
    voices.push({
      id: ((table.gen[i]! << 16) | i) >>> 0,
      clip: clip?.path ?? "",
      bus: busNames[table.bus[i]!] ?? "",
      world: world === 0 ? null : String(world),
      state: stateName(table, i),
      priority: table.priority[i]!,
      // F-9b: a music stem's level (quantised automation, solo) multiplies in, as in its audibility.
      gain: (automated ? table.gain[i]! * auto.gain : table.gain[i]!) * table.stemGain[i]!,
      pitch: automated ? table.pitch[i]! * auto.pitch : table.pitch[i]!,
      audibility: clamp01(table.audibility[i]!),
      playheadSeconds: playheadSeconds(backend, i, clip),
      owner: backend.owners?.[i] ?? null,
      // ADR 0158 §5 (C3): the voice's event instance, from PLAY's `group`.
      event: table.group[i]! === 0 ? null : table.group[i]!,
      // ADR 0162 §1.6 (D5): the voice's M3 columns.
      ...voiceM3(backend, i, zoneRows, automated ? auto.lowpass : 0),
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
      ...m3Counters(backend),
      // ADR 0162 B4 (C24): starves of wide (ambisonic) streams, from STATUS stream events.
      ...(backend.streams?.stats.wideStarved !== undefined ? { wideStarved: backend.streams.stats.wideStarved } : {}),
    },
    buses,
    voices,
    ...bedRows(backend),
    ...m3Rows(backend, zoneRows),
    // `backend` names the backend the way babylonBackend does, so the panel can show it for either.
    music: musicRows(backend),
    musicTotals: musicTotals(backend),
    core: { backend: "core", hrtfReady: backend.hrtfReady, ...hrtf(backend), ...timing(backend), ...hostHealth(backend), ...health(backend), ...streamHealth(backend), ...automation(backend), ...ladder(backend) },
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

/**
 * ADR 0162 §1.6, C24 (D5): the counters of the parts that run on every core backend: `fxVoices`, `ambisonicVoices` and
 * `m3Shed` from STATUS, and each pass's own (zones, occlusion, Doppler) when the backend has it.
 */
function m3Counters(backend: DebugSource): AudioM3Counters {
  const m = backend.mirror;
  const out: AudioM3Counters = { fxVoices: m.fxVoices, ambisonicVoices: m.ambisonicVoices, m3Shed: m.m3Shed };
  const z = backend.zones;
  if (z) {
    out.zonesActive = m.zonesActive;
    out.zonesRinging = m.zonesRinging;
    out.zonesFaded = z.counters.zonesFaded;
    out.zoneMemoryKB = m.zoneUsedKB;
    out.kernelRefused = z.counters.kernelRefused;
    out.irFailures = z.counters.irFailures;
    out.irTruncated = z.counters.irTruncated;
    out.irPrepares = z.counters.irPrepares;
    // Kernels are always prepared by the decoder worker (`zones[].by`); the core's own path doesn't exist on main yet.
    out.irPrepInCore = 0;
  }
  const o = backend.occlusion?.counters;
  if (o) {
    out.occlusionRays = o.occlusionRays;
    out.occlusionUsedMs = o.occlusionUsedMs;
    out.occlusionOverruns = o.occlusionOverruns;
    out.occlusionSources = o.occlusionSources;
    out.occlusionNoPhysics = o.occlusionNoPhysics;
    out.oldestOcclusionAgeFrames = o.oldestOcclusionAgeFrames;
  }
  const d = backend.doppler?.counters;
  if (d) {
    out.dopplerClamps = d.dopplerClamps;
    out.dopplerTeleports = d.dopplerTeleports;
    out.dopplerGuardTrips = d.dopplerGuardTrips;
  }
  return out;
}

/** ADR 0162 §1.6 (D5): `zones[]` (while a zone slot is laid out), `occlusion` and `memory`. */
function m3Rows(backend: DebugSource, zoneRows: ReturnType<ZoneManager["debug"]>): Pick<AudioDebugInfo, "zones" | "occlusion" | "memory"> {
  const out: Pick<AudioDebugInfo, "zones" | "occlusion" | "memory"> = {};
  if (zoneRows) out.zones = zoneRows;
  if (backend.occlusion) out.occlusion = backend.occlusion.debug();
  const memory = memoryRow(backend);
  if (memory) out.memory = memory;
  return out;
}

/** A preset with nothing laid out, which `spatialRegionsBytes` takes the parts of (it reads only the fields set here). */
function emptyPreset(maxBeds: number, maxWide: number): CorePreset {
  return { maxBeds, maxWide, maxZoneSlots: 0, zoneMaxSeconds: 0, maxMixed: 0, maxBuses: MAX_BUSES, maxLogical: 0, arenaInitialBytes: 0, clipCeilingBytes: 0, limiterLookaheadMs: 0, maxMusicRings: 0 };
}

/**
 * ADR 0162 §1.6 `memory` (D5), bytes, from the preset the core was laid out with and `coreDriver.ts`'s layout mirror
 * (which `coreDriver.test.ts` checks against the wasm's own figures). The mirror exports the regions' sum, so the parts
 * are differences of it: `beds` is the `Beds` region for the bed slots and the private decoders (a wide stream's),
 * `wideRings` the rings without those decoders, `zones` the `Zones` region, `kernels` the kernels resident now (STATUS
 * `zoneUsedKB`) and `kernelBudget` the arena the preset reserves for them.
 */
function memoryRow(backend: DebugSource): AudioMemoryDebug | undefined {
  const p = backend.host.preset;
  if (!p) return undefined;
  const rate = backend.host.sampleRate;
  const maxBeds = p.maxBeds ?? 0;
  const maxWide = p.maxWide ?? 0;
  const slots = p.maxZoneSlots ?? 0;
  const base = spatialRegionsBytes(emptyPreset(0, 0), rate);
  const bedSlots = spatialRegionsBytes(emptyPreset(maxBeds + maxWide, 0), rate) - base;
  const wideRings = spatialRegionsBytes(emptyPreset(0, maxWide), rate) - spatialRegionsBytes(emptyPreset(maxWide, 0), rate);
  const frames = zoneMaxFrames({ ...emptyPreset(0, 0), maxZoneSlots: slots, zoneMaxSeconds: p.zoneMaxSeconds ?? 0 }, rate);
  return {
    beds: bedSlots,
    zones: zonesRegionBytes(slots, frames, MAX_BUSES),
    kernels: backend.mirror.zoneUsedKB * 1024,
    kernelBudget: zoneKernelBudgetBytes(slots, frames),
    wideRings,
  };
}

/** ADR 0162 §1.6 (D5): voice `i`'s M3 columns. `automationLowpass` is the event automation's low-pass now (0: none). */
function voiceM3(backend: DebugSource, i: number, zoneRows: ReturnType<ZoneManager["debug"]>, automationLowpass: number): AudioVoiceM3Debug {
  const table = backend.table;
  const out: AudioVoiceM3Debug = {};
  const panners = backend.panners;
  if (panners) {
    const kind = panners.kindOf(i);
    out.panner = pannerName(kind, (table.flags[i]! & VoiceFlag.SPATIAL) !== 0, (table.flags2[i]! & VoiceFlag2.AMBISONIC) !== 0);
    const slot = kind === PannerKind.BED ? (backend.beds?.bedSlot[table.bus[i]!] ?? 0xff) : 0xff;
    out.bed = slot === 0xff ? null : slot;
    out.kindDwellMs = panners.dwellMs(i);
  }
  if (backend.doppler) out.doppler = backend.doppler.factor[i]!;
  const occ = backend.occlusion?.voiceDebug(i);
  if (occ) out.occlusion = occ;
  const fx = backend.voiceFx;
  if (fx) {
    let lowpassHz = fx.lowpass(i);
    let by: NonNullable<AudioVoiceM3Debug["filter"]>["lowpassBy"] = null;
    switch (fx.lowpassBy(i)) {
      case LowpassBy.OCCLUSION: by = "occlusion"; break;
      case LowpassBy.EVENT: by = "event"; break;
      case LowpassBy.SNAPSHOT: by = "snapshot"; break;
    }
    if (automationLowpass > 0 && automationLowpass < lowpassHz) {
      lowpassHz = automationLowpass;
      by = "automation";
    }
    out.filter = { lowpassHz, highpassHz: fx.highpass(i), lowpassBy: by };
    const sends: { zone: string; level: number }[] = [];
    for (let k = 0; k < 4; k++) {
      const level = fx.send(i, k);
      if (!(level > 0)) continue;
      sends.push({ zone: zoneRows?.find((z) => z.slot === k)?.node ?? `slot ${k}`, level });
    }
    out.sends = sends;
    const auxBus = fx.auxBus(i);
    const auxLevel = fx.auxLevel(i);
    out.aux = auxBus !== AUX_BUS_NONE && auxLevel > 0 ? { bus: backend.busNames[auxBus] ?? "", level: auxLevel } : null;
  }
  return out;
}

/** @internal The adaptive cap's floor: the ladder only runs once the cap sits here (architecture §7.3). */
const LADDER_FLOOR = 16;

/** ADR 0162 OD3 (D5): the load-shedding ladder for `core`: "idle", "cap at floor" (its precondition), or "shedding" with the step count. */
function ladder(backend: DebugSource): Record<string, string> {
  const steps = backend.mirror.m3Shed;
  if (steps > 0) return { ladderState: `shedding (${steps} ${steps === 1 ? "step" : "steps"})` };
  const cap = backend.mixedCap ? backend.mixedCap() : backend.mirror.mixedCap;
  const configured = backend.host.preset?.maxMixed ?? Infinity;
  return { ladderState: cap > 0 && cap <= Math.min(LADDER_FLOOR, configured) ? "cap at floor" : "idle" };
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

// --- ADR 0166 (P10): `music` rows and `musicTotals` (api-and-models §1.6, architecture §9) ------------------------------

/** The player's lifecycle as the row's `state` (§1.6): a pending change still plays, so it reads `playing` with `pending` set. */
function musicState(s: MusicPlayerState): MusicDebugState {
  switch (s) {
    case "playing":
    case "pending":
      return "playing";
    case "transitioning":
      return "transitioning";
    case "recovering":
      return "recovering";
    case "stopping":
    case "stopped":
    case "refused":
      return "ending";
    default:
      return "priming"; // starting, waiting, committed
  }
}

/** One `MusicDebugRow` of a player, read at heard time `now`. Copies the counters, so a row is a snapshot. */
function musicRow(p: MusicPlayer, now: number, groups: MusicView): MusicDebugRow {
  const c = p.counters;
  const a = p.anchor;
  let bar = 1, beat = 1, tick = 0, tempo = 0, beatsPerBar = 0;
  const pg = a ? playingGridOf(a) : null;
  if (a && pg) {
    const ticks = ticksAt(a, now);
    const pos = Number.isFinite(ticks) ? ticksToPosition(pg.grid, ticks) : null;
    if (pos) ({ bar, beat, tick } = pos);
    const i = spanAtTicks(pg.grid, Number.isFinite(ticks) ? ticks : 0);
    tempo = pg.grid.bpm[i]!;
    beatsPerBar = pg.grid.beatsPerBar[i]!;
  }
  const t = p.transition;
  const m = t?.match;
  const groupIds = new Set<number>();
  if (p.run && p.run.group) groupIds.add(p.run.group);
  if (p.next && p.next.group) groupIds.add(p.next.group);
  let ring = 0;
  return {
    id: p.instance.group,
    asset: p.instance.path,
    state: musicState(p.state),
    segment: p.run?.node.id ?? null,
    pass: a?.pass ?? 1,
    bar, beat, tick, tempo, beatsPerBar,
    time: now,
    // Past T - L (`running`, `bridging`) the change is still on its way until it lands, as `handle.music.transition` says.
    pending: t && m && t.state !== "done" && t.state !== "cancelled"
      ? { to: t.to.id, time: pg && Number.isFinite(t.exitAt) ? positionText(pg.grid, ticksAt(a!, t.exitAt)) : "", rule: m.rule, ruleKey: m.ruleKey, tier: m.tier, parent: m.parent, exit: m.exit, enter: m.enter }
      : null,
    groups: groups.groups.filter((g) => groupIds.has(g.id)).map((g) => ({ id: g.id, state: g.state, primed: g.primed, of: g.of })),
    // The pool index of a stem's ring isn't kept by main (the core allocates it); streamed stems number in order.
    stems: (p.run?.stems ?? []).map((s) => ({ name: s.track, primed: s.primed, streamed: s.streamed, ring: s.streamed ? ring++ : null })),
    primeLastMs: c.primeLastMs,
    primeEmaMs: groups.primeEmaMs,
    leadMs: c.leadMs,
    replans: { ...c.replans },
    refusals: { ...c.refusals },
    lateGroups: c.lateGroups,
    groupsHeld: c.groupsHeld,
    groupTimeouts: c.groupTimeouts,
    lastSlipFrames: c.lastSlipFrames,
    recoveries: { ...c.recoveries },
    missedBeats: c.missedBeats,
    stingers: { ...c.stingers },
  };
}

function positionText(grid: Parameters<typeof ticksToPosition>[0], ticks: number): string {
  const pos = Number.isFinite(ticks) ? ticksToPosition(grid, ticks) : null;
  return pos ? `${pos.bar}:${pos.beat}` : "";
}

type MusicView = { poolUsed: number; poolSize: number; poolHighWater: number; musicRingRefused: number; groups: readonly { id: number; state: MusicDebugRow["groups"][number]["state"]; primed: number; of: number }[]; primeEmaMs: number; groupTableFull?: number; encodedOverBudget?: number };

/** The core's music view merged with Ê; an empty view when the source has no music ops. */
function musicView(backend: DebugSource): MusicView {
  const v = backend.musicOps?.debugView();
  return { poolUsed: 0, poolSize: 0, poolHighWater: 0, musicRingRefused: 0, groups: [], primeEmaMs: backend.musicOps?.primeEmaMs ?? 0, ...v };
}

function musicRows(backend: DebugSource): MusicDebugRow[] {
  const players = musicPlayers();
  if (players.length === 0) return [];
  const view = musicView(backend);
  return players.map((p) => musicRow(p, backend.time, view));
}

function musicTotals(backend: DebugSource): MusicDebugTotals {
  const m = backend.mirror;
  const v = musicView(backend);
  return {
    poolUsed: v.poolUsed,
    poolSize: v.poolSize,
    poolHighWater: v.poolHighWater,
    musicRingRefused: v.musicRingRefused,
    streamStartsLate: m.streamStartsLate,
    maxSlipFrames: m.maxSlipFrames,
    splitQuanta: m.splitQuanta,
    voiceSplits: m.voiceSplits,
    curvePoolFull: m.curvePoolFull,
    groupTableFull: v.groupTableFull ?? 0,
    encodedOverBudget: v.encodedOverBudget ?? 0,
  };
}
