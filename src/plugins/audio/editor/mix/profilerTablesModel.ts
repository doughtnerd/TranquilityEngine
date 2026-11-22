// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7), and 0326: the pure side of the profiler's tables, so the
// views (`ProfilerTableSection.tsx` draws any table; `VoiceTable.tsx`, `BusTable.tsx` and `profilerTables.tsx` give
// each table's columns and cells) stay thin; the row window and keyboard focus the grids share are `gridWindow.ts`. Here:
//   - the table kit (0326): `profilerTables` builds the four tables at a seek state under one name filter, and
//     `profilerTable` is one table of a kind from its unfiltered rows: the filter (by the kind's names), the summary
//     line and the empty state, chosen once for every table;
//   - the row builders: the voices (`voiceRows`), the bus table (each bus's seven factors, product and tree product; the
//     parents come from the capture's META audio section, which names the parent of each bus by name), the event
//     instances and the music rows (the keyframe's, with `musicTransition` events after it applied);
//   - the cell texts of a voice row (reason, the thief by clip name).
// No DOM: the tests drive it directly.
import { captureNames, type CaptureKeyframe, type CaptureNames, type CaptureSeekState } from "../../runtime/capture/reader";
import { audioSection } from "../../../../engine/audio/audioSection";
import { chooseEmptyStateKind, EMPTY_STATES, type EmptyStateKind } from "./emptyStates";
import { busFactors, treeProducts, type BusFactors } from "./busFactorsModel";
import { formatDb, gainToDb } from "../dbScale";
import type { ProfileSource } from "./profilerSource";
import { eventRows, nameFilter, reconstructVoices, voiceTable, type EventRow, type VoiceRow } from "./voiceTableModel";

// --- voice row cells ---------------------------------------------------------------------------------------------------

const DASH = "-";

/** The thief of a stolen row as text: "voice 3 (jump.ogg)", or "voice 3" when that voice isn't in the table; empty for no thief. */
function thiefText(row: VoiceRow, byId: ReadonlyMap<number, VoiceRow>): string {
  if (row.thief === null) return "";
  const thief = byId.get(row.thief);
  return thief ? `voice ${row.thief} (${thief.clipName})` : `voice ${row.thief}`;
}

export interface VoiceCells {
  id: string;
  clip: string;
  bus: string;
  state: string;
  /** Reason text, with the thief for a steal: "priority, by voice 3 (jump.ogg)". */
  reason: string;
  priority: string;
  gain: string;
  pitch: string;
  audibility: string;
  playhead: string;
}

const fixed = (v: number | null, digits: number): string => (v === null ? DASH : v.toFixed(digits));

/** A voice row's cell texts. A field a voice born after the keyframe doesn't have yet reads "-". */
export function voiceCells(row: VoiceRow, byId: ReadonlyMap<number, VoiceRow>): VoiceCells {
  const thief = thiefText(row, byId);
  const reason = thief ? (row.reasonText ? `${row.reasonText}, by ${thief}` : `by ${thief}`) : row.reasonText;
  return {
    id: String(row.id),
    clip: row.clipName,
    bus: row.busName,
    state: row.state,
    reason,
    priority: row.priority === null ? DASH : String(row.priority),
    gain: formatDb(gainToDb(row.gain)),
    pitch: fixed(row.pitch, 2),
    audibility: row.audibility === null ? DASH : `${Math.round(row.audibility * 100)}%`,
    playhead: `${row.playheadFrames}`,
  };
}

/** Every voice at the seek (`reconstructVoices`), ordered as the live debug table orders them (most audible first). */
export function voiceRows(state: CaptureSeekState, names: CaptureNames): VoiceRow[] {
  return voiceTable(reconstructVoices(state, names), "", Infinity).rows;
}

// --- the bus table -----------------------------------------------------------------------------------------------------

/** One bus row: its name, seven factors, own product and the product up the tree. */
export interface BusRow extends BusFactors {
  name: string;
  /** The product of this bus's and every ancestor's own product. */
  tree: number;
  treeDb: number;
  /** The product, dB text ("-6.0 dB"). */
  productText: string;
  treeText: string;
}

