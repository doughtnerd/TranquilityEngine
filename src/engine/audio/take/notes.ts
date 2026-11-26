/**
 * ADR 0348 "Annotations": a take's notes, `<take>.notes.json` (`myco.takenotes@1`) beside the recorded file, which never
 * changes. Markers (a time) and regions (a span), each with text and a colour, edited in the Studio's Take screen as an
 * asset document with the engine's history.
 *
 * The parse is lenient (bad values fall back with one problem line; nothing throws) and canonical: markers sorted by
 * time, regions by start with `from <= to`, ids unique, text cut to its limit. The writer leaves nothing out (the file is
 * small) and parsing what it writes gives the same value back. The notes of take `runs/a.sporesample` live at
 * `runs/a.sporesample.notes.json` (the whole file name, as `.meta.json` sidecars keep it).
 *
 * Pure; no plugin, no DOM.
 */
import { IdScope, LenientReader, isRecord } from "../lenientRead";
import { TAKE_NOTES_FORMAT, TAKE_NOTES_SUFFIX, TAKE_SUFFIX, type TakeNotes } from "./types";

/** Limits of a notes file, declared once (ADR 0306). */
export const TAKE_NOTES_LIMITS = Object.freeze({
  markers: 4096,
  regions: 4096,
  /** Characters of a note's text (cut, with a problem). */
  text: 4000,
  /** Characters of an id. */
  id: 64,
  /** A time, seconds (a day: far past any take). */
  time: 86_400,
});

/** The colours a note can take: 24-bit RGB. The first is the default. */
export const TAKE_NOTE_COLOURS: readonly number[] = [0xf2c94c, 0x56ccf2, 0x6fcf97, 0xeb5757, 0xbb6bd9, 0xf2994a];

export type TakeNoteMarker = TakeNotes["markers"][number];
export type TakeNoteRegion = TakeNotes["regions"][number];

/** Notes with nothing in them (a take without a notes file). */
export const emptyTakeNotes = (): TakeNotes => ({ format: TAKE_NOTES_FORMAT, markers: [], regions: [] });

/** The notes file of take `takePath`. */
export const takeNotesPath = (takePath: string): string => `${takePath}${TAKE_NOTES_SUFFIX}`;

/** True for a take's notes file (`*.sporesample.notes.json`). */
export const isTakeNotesPath = (path: string): boolean => path.toLowerCase().endsWith(`${TAKE_SUFFIX}${TAKE_NOTES_SUFFIX}`);

const sortNotes = (n: TakeNotes): TakeNotes => ({
  format: TAKE_NOTES_FORMAT,
  markers: [...n.markers].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
  regions: [...n.regions].sort((a, b) => a.from - b.from || a.to - b.to || a.id.localeCompare(b.id)),
});

/** Parse a notes file's JSON (undefined: no file). Lenient: never throws. */
export function parseTakeNotes(raw: unknown, where = "notes"): { value: TakeNotes; problems: string[] } {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  if (raw === undefined || raw === null) return { value: emptyTakeNotes(), problems };
  if (!isRecord(raw)) {
    r.problem(where, "must be an object; using empty notes.");
    return { value: emptyTakeNotes(), problems };
  }
  if (raw.format !== TAKE_NOTES_FORMAT) r.problem(`${where}.format`, `must be "${TAKE_NOTES_FORMAT}"; read as it.`);
  const ids = new IdScope(r);
  const id = (v: unknown, at: string, prefix: string) => ids.take(typeof v === "string" ? v.slice(0, TAKE_NOTES_LIMITS.id) : v, `${at}.id`, prefix);
  const text = (v: unknown, at: string): string => {
    const s = r.str(v, `${at}.text`, "");
    if (s.length <= TAKE_NOTES_LIMITS.text) return s;
    r.problem(`${at}.text`, `longer than ${TAKE_NOTES_LIMITS.text} characters; cut.`);
    return s.slice(0, TAKE_NOTES_LIMITS.text);
  };
  const colour = (v: unknown, at: string) => r.int(v, `${at}.color`, TAKE_NOTE_COLOURS[0]!, 0, 0xffffff);
  const time = (v: unknown, at: string) => r.num(v, at, 0, 0, TAKE_NOTES_LIMITS.time);

  const markers: TakeNoteMarker[] = [];
  const markersIn = r.list(raw.markers, `${where}.markers`);
  if (markersIn.length > TAKE_NOTES_LIMITS.markers) r.problem(`${where}.markers`, `at most ${TAKE_NOTES_LIMITS.markers}; the rest are dropped.`);
  markersIn.slice(0, TAKE_NOTES_LIMITS.markers).forEach((m, i) => {
    const at = `${where}.markers[${i}]`;
    const o = r.record(m, at);
    if (!o) return;
    markers.push({ id: id(o.id, at, "m"), at: time(o.at, `${at}.at`), text: text(o.text, at), color: colour(o.color, at) });
  });

  const regions: TakeNoteRegion[] = [];
  const regionsIn = r.list(raw.regions, `${where}.regions`);
  if (regionsIn.length > TAKE_NOTES_LIMITS.regions) r.problem(`${where}.regions`, `at most ${TAKE_NOTES_LIMITS.regions}; the rest are dropped.`);
  regionsIn.slice(0, TAKE_NOTES_LIMITS.regions).forEach((g, i) => {
    const at = `${where}.regions[${i}]`;
    const o = r.record(g, at);
    if (!o) return;
    let from = time(o.from, `${at}.from`);
    let to = time(o.to, `${at}.to`);
    if (from > to) {
      r.problem(at, "from was after to; swapped.");
      [from, to] = [to, from];
    }
    regions.push({ id: id(o.id, at, "r"), from, to, text: text(o.text, at), color: colour(o.color, at) });
  });
  return { value: sortNotes({ format: TAKE_NOTES_FORMAT, markers, regions }), problems };
}

/** The notes as the file's text (canonical order, two-space indent, a final newline). */
export function formatTakeNotes(notes: TakeNotes): string {
  const n = sortNotes(notes);
  const out = {
    format: TAKE_NOTES_FORMAT,
    markers: n.markers.map((m) => ({ id: m.id, at: m.at, text: m.text, color: m.color })),
    regions: n.regions.map((g) => ({ id: g.id, from: g.from, to: g.to, text: g.text, color: g.color })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** An id unused by any marker or region of `notes`, `prefix1`, `prefix2`, … */
export function freeNoteId(notes: TakeNotes, prefix: "m" | "r"): string {
  const used = new Set([...notes.markers.map((m) => m.id), ...notes.regions.map((g) => g.id)]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
