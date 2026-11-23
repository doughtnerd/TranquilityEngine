// The Mixer's one door to the Studio's running audio (ADR 0341 "A seam for the live link", ADR 0171/0172): readings
// through the host's public `Audio` API (`Audio.bus(name)`: peak, runtime volume, duck gain, voices, loudness),
// parameters and snapshot auditions through it too, and the live-mix path the editor's Mixer panel uses (`mixer.apply`,
// `mixer.setMonitor`, the backend's `flushNow`, the loudness hub's taint and Compare marks, `Audio.loudnessTarget`).
// Everything the Mixer does to the runtime goes through here, so the live link can stand in for it later.
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { mixer } from "../../../engine/audio/mixer";
import type { OcclusionCurves } from "../../../engine/audio/occlusionCurves";
import { Audio } from "../../../plugins/audio/runtime/Audio";
import { audioBackend } from "../../../plugins/audio/runtime/backend";
import { loudnessHub } from "../../../plugins/audio/runtime/mix/loudnessHub";
import { audioHost } from "../../shell/studioServices";
import type { BusReading, LoudnessReading } from "./boardModel";
import type { LiveMixHost } from "./liveMix";

/** The runtime is up (running, or waiting for the click that unlocks audio). */
export function runtimeRunning(): boolean {
  try {
    return audioHost().playable.peek();
  } catch {
    return false; // stories and tests: no runtime
  }
}

/** A bus's live reading, or null when the runtime isn't up or has no such bus. */
export function readBus(name: string): BusReading | null {
  if (!runtimeRunning()) return null;
  const b = audioHost().audio.bus(name);
  if (!b.exists) return null;
  return { volume: b.volume, duckGain: b.duckGain, peak: b.peak, activeVoices: b.activeVoices };
}

/** A bus's loudness readings (Master's by default), or null when not running or unmetered. */
export function readLoudness(name: string): LoudnessReading | null {
  if (!runtimeRunning()) return null;
  const l = audioHost().audio.bus(name).loudness;
  if (!l.metered) return null;
  return { momentary: l.momentary, shortTerm: l.shortTerm, integrated: l.integrated, lra: l.lra, maxTruePeak: l.maxTruePeak, tainted: l.tainted };
}

/** Reset the loudness meters of every metered bus. */
export function resetLoudness(): void {
  if (!runtimeRunning()) return;
  for (const n of mixer.busNames) mixer.bus(n).loudness.reset("all");
}

/** The target the meters check against (session state, `Audio.loudnessTarget`). */
export function loudnessTarget(): string | null {
  return runtimeRunning() ? Audio.loudnessTarget : null;
}
export function setLoudnessTarget(name: string | null): void {
  if (runtimeRunning()) Audio.loudnessTarget = name;
}

/** A game parameter's test value into the runtime (labelled parameters by label). */
export function setRuntimeParameter(name: string, value: number | string): void {
  if (runtimeRunning()) audioHost().audio.setParameter(name, value);
}

/**
 * Audition a snapshot in the runtime (null: back to the plain mix): the shorthand (`Audio.snapshot(name, fade)`), which
 * fades out the other snapshots started from code; base and conditions snapshots keep blending with it (ADR 0344).
 */
export function auditionSnapshot(name: string | null, fadeSeconds: number): void {
  if (!runtimeRunning()) return;
  if (name === null) audioHost().audio.clearSnapshot(fadeSeconds);
  else audioHost().audio.snapshot(name, fadeSeconds);
}

/**
 * ADR 0362 item 6: the occlusion curves the running occlusion pass uses (null: none, the materials' losses as they are),
 * through the live op `setOcclusionCurves`. False when the runtime isn't up or refused them.
 */
export function setRuntimeOcclusionCurves(curves: OcclusionCurves | null): boolean {
  if (!runtimeRunning()) return false;
  return mixer.apply({ op: "setOcclusionCurves", curves }).ok;
}

/** The live-mix host over the running mixer. */
export const liveMixHost: LiveMixHost = {
  running: runtimeRunning,
  apply: (op: MixOp): ApplyResult => mixer.apply(op),
  flushNow: () => audioBackend().mix?.flushNow(),
  setMonitor: (bus, controls) => mixer.setMonitor(bus, controls),
  noteMonitorSolo: () => loudnessHub.noteMonitorSolo(),
  noteMonitorMute: (bus) => loudnessHub.noteMonitorMute(bus),
  setMonitorActive: (on) => loudnessHub.setMonitorActive(on),
  setCompare: (on) => loudnessHub.setCompare(on),
};
