// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7): the Profiler panel's tables region (H5's `tables` slot). A
// name filter over four tables at the cursor: voices (`VoiceTable`), buses (`BusTable`), event instances and music. The
// slot receives the open source, the cursor and the controller's seek state; the tables are built from `seek` by
// `profilerTablesData` (pure), so the view only draws.
//
// Install (in `mix/index.ts`'s `loadProfiler`): `m.profilerSlots.tables = (await import("./profilerTables")).ProfilerTables;`
//
// The seek. The controller seeks when the cursor is moved by a user (`cursorMoved`); it doesn't seek on opening a capture
// or while a live view follows the ring. So when `seek` is null, or the cursor is live, this region asks the source for
// the state at the cursor itself (one request at a time, a stale answer dropped), and a live view re-asks on each of
// `LiveFollow`'s coalesced updates (at most one per 66 ms), never per STATUS block.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CaptureSeekState } from "../../runtime/capture/reader";
import type { TablesSlotProps } from "./ProfilerPanel";
import type { ProfileSource } from "./profilerSource";
import { BusTable, busTableData, type BusTableData } from "./BusTable";
import { VoiceTable, voiceTableData, type VoiceTableData } from "./VoiceTable";
import { WindowedGridView, useGridState, type GridColumn } from "./WindowedGrid";
import { busParents, busTableRows, musicRows, tableEmptyText, type MusicRow, type TableEmptyInput } from "./profilerTablesModel";
import { eventRows, nameLookup, reconstructVoices, type EventRow } from "./voiceTableModel";

export const EVENT_COLUMNS: readonly GridColumn[] = [
  { key: "id", title: "Instance", width: "64px", align: "end" },
  { key: "name", title: "Event", width: "minmax(100px, 2fr)" },
  { key: "voices", title: "Voices", width: "56px", align: "end" },
];

export const MUSIC_COLUMNS: readonly GridColumn[] = [
  { key: "id", title: "Instance", width: "64px", align: "end" },
  { key: "segment", title: "Segment", width: "minmax(100px, 1.6fr)" },
  { key: "state", title: "State", width: "96px" },
  { key: "pass", title: "Pass", width: "40px", align: "end" },
  { key: "position", title: "Bar:beat.tick", width: "88px", align: "end" },
  { key: "tempo", title: "Tempo", width: "52px", align: "end" },
  { key: "pending", title: "Pending", width: "minmax(80px, 1.2fr)" },
];

/** A small table's data: the rows after the filter, the text above them and its empty state. */
export interface RowsData<T> {
  rows: readonly T[];
  summary: string;
  empty: string | null;
}