/** Slot to parent slot at axis time `t`: the capture's META audio section names each bus's parent, and the capture's names at `t` give each name's slot. Unknown or absent parents are roots. */
export function busParents(audio: unknown, names: CaptureNames, t: number): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  for (const b of audioSection(audio ?? undefined).settings.buses) {
    const slot = names.slotOf(b.name, t);
    if (slot === undefined) continue;
    parents.set(slot, b.parent === undefined ? null : (names.slotOf(b.parent, t) ?? null));
  }
  return parents;
}

/** The bus rows at a keyframe (in its order), named as at axis time `t`. */
export function busTableRows(keyframe: Pick<CaptureKeyframe, "buses"> | null, names: CaptureNames, t: number, parents: ReadonlyMap<number, number | null>): BusRow[] {
  if (!keyframe) return [];
  const factors = keyframe.buses.map(busFactors);
  const tree = new Map(treeProducts(factors, parents).map((t) => [t.slot, t]));
  return factors.map((f) => {
    const g = tree.get(f.slot)!;
    return { ...f, name: names.bus(f.slot, t), tree: g.tree, treeDb: g.treeDb, productText: formatDb(f.productDb), treeText: formatDb(g.treeDb) };
  });
}

// --- music rows --------------------------------------------------------------------------------------------------------

export interface MusicRow {
  id: number;
  segment: string;
  state: string;
  pass: number;
  /** "bar:beat.tick" as recorded (a keyframe's; null for an instance born after it, whose position the stream doesn't carry). */
  position: string | null;
  tempo: number | null;
  /** The segment a pending transition goes to, or null. */
  pendingTo: string | null;
  pendingTimeSec: number | null;
}

/** The music instances at `state`'s instant: the keyframe's rows with each `musicTransition` after it moving the instance to its new segment (args `instance, from, to`). */
export function musicRows(state: CaptureSeekState, names: CaptureNames): MusicRow[] {
  const nameOf = (id: number | null): string => (id === null ? "none" : names.event(id, state.seconds));
  const rows = new Map<number, MusicRow>();
  for (const m of state.keyframe?.music ?? []) {
    rows.set(m.id, {
      id: m.id,
      segment: nameOf(m.segment),
      state: m.state ?? "unknown",
      pass: m.pass,
      position: `${m.bar}:${m.beat}.${m.tick}`,
      tempo: m.tempo,
      pendingTo: m.pending === null ? null : nameOf(m.pending.to),
      pendingTimeSec: m.pending === null ? null : m.pending.seconds,
    });
  }
  for (const rec of state.records) {
    if (rec.kind !== "event" || rec.event.type !== "musicTransition") continue;
    const { instance, to } = rec.event;
    const prev = rows.get(instance);
    rows.set(instance, prev
      ? { ...prev, segment: nameOf(to), pendingTo: null, pendingTimeSec: null }
      : { id: instance, segment: nameOf(to), state: "playing", pass: 1, position: null, tempo: null, pendingTo: null, pendingTimeSec: null });
  }
  return [...rows.values()].sort((a, b) => a.id - b.id);
}

// --- the table kit (ADR 0326) -----------------------------------------------------------------------------------------

export type TableKind = "voices" | "buses" | "events" | "music";

/** Each table's row. */
export interface TableRows {
  voices: VoiceRow;
  buses: BusRow;
  events: EventRow;
  music: MusicRow;
}

/** What every table reads from the seek and the source. */
export interface TableSeek {
  /** A seek answer exists for the cursor. */
  ready: boolean;
  /** The editor is in Play. */
  playing: boolean;
  truncated: boolean;
  /** The seek found no keyframe at or before the cursor (the voices are then only the last second's starts). */
  beforeFirstKeyframe: boolean;
}

/** The seek context of `seek` (null before a seek answered). */
export function tableSeek(seek: CaptureSeekState | null, truncated: boolean, playing: boolean): TableSeek {
  return { ready: seek !== null, playing, truncated, beforeFirstKeyframe: seek !== null && seek.keyframe === null };
}

/**
 * Why a table has no rows: no seek answer yet (`noCursor`), the filter removed every row (`noMatch`), nothing at the
 * cursor (`none`), or one of the design's empty states (`emptyStates.ts`; a truncated capture before its first keyframe).
 */
