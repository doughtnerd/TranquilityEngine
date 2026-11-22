// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7), and 0326: the profiler's bus table at the cursor's keyframe,
// as its columns and cells (`ProfilerTableSection.tsx` draws it; the rows are the kit's, `profilerTablesModel.ts`). One
// row per bus: its seven gain factors in dB (a factor at unity is flagged so the ones doing something stand out), their
// product (the bus's own effective gain) and the product up the tree (the level reaching the output from it). The numbers
// are `busFactorsModel`'s; the parents come from the capture's META audio section.
import { FACTOR_LANES } from "./busFactorsModel";
import { formatDb } from "../dbScale";
import type { GridCell, GridColumn } from "./WindowedGrid";
import type { TableColumns } from "./ProfilerTableSection";
import type { BusRow } from "./profilerTablesModel";

const LANE_TITLES: Record<(typeof FACTOR_LANES)[number], string> = {
  authored: "Authored", runtime: "Runtime", snapshot: "Snapshot", monitor: "Monitor", dip: "Dip", duck: "Duck", automation: "Automation",
};

/** One bus's cells: each lane's dB (flagged `unity` or `active`), the product and the tree product. A removed bus (tombstone) says so. */
function busCells(row: BusRow): GridCell[] {
  return [
    row.tombstone ? `${row.name} (removed)` : row.name,
    ...row.factors.map((f): GridCell => ({ text: formatDb(f.db), flag: f.unity ? "unity" : "active" })),
    { text: row.productText, flag: row.product === 1 ? "unity" : "active" },
    { text: row.treeText, flag: row.tree === 1 ? "unity" : "active" },
  ];
}

export const BUS_TABLE: TableColumns<BusRow> = {
  title: "Buses",
  columns: [
    { key: "bus", title: "Bus", width: "minmax(72px, 1.2fr)" },
    ...FACTOR_LANES.map((l): GridColumn => ({ key: l, title: LANE_TITLES[l], width: "minmax(56px, 0.7fr)", align: "end" })),
    { key: "product", title: "Product", width: "72px", align: "end" },
    { key: "tree", title: "To output", width: "72px", align: "end" },
  ],
  rowKey: (r) => r.slot,
  cells: () => busCells,
  rowState: (r) => (r.tombstone ? "removed" : r.nonUnity.length === 0 ? "unity" : "active"),
};
