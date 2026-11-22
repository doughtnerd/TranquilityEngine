// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7), and 0326: the Profiler panel's tables region (H5's `tables`
// slot). A name filter over four tables at the cursor: voices (`VOICE_TABLE`), buses (`BUS_TABLE`), event instances and
// music. The slot receives the open source, the cursor and the controller's seek state; the tables are built from `seek`
// by the kit's `profilerTables` (pure, `profilerTablesModel.ts`), and each is drawn by the one `TableSection`.
//
// Install (in `mix/index.ts`'s `loadProfiler`): `m.profilerSlots.tables = (await import("./profilerTables")).ProfilerTables;`
//
// The seek. The controller seeks when the cursor is moved by a user (`cursorMoved`); it doesn't seek on opening a capture
// or while a live view follows the ring. So when `seek` is null, or the cursor is live, this region asks the source for
// the state at the cursor itself (one request at a time, a stale answer dropped), and a live view re-asks on each of
// `LiveFollow`'s coalesced updates (at most one per 66 ms), never per STATUS block.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { CaptureSeekState } from "../../runtime/capture/reader";
import type { TablesSlotProps } from "./ProfilerPanel";
import type { ProfileSource } from "./profilerSource";
import { BUS_TABLE } from "./BusTable";
import { VOICE_TABLE } from "./VoiceTable";
import { TableSection, type TableColumns } from "./ProfilerTableSection";
import { profilerTables, type MusicRow, type ProfilerTables as Tables } from "./profilerTablesModel";
import type { EventRow } from "./voiceTableModel";

const EVENT_TABLE: TableColumns<EventRow> = {
  title: "Event instances",
  columns: [
    { key: "id", title: "Instance", width: "64px", align: "end" },
    { key: "name", title: "Event", width: "minmax(100px, 2fr)" },
    { key: "voices", title: "Voices", width: "56px", align: "end" },
  ],
  rowKey: (r) => r.id,
  cells: () => (r) => [String(r.id), r.name, String(r.voices)],
};

const MUSIC_TABLE: TableColumns<MusicRow> = {
  title: "Music",
  columns: [
    { key: "id", title: "Instance", width: "64px", align: "end" },
    { key: "segment", title: "Segment", width: "minmax(100px, 1.6fr)" },
    { key: "state", title: "State", width: "96px" },
    { key: "pass", title: "Pass", width: "40px", align: "end" },
    { key: "position", title: "Bar:beat.tick", width: "88px", align: "end" },
    { key: "tempo", title: "Tempo", width: "52px", align: "end" },
    { key: "pending", title: "Pending", width: "minmax(80px, 1.2fr)" },
  ],
  rowKey: (r) => r.id,
  cells: () => (r) => [
    String(r.id), r.segment, r.state, String(r.pass), r.position ?? "-", r.tempo === null ? "-" : String(r.tempo),
    r.pendingTo === null ? "" : r.pendingTimeSec === null || r.pendingTimeSec === 0 ? `to ${r.pendingTo}` : `to ${r.pendingTo} at ${r.pendingTimeSec.toFixed(2)} s`,
  ],
};

/** The region from its tables and the filter text. */
function ProfilerTablesView({ tables, filter, onFilter }: { tables: Tables; filter: string; onFilter(text: string): void }) {
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
      <TableSection columns={VOICE_TABLE} table={tables.voices} />
      <TableSection columns={BUS_TABLE} table={tables.buses} />
      <TableSection columns={EVENT_TABLE} table={tables.events} />
      <TableSection columns={MUSIC_TABLE} table={tables.music} />
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
  const tables = useMemo(() => profilerTables(source, state, filter, live !== null), [source, state, filter, live !== null]);
  return <ProfilerTablesView tables={tables} filter={filter} onFilter={setFilter} />;
}