/** Everything the region draws. */
export interface ProfilerTablesData {
  voices: VoiceTableData;
  buses: BusTableData;
  events: RowsData<EventRow>;
  music: RowsData<MusicRow>;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function rowsData<T>(kind: "events" | "music", rows: readonly T[] | null, unfiltered: number, filter: string, ctx: Omit<TableEmptyInput, "ready" | "rows" | "unfiltered" | "filter">, one: string, many: string): RowsData<T> {
  if (rows === null) return { rows: [], summary: "", empty: tableEmptyText(kind, { ...ctx, ready: false, rows: 0, unfiltered: 0, filter }) };
  return {
    rows,
    summary: filter.trim() === "" ? plural(unfiltered, one, many) : `${rows.length} of ${plural(unfiltered, one, many)}`,
    empty: tableEmptyText(kind, { ...ctx, ready: true, rows: rows.length, unfiltered, filter }),
  };
}

/** The four tables at `seek` (null before a seek answered: each shows its "place the cursor" text), filtered by name. */
export function profilerTablesData(source: Pick<ProfileSource, "summary" | "truncated">, seek: CaptureSeekState | null, filter: string, playing = false): ProfilerTablesData {
  const names = nameLookup(source.summary.names);
  const ctx = { playing, truncated: source.truncated, beforeFirstKeyframe: seek !== null && seek.keyframe === null };
  const voices = voiceTableData(seek ? reconstructVoices(seek, names) : null, filter, { playing, truncated: ctx.truncated });
  let buses: BusTableData;
  let events: RowsData<EventRow>;
  let music: RowsData<MusicRow>;
  if (seek === null) {
    buses = busTableData(null, 0, filter, ctx);
    events = rowsData("events", null, 0, filter, ctx, "", "");
    music = rowsData("music", null, 0, filter, ctx, "", "");
  } else {
    const parents = busParents(source.summary.meta.audio, source.summary.names.buses);
    const busRows = busTableRows(seek.keyframe, names, parents, filter);
    buses = busTableData(busRows, seek.keyframe ? seek.keyframe.buses.length : 0, filter, ctx);
    const eventsAll = eventRows(seek, names, "");
    events = rowsData("events", eventRows(seek, names, filter), eventsAll.length, filter, ctx, "event instance", "event instances");
    const eventName = (id: number): string | undefined => names.event(id);
    const musicAll = musicRows(seek, eventName, "");
    music = rowsData("music", musicRows(seek, eventName, filter), musicAll.length, filter, ctx, "music instance", "music instances");
  }
  return { voices, buses, events, music };
}

/** Events and music: a small windowed grid under a title, with the summary and the empty state. */
function RowsTable<T>({ title, label, columns, data, rowKey, cells }: {
  title: string;
  label: string;
  columns: readonly GridColumn[];
  data: RowsData<T>;
  rowKey(row: T): string | number;
  cells(row: T): string[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const grid = useGridState(data.rows.length, root);
  return (
    <div ref={root}>
      <RowsTableView title={title} label={label} columns={columns} data={data} rowKey={rowKey} cells={cells} grid={grid} />
    </div>
  );
}

/** The section of a small table as a pure function of its data and grid state. */
export function RowsTableView<T>({ title, label, columns, data, rowKey, cells, grid }: {
  title: string;
  label: string;
  columns: readonly GridColumn[];
  data: RowsData<T>;
  rowKey(row: T): string | number;
  cells(row: T): string[];
  grid: { scrollTop: number; focus: number; onScroll(top: number): void; onKey(key: string, prevent: () => void): void; onFocusRow(i: number): void };
}) {
  return (
    <section class="ptable" data-table={label} aria-label={title}>
      <h3 class="ptable-title">{title}</h3>
      {data.summary ? <p class="ptable-summary" role="status">{data.summary}</p> : null}
      {data.empty !== null ? (
        <p class="ptable-empty">{data.empty}</p>
      ) : (
        <WindowedGridView label={title} columns={columns} rows={data.rows} rowKey={rowKey} cells={cells} {...grid} />
      )}
    </section>
  );
}

export const eventCells = (r: EventRow): string[] => [String(r.id), r.name, String(r.voices)];
export const musicCells = (r: MusicRow): string[] => [
  String(r.id), r.segment, r.state, String(r.pass), r.position ?? "-", r.tempo === null ? "-" : String(r.tempo),
  r.pendingTo === null ? "" : r.pendingTimeSec === null || r.pendingTimeSec === 0 ? `to ${r.pendingTo}` : `to ${r.pendingTo} at ${r.pendingTimeSec.toFixed(2)} s`,
];

/** The region as a pure function of its data and the filter text (the tests inspect this tree without rendering the tables). */
export function ProfilerTablesView({ data, filter, onFilter }: { data: ProfilerTablesData; filter: string; onFilter(text: string): void }) {
  return (
    <div class="ptables" aria-label="Profiler tables">
      <label class="ptables-filter">
        <span class="ptables-filter-label">Filter</span>
        <input
          type="search"
          class="ptables-filter-input"
          aria-label="Filter tables by name"
          placeholder="Clip, bus, event or segment name"
          value={filter}
          onInput={(e) => onFilter((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <VoiceTable data={data.voices} />
      <BusTable data={data.buses} />
      <RowsTable title="Event instances" label="events" columns={EVENT_COLUMNS} data={data.events} rowKey={(r) => r.id} cells={eventCells} />
      <RowsTable title="Music" label="music" columns={MUSIC_COLUMNS} data={data.music} rowKey={(r) => r.id} cells={musicCells} />
    </div>
  );
}

/**
 * The seek state to draw: the controller's, or this region's own when the controller has none yet or the view is live.
 * A newer request or an unmount drops an older answer.
 */
function useSeekState(source: ProfileSource, seek: CaptureSeekState | null, cursor: TablesSlotProps["cursor"], live: TablesSlotProps["live"]): CaptureSeekState | null {
  const own = seek === null || cursor.mode === "live";
  const [answer, setAnswer] = useState<{ source: ProfileSource; state: CaptureSeekState } | null>(null);
  useEffect(() => {
    if (!own) return;
    let stale = false;
    source.seek(source.startSeconds + cursor.time).then(
      (state) => { if (!stale) setAnswer({ source, state }); },
      () => {}, // a closed source: the controller already moved on
    );
    return () => { stale = true; };
  }, [own, source, cursor.time, cursor.revision, cursor.mode, live]);
  if (!own) return seek;
  return answer !== null && answer.source === source ? answer.state : seek;
}

/** The `tables` slot's component (`TablesSlotProps`). */
export function ProfilerTables({ source, cursor, seek, live }: TablesSlotProps) {
  const [filter, setFilter] = useState("");
  const state = useSeekState(source, seek, cursor, live);
  const data = useMemo(() => profilerTablesData(source, state, filter, live !== null), [source, state, filter, live !== null]);
  return <ProfilerTablesView data={data} filter={filter} onFilter={setFilter} />;
}
