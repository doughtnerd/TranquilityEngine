// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7): the profiler's bus table at the cursor's keyframe. One row per
// bus: its seven gain factors in dB (a factor at unity is flagged so the ones doing something stand out), their product
// (the bus's own effective gain) and the product up the tree (the level reaching the output from it). The numbers are
// `busFactorsModel`'s; the parents come from the capture's META audio section.
import { useRef } from "preact/hooks";
import { FACTOR_LANES, formatDb } from "./busFactorsModel";
import { WindowedGridView, useGridState, type GridCell, type GridColumn, type GridState } from "./WindowedGrid";
import { tableEmptyText, type BusRow, type TableEmptyInput } from "./profilerTablesModel";

const LANE_TITLES: Record<(typeof FACTOR_LANES)[number], string> = {
  authored: "Authored", runtime: "Runtime", snapshot: "Snapshot", monitor: "Monitor", dip: "Dip", duck: "Duck", automation: "Automation",
};

export const BUS_COLUMNS: readonly GridColumn[] = [
  { key: "bus", title: "Bus", width: "minmax(72px, 1.2fr)" },
  ...FACTOR_LANES.map((l): GridColumn => ({ key: l, title: LANE_TITLES[l], width: "minmax(56px, 0.7fr)", align: "end" })),
  { key: "product", title: "Product", width: "72px", align: "end" },
  { key: "tree", title: "To output", width: "72px", align: "end" },
];

export interface BusTableData {
  rows: readonly BusRow[];
  empty: string | null;
  summary: string;
}

/** The table's data from the bus rows (null before a seek answered; build them with `busTableRows`). */
export function busTableData(rows: readonly BusRow[] | null, unfiltered: number, filter: string, ctx: Omit<TableEmptyInput, "ready" | "rows" | "unfiltered" | "filter">): BusTableData {
  if (rows === null) return { rows: [], summary: "", empty: tableEmptyText("buses", { ...ctx, ready: false, rows: 0, unfiltered: 0, filter }) };
  return {
    rows,
    summary: filter.trim() === "" ? `${unfiltered} buses` : `${rows.length} of ${unfiltered} buses`,
    empty: tableEmptyText("buses", { ...ctx, ready: true, rows: rows.length, unfiltered, filter }),
  };
}

/** One bus's cells: each lane's dB (flagged `unity` or `active`), the product and the tree product. A removed bus (tombstone) says so. */
export function busCells(row: BusRow): GridCell[] {
  return [
    row.tombstone ? `${row.name} (removed)` : row.name,
    ...row.factors.map((f): GridCell => ({ text: formatDb(f.db), flag: f.unity ? "unity" : "active" })),
    { text: row.productText, flag: row.product === 1 ? "unity" : "active" },
    { text: row.treeText, flag: row.tree === 1 ? "unity" : "active" },
  ];
}

type GridHandlers = Pick<GridState, "scrollTop" | "focus" | "onScroll" | "onKey" | "onFocusRow">;

export function BusTableView({ data, grid }: { data: BusTableData; grid: GridHandlers }) {
  return (
    <section class="ptable" data-table="buses" aria-label="Buses">
      <h3 class="ptable-title">Buses</h3>
      {data.summary ? <p class="ptable-summary" role="status">{data.summary}</p> : null}
      {data.empty !== null ? (
        <p class="ptable-empty">{data.empty}</p>
      ) : (
        <WindowedGridView
          label="Buses"
          columns={BUS_COLUMNS}
          rows={data.rows}
          rowKey={(r) => r.slot}
          cells={busCells}
          rowState={(r) => (r.tombstone ? "removed" : r.nonUnity.length === 0 ? "unity" : "active")}
          {...grid}
        />
      )}
    </section>
  );
}

export function BusTable({ data }: { data: BusTableData }) {
  const root = useRef<HTMLDivElement>(null);
  const grid = useGridState(data.rows.length, root);
  return (
    <div ref={root}>
      <BusTableView data={data} grid={grid} />
    </div>
  );
}
