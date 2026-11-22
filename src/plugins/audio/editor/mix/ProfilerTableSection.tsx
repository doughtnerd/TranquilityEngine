// ADR 0326: the one section every profiler table draws in. A table (`ProfilerTable`, from the kit in
// `profilerTablesModel.ts`) under its title, with its summary line, and either its empty-state text or a windowed grid of
// its rows. What differs between the voice, bus, event and music tables is a `TableColumns`: the column list and the
// row's cells (`VoiceTable.tsx`, `BusTable.tsx`, `profilerTables.tsx`).
import { useMemo, useRef } from "preact/hooks";
import { WindowedGridView, useGridState, type GridCell, type GridColumn, type GridState } from "./WindowedGrid";
import { tableEmptyText, type ProfilerTable } from "./profilerTablesModel";

/** How one table draws its rows. */
export interface TableColumns<T> {
  /** The section's heading and the grid's accessible name. */
  title: string;
  columns: readonly GridColumn[];
  rowKey(row: T): string | number;
  /** A row-to-cells function for this table (built once per table: a voice's thief is named from `table.all`). */
  cells(table: ProfilerTable<T>): (row: T) => readonly GridCell[];
  /** A `data-state` for the row (the stylesheet colours by it). */
  rowState?(row: T): string | undefined;
}

type GridHandlers = Pick<GridState, "scrollTop" | "focus" | "onScroll" | "onKey" | "onFocusRow">;

/** The section as a pure function of the table and the grid's state. */
function TableSectionView<T>({ columns, table, grid }: { columns: TableColumns<T>; table: ProfilerTable<T>; grid: GridHandlers }) {
  const cells = useMemo(() => columns.cells(table), [columns, table]);
  return (
    <section class="ptable" data-table={table.kind} aria-label={columns.title}>
      <h3 class="ptable-title">{columns.title}</h3>
      {table.summary ? <p class="ptable-summary" role="status">{table.summary}</p> : null}
      {table.empty !== null ? (
        <p class="ptable-empty">{tableEmptyText(table.kind, table.empty)}</p>
      ) : (
        <WindowedGridView label={columns.title} columns={columns.columns} rows={table.rows} rowKey={columns.rowKey} cells={cells} rowState={columns.rowState} {...grid} />
      )}
    </section>
  );
}

/** One profiler table, with its scroll and focus state. */
export function TableSection<T>({ columns, table }: { columns: TableColumns<T>; table: ProfilerTable<T> }) {
  const root = useRef<HTMLDivElement>(null);
  const grid = useGridState(table.rows.length, root);
  return (
    <div ref={root}>
      <TableSectionView columns={columns} table={table} grid={grid} />
    </div>
  );
}
