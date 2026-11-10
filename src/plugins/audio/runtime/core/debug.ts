// `Audio.debug()` for the core (K10; api-and-models §1 `AudioDebugInfo`; architecture §8). `coreBackend.debug()` calls
// `buildDebugInfo`, which reads the voice table, the status mirror, the mixer and the clip registry: nothing is
// stored here, so every call is a fresh copy.
import type { AudioBackground, AudioDebugInfo, AudioStatus } from "../backend";
import type { Mixer } from "../../../../engine/audio/mixer";
import type { ClipInfo } from "./clipRegistry";
import type { StatusMirror } from "./mirror";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";

export type { AudioDebugInfo };

type VoiceStateName = AudioDebugInfo["voices"][number]["state"];

/** What `buildDebugInfo` reads of the backend: `CoreBackend` satisfies it, and tests build it by hand. */
export interface DebugSource {
  readonly host: { readonly sampleRate: number };
  readonly status: AudioStatus;
  readonly time: number;
  readonly backgroundMode: AudioBackground;
  /** Bus names by bus index (root first), as the core was last configured. */
  readonly busNames: readonly string[];
  readonly mirror: StatusMirror;
  readonly table: VoiceTable;
  readonly clips: { info(id: number): ClipInfo | null };
  readonly mixer: Pick<Mixer, "resolveAll" | "audioSettings">;
  readonly lockedQueue: { readonly size: number; readonly droppedCount: number };
  readonly hrtfReady: boolean;
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
      return "virtual";
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
    const clip = backend.clips.info(table.clip[i]!);
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
      mixedCap: m.mixedCap,
      logicalVoices: table.liveCount,
      queuedPlays: backend.lockedQueue.size,
      droppedPlays: table.refusedCount + backend.lockedQueue.droppedCount,
      traps: m.traps,
      refusedLoads: 0,
      hrtfVoices: m.hrtfVoices,
      hrtfLoadFailure: m.hrtfLoadFailure,
    },
    buses,
    voices,
    // `backend` names the backend the way babylonBackend does, so the panel can show it for either.
    core: { backend: "core", hrtfReady: backend.hrtfReady },
  };
}
