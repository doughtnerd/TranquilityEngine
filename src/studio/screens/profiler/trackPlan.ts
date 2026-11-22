// Which tracks the Profiler's timeline shows for a capture, in the prototype's order (ADR 0334 "The Profiler screen"):
// Picture (a take's frames), Load (voices and CPU against the voice cap), one Bus track per bus the keyframes carry,
// Loudness (short-term against the target), the voice lanes, then one track per game parameter. A track shows only
// where the capture has its data: a Babylon-fallback capture has no STATUS (no Load), a capture with no keyframes has no
// bus rows, an unmetered one no loudness. Effects cost per level (0331) has no data in a capture yet, so it has no slot
// here until it does. Pure.

/** What a capture holds, as far as choosing tracks goes. */
export interface CaptureContents {
  /** It carries picture frames (a take's FRAME records; never for a `.mycap`). */
  readonly frames: boolean;
  /** STATUS samples exist (not a Babylon-fallback capture). */
  readonly status: boolean;
  /** CPU was measured in at least one sample. */
  readonly cpu: boolean;
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
  | { readonly id: `bus:${number}`; readonly kind: "bus"; readonly label: string; readonly slot: number }
  | { readonly id: "loudness"; readonly kind: "loudness"; readonly label: string }
  | { readonly id: "voices"; readonly kind: "voices"; readonly label: string }
  | { readonly id: `param:${string}`; readonly kind: "parameter"; readonly label: string; readonly name: string };

export function planTracks(c: CaptureContents): PlannedTrack[] {
  const out: PlannedTrack[] = [];
  if (c.frames) out.push({ id: "picture", kind: "picture", label: "Picture" });
  if (c.status) out.push({ id: "load", kind: "load", label: "Load", cpu: c.cpu });
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
