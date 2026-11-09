// `Audio.debug()` for the core (K10; api-and-models §1 `AudioDebugInfo`; architecture §8). A1.4 ships the stub that
// `coreBackend.debug()` calls; A2.5 fills it from the mirror and the voice table. Nothing else here: A2.5 owns this file.
import type { CoreBackend } from "./coreBackend";

/** §1 `AudioDebugInfo`, declared here until A1.6 declares the public surface (K10) and re-exports it. */
export interface AudioDebugInfo {
  status: "locked" | "running" | "failed";
  sampleRate: number;
  time: number;
  background: "mute" | "pause" | "play";
  counters: { underruns: number; lateCommands: number; minSlackFrames: number; workUnits: number; workUnitsMax: number; mixedVoices: number; mixedCap: number; logicalVoices: number; queuedPlays: number; droppedPlays: number; traps: number; refusedLoads: number; hrtfVoices: number; hrtfLoadFailure: number };
  buses: { name: string; gain: number; effectiveGain: number; peakL: number; peakR: number; voices: number; maxVoices: number | null }[];
  voices: { id: number; clip: string; bus: string; world: string | null; state: "playing" | "virtual" | "stolen" | "waitingForData" | "busMuted" | "locked"; priority: number; gain: number; pitch: number; audibility: number; playheadSeconds: number | null; owner: string | null }[];
  /** Architecture 8: context state, latencies, lookahead, transport, memory and health groups. */
  core: Record<string, number | string | boolean>;
}

/** The stub: the header fields and counters the backend already has, with empty `buses` and `voices`. A2.5 fills the rest. */
export function buildDebugInfo(backend: CoreBackend): AudioDebugInfo {
  void backend;
  throw new Error("not implemented: A2.5 (buildDebugInfo)");
}