export type TableEmpty = "noCursor" | "noMatch" | "none" | EmptyStateKind;

/** One table as drawn. */
export interface ProfilerTable<T> {
  kind: TableKind;
  /** The rows after the filter, in the table's order. */
  rows: readonly T[];
  /** Every row at the cursor, before the filter (a voice's thief is named from these). */
  all: readonly T[];
  /** The line above the table ("2 of 4 voices"); empty before a seek answered. */
  summary: string;
  /** Why there are no rows; null when there are. */
  empty: TableEmpty | null;
}

/** Each kind's names the filter matches and its row noun. */
const KINDS: { [K in TableKind]: { names(row: TableRows[K]): (string | undefined)[]; one: string; many: string } } = {
  voices: { names: (r) => [r.clipName, r.busName], one: "voice", many: "voices" },
  buses: { names: (r) => [r.name], one: "bus", many: "buses" },
  events: { names: (r) => [r.name], one: "event instance", many: "event instances" },
  music: { names: (r) => [r.segment], one: "music instance", many: "music instances" },
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One table of `kind` from its unfiltered rows: filtered by name, with its summary and empty state. */
export function profilerTable<K extends TableKind>(kind: K, all: readonly TableRows[K][], filter: string, seek: TableSeek): ProfilerTable<TableRows[K]> {
  if (!seek.ready) return { kind, rows: [], all: [], summary: "", empty: "noCursor" };
  const k = KINDS[kind];
  const match = nameFilter(filter);
  const filtered = filter.trim() !== "";
  const rows = filtered ? all.filter((r) => match(...k.names(r))) : all;
  const count = filtered ? `${rows.length} of ${plural(all.length, k.one, k.many)}` : plural(all.length, k.one, k.many);
  const caveat = kind === "voices" && seek.beforeFirstKeyframe ? " (no keyframe at or before the cursor: only voices started in the last second are listed)" : "";
  return { kind, rows, all, summary: count + caveat, empty: rows.length > 0 ? null : emptyOf(kind, seek, filtered && all.length > 0) };
}

function emptyOf(kind: TableKind, seek: TableSeek, filteredOut: boolean): TableEmpty {
  const design = chooseEmptyStateKind(kind, { playing: seek.playing, hasCapture: true, truncated: seek.truncated, beforeFirstKeyframe: seek.beforeFirstKeyframe });
  return design ?? (filteredOut ? "noMatch" : "none");
}

/** The four tables. */
export type ProfilerTables = { [K in TableKind]: ProfilerTable<TableRows[K]> };

/** The four tables at `seek` (null before a seek answered), under one name filter. */
export function profilerTables(source: Pick<ProfileSource, "summary" | "truncated">, seek: CaptureSeekState | null, filter: string, playing = false): ProfilerTables {
  const ctx = tableSeek(seek, source.truncated, playing);
  if (seek === null) return { voices: profilerTable("voices", [], filter, ctx), buses: profilerTable("buses", [], filter, ctx), events: profilerTable("events", [], filter, ctx), music: profilerTable("music", [], filter, ctx) };
  const names = captureNames(source.summary);
  const parents = busParents(source.summary.meta.audio, names, seek.seconds);
  return {
    voices: profilerTable("voices", voiceRows(seek, names), filter, ctx),
    buses: profilerTable("buses", busTableRows(seek.keyframe, names, seek.seconds, parents), filter, ctx),
    events: profilerTable("events", eventRows(seek, names), filter, ctx),
    music: profilerTable("music", musicRows(seek, names), filter, ctx),
  };
}

/** The tables' own empty-state words (the design's six, `emptyStates.ts`, cover a missing or truncated capture). */
const NONE: Record<TableKind, string> = { voices: "No voices at the cursor", buses: "No bus data at the cursor", events: "No event instances at the cursor", music: "No music playing at the cursor" };

/** The text a table of `kind` shows for `empty`. */
export function tableEmptyText(kind: TableKind, empty: TableEmpty): string {
  if (empty === "noCursor") return "Place the cursor on the timeline to read the tables";
  if (empty === "noMatch") return "No rows match the filter";
  if (empty === "none") return NONE[kind];
  return EMPTY_STATES[empty];
}
