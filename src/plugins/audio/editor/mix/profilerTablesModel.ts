// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7): the pure side of the profiler's tables, so the views
// (`VoiceTable.tsx`, `BusTable.tsx`, `profilerTables.tsx`) stay thin; the row window and keyboard focus the grids share
// are `gridWindow.ts`. Here:
//   - the cell texts of a voice row (reason, the thief by clip name);
//   - the bus table (each bus's seven factors, product and tree product; the parents come from the capture's META audio
//     section, which names the parent of each bus by name) and the music rows (the keyframe's, with `musicTransition`
//     events after it applied).
// No DOM: the tests drive it directly.
import type { CaptureSeekState, KeyframePayload } from "../../runtime/capture/reader";
import { audioSection } from "../../../../engine/audio/audioSection";
import { chooseEmptyState } from "./emptyStates";
import { busFactors, formatDb, treeProducts, type BusFactors } from "./busFactorsModel";
import { nameFilter, type NameLookup, type VoiceRow } from "./voiceTableModel";

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
    state: row.stateName,
    reason,
    priority: row.priority === null ? DASH : String(row.priority),
    gain: formatDb(row.gain > 0 ? 20 * Math.log10(row.gain) : -Infinity),
    pitch: fixed(row.pitch, 2),
    audibility: row.audibility === null ? DASH : `${Math.round(row.audibility * 100)}%`,
    playhead: `${row.playheadFrames}`,
  };
}

/** The line above the voice table: how many rows match, how many exist, and the capture's keyframe caveat. */
export function voiceSummary(matched: number, total: number, filter: string, fromKeyframe: boolean): string {
  const count = filter.trim() === "" ? `${total} voices` : `${matched} of ${total} voices`;
  return fromKeyframe ? count : `${count} (no keyframe at or before the cursor: only voices started in the last second are listed)`;
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

/** Slot to parent slot, from the capture's META audio section (buses name their parent) and the capture's bus names. Unknown or absent parents are roots. */
export function busParents(audio: unknown, busNames: Iterable<readonly [number, string]>): Map<number, number | null> {
  const slotOf = new Map<string, number>();
  for (const [slot, name] of busNames) slotOf.set(name, slot);
  const parents = new Map<number, number | null>();
  for (const b of audioSection(audio ?? undefined).settings.buses) {
    const slot = slotOf.get(b.name);
    if (slot === undefined) continue;
    parents.set(slot, b.parent === undefined ? null : (slotOf.get(b.parent) ?? null));
  }
  return parents;
}

/** The bus rows at a keyframe (in its order), filtered by bus name. A bus the names don't cover reads "bus <slot>". */
export function busTableRows(
  keyframe: Pick<KeyframePayload, "buses"> | null,
  names: NameLookup,
  parents: ReadonlyMap<number, number | null>,
  filter = "",
): BusRow[] {
  if (!keyframe) return [];
  const factors = keyframe.buses.map(busFactors);
  const tree = new Map(treeProducts(factors, parents).map((t) => [t.slot, t]));
  const match = nameFilter(filter);
  const rows: BusRow[] = [];
  for (const f of factors) {
    const name = names.bus(f.slot) ?? `bus ${f.slot}`;
    if (!match(name)) continue;
    const t = tree.get(f.slot)!;
    rows.push({ ...f, name, tree: t.tree, treeDb: t.treeDb, productText: formatDb(f.productDb), treeText: formatDb(t.treeDb) });
  }
  return rows;
}

// --- music rows --------------------------------------------------------------------------------------------------------

/** The `state` codes of a keyframe music row (`KfMusicState`). */
export const MusicStateName = ["priming", "playing", "transitioning", "recovering", "ending"] as const;

/** The id a keyframe or event carries for no name (`capture/events.ts`' `NO_NAME`). */
const NO_NAME = 0xffffffff;

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

/** The music instances at `state`'s instant: the keyframe's rows with each `musicTransition` after it moving the instance to its new segment (args `instance, from, to`). Filtered by segment name. */
export function musicRows(state: CaptureSeekState, eventName: (id: number) => string | undefined, filter = ""): MusicRow[] {
  const nameOf = (id: number): string => (id === NO_NAME ? "none" : (eventName(id) ?? `segment ${id}`));
  const rows = new Map<number, MusicRow>();
  for (const m of state.keyframe?.music ?? []) {
    rows.set(m.id, {
      id: m.id,
      segment: nameOf(m.segment),
      state: MusicStateName[m.state] ?? `state ${m.state}`,
      pass: m.pass,
      position: `${m.bar}:${m.beat}.${m.tick}`,
      tempo: m.tempo,
      pendingTo: m.pendingTo === NO_NAME ? null : nameOf(m.pendingTo),
      pendingTimeSec: m.pendingTo === NO_NAME ? null : m.pendingTimeSec,
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
  const match = nameFilter(filter);
  return [...rows.values()].filter((r) => match(r.segment)).sort((a, b) => a.id - b.id);
}

// --- empty states ------------------------------------------------------------------------------------------------------

export type TableKind = "voices" | "buses" | "events" | "music";

/** The words the tables add to `emptyStates.ts`' strings (the design's six cover a missing or truncated capture; these cover a table with no rows). */
const TABLE_EMPTY = {
  noCursor: "Place the cursor on the timeline to read the tables",
  noMatch: "No rows match the filter",
  none: { voices: "No voices at the cursor", buses: "No bus data at the cursor", events: "No event instances at the cursor", music: "No music playing at the cursor" },
} as const;

export interface TableEmptyInput {
  /** A seek answer exists for the cursor. */
  ready: boolean;
  /** The editor is in Play. */
  playing: boolean;
  truncated: boolean;
  /** The seek found no keyframe at or before the cursor. */
  beforeFirstKeyframe: boolean;
  /** Rows after the filter. */
  rows: number;
  /** Rows before the filter. */
  unfiltered: number;
  filter: string;
}

/** The empty-state text of one table, or null when it has rows. A truncated capture before its first keyframe says so (the design's string). */
export function tableEmptyText(kind: TableKind, input: TableEmptyInput): string | null {
  if (!input.ready) return TABLE_EMPTY.noCursor;
  if (input.rows > 0) return null;
  const design = chooseEmptyState(kind, {
    playing: input.playing, hasCapture: true, truncated: input.truncated, beforeFirstKeyframe: input.beforeFirstKeyframe,
  });
  if (design !== null) return design;
  return input.filter.trim() !== "" && input.unfiltered > 0 ? TABLE_EMPTY.noMatch : TABLE_EMPTY.none[kind];
}
