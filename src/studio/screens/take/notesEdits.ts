// The Take screen's annotation edits (ADR 0334 "Annotations"): add, move, retext, recolour and delete a note marker or
// region in a take's notes. Each returns the next notes and the undo step's label, or why it is refused (ADR 0307's
// `{ next } | { refused }`); the screen commits one step per edit on the notes document. Pure.
import { TAKE_NOTES_LIMITS, TAKE_NOTE_COLOURS, freeNoteId } from "../../../engine/audio/take/notes";
import type { TakeNotes } from "../../../engine/audio/take/types";

export type NotesEdit = { readonly next: TakeNotes; readonly label: string; readonly id: string } | { readonly refused: string };

/** The default length of a new region, seconds. */
export const NEW_REGION_SECONDS = 2;

const clampTime = (t: number, duration: number) => Math.min(Math.max(0, duration), Math.max(0, Number.isFinite(t) ? t : 0));

const cut = (text: string) => text.slice(0, TAKE_NOTES_LIMITS.text);

/** A marker at `at` (clamped to the take). */
export function addMarker(notes: TakeNotes, at: number, duration: number, text = ""): NotesEdit {
  if (notes.markers.length >= TAKE_NOTES_LIMITS.markers) return { refused: `a take holds at most ${TAKE_NOTES_LIMITS.markers} markers` };
  const id = freeNoteId(notes, "m");
  const marker = { id, at: clampTime(at, duration), text: cut(text), color: TAKE_NOTE_COLOURS[0]! };
  return { next: { ...notes, markers: [...notes.markers, marker].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) }, label: "Add note marker", id };
}

/** A region over `[from, to]` (clamped, ordered; a span under 10 ms becomes `NEW_REGION_SECONDS` long). */
export function addRegion(notes: TakeNotes, from: number, to: number, duration: number, text = ""): NotesEdit {
  if (notes.regions.length >= TAKE_NOTES_LIMITS.regions) return { refused: `a take holds at most ${TAKE_NOTES_LIMITS.regions} regions` };
  let a = clampTime(Math.min(from, to), duration);
  let b = clampTime(Math.max(from, to), duration);
  if (b - a < 0.01) {
    b = clampTime(a + NEW_REGION_SECONDS, duration);
    a = clampTime(b - NEW_REGION_SECONDS, duration); // near the end: the region ends there instead
  }
  if (b - a < 0.01) return { refused: "the take is too short for a region" };
  const id = freeNoteId(notes, "r");
  const region = { id, from: a, to: b, text: cut(text), color: TAKE_NOTE_COLOURS[1]! };
  return { next: { ...notes, regions: [...notes.regions, region].sort((x, y) => x.from - y.from || x.id.localeCompare(y.id)) }, label: "Add note region", id };
}

/** Move a marker to `at`, or a region so it starts at `at` (its length kept), clamped to the take. */
export function moveNote(notes: TakeNotes, id: string, at: number, duration: number): NotesEdit {
  const m = notes.markers.find((x) => x.id === id);
  if (m) {
    const t = clampTime(at, duration);
    const markers = notes.markers.map((x) => (x.id === id ? { ...x, at: t } : x)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    return { next: { ...notes, markers }, label: "Move note marker", id };
  }
  const r = notes.regions.find((x) => x.id === id);
  if (!r) return { refused: "that note is gone" };
  const len = r.to - r.from;
  const from = Math.min(clampTime(at, duration), Math.max(0, duration - len));
  const regions = notes.regions.map((x) => (x.id === id ? { ...x, from, to: from + len } : x)).sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  return { next: { ...notes, regions }, label: "Move note region", id };
}

/** Set a region's ends (ordered and clamped). */
export function setRegionSpan(notes: TakeNotes, id: string, from: number, to: number, duration: number): NotesEdit {
  const r = notes.regions.find((x) => x.id === id);
  if (!r) return { refused: "that region is gone" };
  const a = clampTime(Math.min(from, to), duration);
  const b = clampTime(Math.max(from, to), duration);
  if (b - a < 0.01) return { refused: "a region needs some length" };
  const regions = notes.regions.map((x) => (x.id === id ? { ...x, from: a, to: b } : x)).sort((x, y) => x.from - y.from || x.id.localeCompare(y.id));
  return { next: { ...notes, regions }, label: "Resize note region", id };
}

/** Change a note's text and/or colour. */
export function editNote(notes: TakeNotes, id: string, change: { readonly text?: string; readonly color?: number }): NotesEdit {
  const color = change.color === undefined ? undefined : Math.min(0xffffff, Math.max(0, Math.round(change.color)));
  const text = change.text === undefined ? undefined : cut(change.text);
  const label = text !== undefined ? "Edit note" : "Recolour note";
  const apply = <T extends { id: string; text: string; color: number }>(x: T): T => (x.id === id ? { ...x, ...(text !== undefined ? { text } : {}), ...(color !== undefined ? { color } : {}) } : x);
  if (notes.markers.some((x) => x.id === id)) return { next: { ...notes, markers: notes.markers.map(apply) }, label, id };
  if (notes.regions.some((x) => x.id === id)) return { next: { ...notes, regions: notes.regions.map(apply) }, label, id };
  return { refused: "that note is gone" };
}

/** Delete a note marker or region. */
export function deleteNote(notes: TakeNotes, id: string): NotesEdit {
  if (notes.markers.some((x) => x.id === id)) return { next: { ...notes, markers: notes.markers.filter((x) => x.id !== id) }, label: "Delete note marker", id };
  if (notes.regions.some((x) => x.id === id)) return { next: { ...notes, regions: notes.regions.filter((x) => x.id !== id) }, label: "Delete note region", id };
  return { refused: "that note is gone" };
}

/** A colour as CSS (`#rrggbb`): note colours are the designer's data, not theme colours. */
export const noteColourCss = (color: number): string => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
