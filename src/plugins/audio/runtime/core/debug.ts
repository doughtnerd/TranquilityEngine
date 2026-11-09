// `Audio.debug()` for the core (K10; api-and-models §1 `AudioDebugInfo`; architecture §8). A1.4 ships the stub that
// `coreBackend.debug()` calls; A2.5 fills it from the mirror and the voice table. Nothing else here: A2.5 owns this file.
import type { AudioDebugInfo } from "../../../../engine/audio/backend";
import type { CoreBackend } from "./coreBackend";

export type { AudioDebugInfo };

/** The stub: the header fields and counters the backend already has, with empty `buses` and `voices`. A2.5 fills the rest. */
export function buildDebugInfo(backend: CoreBackend): AudioDebugInfo {
  const m = backend.mirror;
  return {
    status: backend.status,
    sampleRate: backend.host.sampleRate,
    time: backend.time,
    background: "mute",
    counters: {
      underruns: m.underruns,
      lateCommands: m.lateCommands,
      minSlackFrames: m.minSlackFrames,
      workUnits: m.workUnits,
      workUnitsMax: m.workUnitsMax,
      mixedVoices: m.mixedVoices,
      mixedCap: m.mixedCap,
      logicalVoices: backend.table.liveCount,
      queuedPlays: 0,
      droppedPlays: backend.table.refusedCount,
      traps: m.traps,
      refusedLoads: 0,
      hrtfVoices: m.hrtfVoices,
      hrtfLoadFailure: m.hrtfLoadFailure,
    },
    buses: [],
    voices: [],
    core: {},
  };
}
