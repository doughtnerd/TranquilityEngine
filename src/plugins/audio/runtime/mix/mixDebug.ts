// ADR 0171 amended by 0172 (M5, Dbg1; api-and-models §1.3, §9): the `Audio.debug().mix` section, built the same way for the
// core backend (from STATUS and the live-edit counters) and the Babylon fallback (the inert shape). Pure: reads the
// mixer's settings and the numbers it is handed, stores nothing, so every call is a fresh copy.
import type { Mixer } from "../../../../engine/audio/mixer";
import type { AudioCpuDebug, AudioMixDebug } from "../backend";

/** What the mix section reads. */
export interface MixDebugInput {
  /** Bus names by slot (the identity layout until Ma1 wires the slot table in). */
  names: readonly string[];
  mixer: Pick<Mixer, "audioSettings" | "monitorActive" | "bus">;
  /** STATUS `busDuck`: the duck lane's gain of bus slot `slot`, or null when the newest block has no entry for it (main's value is read instead). */
  duckOfSlot?: (slot: number) => number | null;
  /** STATUS `loudShed`: nonzero while the ladder's loudness step is in force. */
  loudShed: number;
  busRecordsEarly: number;
  sidechainLate: number;
  liveRefused: number;
  liveDeferred: number;
  liveDeferredPending: number;
}

/** `Audio.debug().mix`: a fresh object. */
export function buildMixDebug(i: MixDebugInput): AudioMixDebug {
  const { names, mixer } = i;
  let metersPaused = 0;
  for (const name of names) if (mixer.bus(name).loudness.paused) metersPaused++;
  const ducking: AudioMixDebug["ducking"] = [];
  for (const r of mixer.audioSettings.ducking) {
    const slot = names.indexOf(r.target);
    const status = slot >= 0 && i.duckOfSlot ? i.duckOfSlot(slot) : null;
    ducking.push({ target: r.target, trigger: r.trigger, mode: r.mode === "level" ? "level" : "presence", gain: status ?? mixer.bus(r.target).duckGain });
  }
  return {
    slots: names.map((name, slot) => ({ name, slot, state: "live" as const })),
    monitorActive: mixer.monitorActive,
    metersPaused,
    loudnessLadderStep: i.loudShed !== 0 ? 1 : 0,
    busRecordsEarly: i.busRecordsEarly,
    sidechainLate: i.sidechainLate,
    liveRefused: i.liveRefused,
    liveDeferred: i.liveDeferred,
    liveDeferredPending: i.liveDeferredPending,
    ducking,
  };
}

/** Why the Babylon fallback has no CPU figure (§9; also `mixCaps.cpuReason`). */
export const BABYLON_CPU_REASON = "Babylon fallback has no audio core";

/** The fallback's `Audio.debug().cpu` (§9): no figure, with the reason in `hidden`. */
export function babylonCpuDebug(): AudioCpuDebug {
  return { loadPermille: null, windowMs: 0, clockStepMs: 0, clockSteps: 0, refitResidual: null, sections: null, hidden: BABYLON_CPU_REASON };
}

/** The fallback's `Audio.debug().mix` (§9): there is no core, so every STATUS counter reads 0 and no live edit is refused or deferred. */
export function babylonMixDebug(mixer: MixDebugInput["mixer"], names: readonly string[]): AudioMixDebug {
  return buildMixDebug({ names, mixer, loudShed: 0, busRecordsEarly: 0, sidechainLate: 0, liveRefused: 0, liveDeferred: 0, liveDeferredPending: 0 });
}
