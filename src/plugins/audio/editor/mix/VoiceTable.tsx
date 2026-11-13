// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7): the profiler's voice table at the cursor. Every voice of the
// replay (`reconstructVoices`), filtered by clip or bus name and ordered as the live debug table orders them (most
// audible first), in a windowed grid: 1,024 voices scroll with at most 64 rows rendered. Columns carry the state, the
// reason text and the thief of a steal; a field a voice born after the keyframe doesn't have yet reads "-".
//
// `voiceTableData` is the pure step from a replay to what the view draws; `VoiceTableView` is a pure function of that
// and a grid's state; `VoiceTable` adds the scroll and focus state.
import { useRef } from "preact/hooks";
import { WindowedGridView, useGridState, type GridCell, type GridColumn, type GridState } from "./WindowedGrid";
import { tableEmptyText, voiceCells, voiceSummary, type TableEmptyInput } from "./profilerTablesModel";
import { voiceTable, type VoiceReplay, type VoiceRow } from "./voiceTableModel";

export const VOICE_COLUMNS: readonly GridColumn[] = [
  { key: "id", title: "Voice", width: "52px", align: "end" },
  { key: "clip", title: "Clip", width: "minmax(80px, 1.4fr)" },
  { key: "bus", title: "Bus", width: "minmax(56px, 0.8fr)" },
  { key: "state", title: "State", width: "96px" },
  { key: "reason", title: "Reason", width: "minmax(100px, 1.6fr)" },
  { key: "priority", title: "Pri", width: "36px", align: "end" },
  { key: "gain", title: "Gain", width: "64px", align: "end" },
  { key: "pitch", title: "Pitch", width: "48px", align: "end" },
  { key: "audibility", title: "Audible", width: "56px", align: "end" },
  { key: "playhead", title: "Playhead", width: "76px", align: "end" },
];

/** What the voice table draws. */
export interface VoiceTableData {
  /** Every row after the filter, most audible first. The grid windows it. */
  rows: readonly VoiceRow[];
  /** Voices by id (for the thief's clip name): every voice of the replay, filtered or not. */
  byId: ReadonlyMap<number, VoiceRow>;
  summary: string;
  /** The empty-state text; null when there are rows. */
  empty: string | null;
}

/** The table's data from a replay (null before a seek answered) and the name filter. */
export function voiceTableData(replay: VoiceReplay | null, filter: string, ctx: Omit<TableEmptyInput, "ready" | "rows" | "unfiltered" | "filter" | "beforeFirstKeyframe">): VoiceTableData {
  if (!replay) {
    return { rows: [], byId: new Map(), summary: "", empty: tableEmptyText("voices", { ...ctx, ready: false, beforeFirstKeyframe: false, rows: 0, unfiltered: 0, filter }) };
  }
  // No cap: the grid windows the whole sorted list; `voiceTable` supplies the filter and the order.
  const t = voiceTable(replay, filter, Infinity);
  return {
    rows: t.rows,
    byId: new Map(replay.rows.map((r) => [r.id, r])),
    summary: voiceSummary(t.matched, t.total, filter, replay.fromKeyframe),
    empty: tableEmptyText("voices", { ...ctx, ready: true, beforeFirstKeyframe: !replay.fromKeyframe, rows: t.matched, unfiltered: t.total, filter }),
  };
}

type GridHandlers = Pick<GridState, "scrollTop" | "focus" | "onScroll" | "onKey" | "onFocusRow">;

/** One voice's cells; the state cell is flagged by state name so a stolen or virtual voice reads differently from a playing one. */
function cellsOf(byId: ReadonlyMap<number, VoiceRow>): (row: VoiceRow) => GridCell[] {
  return (row) => {
    const c = voiceCells(row, byId);
    return [c.id, c.clip, c.bus, { text: c.state, flag: row.stateName }, c.reason, c.priority, c.gain, c.pitch, c.audibility, c.playhead];
  };
}

/** The section as a pure function of the data and the grid's state. */
export function VoiceTableView({ data, grid }: { data: VoiceTableData; grid: GridHandlers }) {
  return (
    <section class="ptable" data-table="voices" aria-label="Voices">
      <h3 class="ptable-title">Voices</h3>
      {data.summary ? <p class="ptable-summary" role="status">{data.summary}</p> : null}
      {data.empty !== null ? (
        <p class="ptable-empty">{data.empty}</p>
      ) : (
        <WindowedGridView
          label="Voices"
          columns={VOICE_COLUMNS}
          rows={data.rows}
          rowKey={(r) => r.id}
          cells={cellsOf(data.byId)}
          rowState={(r) => r.stateName}
          {...grid}
        />
      )}
    </section>
  );
}

export function VoiceTable({ data }: { data: VoiceTableData }) {
  const root = useRef<HTMLDivElement>(null);
  const grid = useGridState(data.rows.length, root);
  return (
    <div ref={root}>
      <VoiceTableView data={data} grid={grid} />
    </div>
  );
}
