// Ed4: solo and mute per stem, audition-only editor state keyed by event and segment (§7 lists them as stem-list controls
// and the format has no field for them), never written to the asset. The segment panel toggles them; the audition
// transport reads `audibleStems`.
import { signal } from "@preact/signals";
import type { MusicTrack } from "../../../../engine/audio/musicFormat";

export interface StemAudition { readonly solo: readonly string[]; readonly mute: readonly string[] }
const NONE: StemAudition = { solo: [], mute: [] };

/** Solo and mute per `event#segmentId`: editor state for the audition, never saved. */
export const stemAudition = signal<Readonly<Record<string, StemAudition>>>({});

export const auditionKey = (event: string, segmentId: string): string => `${event}#${segmentId}`;
export const auditionOf = (key: string): StemAudition => stemAudition.value[key] ?? NONE;

/** Flip `name` in the solo or mute list of `key`. */
export function toggleStem(key: string, kind: "solo" | "mute", name: string): void {
  const cur = auditionOf(key);
  const list = cur[kind].includes(name) ? cur[kind].filter((n) => n !== name) : [...cur[kind], name];
  stemAudition.value = { ...stemAudition.value, [key]: { ...cur, [kind]: list } };
}

/** The stems that sound: any solo narrows to the soloed ones; a muted stem never sounds. Names not in `tracks` are ignored. */
export function audibleStems(tracks: readonly MusicTrack[], state: StemAudition): string[] {
  const names = tracks.map((t) => t.name);
  const pool = state.solo.some((s) => names.includes(s)) ? names.filter((n) => state.solo.includes(n)) : names;
  return pool.filter((n) => !state.mute.includes(n));
}
