// Which tracks the Profiler's timeline shows for a capture, in the prototype's order (ADR 0348 "The Profiler screen"):
// Picture (a take's frames), Load (voices and CPU against the voice cap), Effects (instances by level: clip chains
// running, playlist instances, bus chains), Effects cost (the DSP's estimated share per
// section, where the levels' effects run: `effectsCostModel.ts`; per-effect cost needs the core to report it), Memory (the
// clip arena and the loaded packages, with package load and unload marks: ADR 0351 §6), one Bus
// track per bus the keyframes carry, Loudness (short-term against the target), the voice lanes, then one track per game
// parameter. A track shows only where the capture has its data: a Babylon-fallback capture has no STATUS (no Load, no
// Effects cost), a capture with no keyframes has no bus rows, an unmetered one no loudness. Pure.

/** What a capture holds, as far as choosing tracks goes. */
export interface CaptureContents {
  /** It carries picture frames (a take's FRAME records; never for a `.sporesample`). */
  readonly frames: boolean;
  /** STATUS samples exist (not a Babylon-fallback capture). */
  readonly status: boolean;
  /** CPU was measured in at least one sample. */
  readonly cpu: boolean;
  /** The CPU meter's per-section shares were fitted in at least one sample (the effects-cost track). */
  readonly effects: boolean;
  /** Effect instances by level can be counted (STATUS `fxVoices`, or playlist instances started). */
  readonly fxInstances?: boolean;
  /** ADR 0351 §6: the clip arena was in use in a STATUS sample, or a package event exists (the memory track). */
  readonly memory?: boolean;
  /** Bus slots any keyframe carries a row for, with their names, in slot order. */
  readonly buses: readonly { readonly slot: number; readonly name: string }[];
  /** A metered bus has loudness samples. */
  readonly loudness: boolean;
  /** Voice events or voices in a keyframe exist. */
  readonly voices: boolean;
  /** The game parameters that changed, by name, in first-change order. */
  readonly parameters: readonly string[];
}

export type PlannedTrack =
  | { readonly id: "picture"; readonly kind: "picture"; readonly label: string }
  | { readonly id: "load"; readonly kind: "load"; readonly label: string; readonly cpu: boolean }
  | { readonly id: "fx"; readonly kind: "fx"; readonly label: string }
  | { readonly id: "effects"; readonly kind: "effects"; readonly label: string }
  | { readonly id: "memory"; readonly kind: "memory"; readonly label: string }
  | { readonly id: `bus:${number}`; readonly kind: "bus"; readonly label: string; readonly slot: number }
  | { readonly id: "loudness"; readonly kind: "loudness"; readonly label: string }
  | { readonly id: "voices"; readonly kind: "voices"; readonly label: string }
  | { readonly id: `param:${string}`; readonly kind: "parameter"; readonly label: string; readonly name: string };

export function planTracks(c: CaptureContents): PlannedTrack[] {
  const out: PlannedTrack[] = [];
  if (c.frames) out.push({ id: "picture", kind: "picture", label: "Picture" });
  if (c.status) out.push({ id: "load", kind: "load", label: "Load", cpu: c.cpu });
  if (c.fxInstances) out.push({ id: "fx", kind: "fx", label: "Effects" });
  if (c.status && c.effects) out.push({ id: "effects", kind: "effects", label: "Effects cost · estimated" });
  if (c.memory) out.push({ id: "memory", kind: "memory", label: "Memory" });
  for (const b of c.buses) out.push({ id: `bus:${b.slot}`, kind: "bus", label: `Bus · ${b.name}`, slot: b.slot });
  if (c.loudness) out.push({ id: "loudness", kind: "loudness", label: "Loudness" });
  if (c.voices) out.push({ id: "voices", kind: "voices", label: "Voices" });
  for (const name of c.parameters) out.push({ id: `param:${name}`, kind: "parameter", label: `Game · ${name}`, name });
  return out;
}

/** Why the timeline has no tracks for a capture that opened (the empty state's words). */
export function noTracksText(c: CaptureContents): string | null {
  return planTracks(c).length > 0 ? null : "This capture holds no voices, buses, loudness or STATUS samples to draw.";
}
