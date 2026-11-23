// The chooser table as a spreadsheet (ADR 0373 "The chooser table as a spreadsheet view"): one row per entry, tried top
// to bottom — its condition rows and the node it picks — then the fallback. Rows reorder with their arrows; every edit is
// `graphEditLogic.ts`'s refused-or-next result, one undo step each.
import type { AnimGraph, GraphNode } from "../../../../engine/animation/animGraph";
import type { EditResult } from "../../../../editor/sdk";
import { addRow, conditionRows, defaultSubject, rowsCondition } from "./conditionLogic";
import { ConditionRows } from "./ConditionRows";
import { addChooserRow, moveChooserRow, nodeTitle, reaches, removeChooserRow, setChooserCondition, setChooserFallback, setChooserResult } from "./graphEditLogic";
import type { PlacedProblem } from "./problemLogic";

export interface ChooserTableProps {
  graph: AnimGraph;
  node: GraphNode;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  problems?: (row: number) => readonly PlacedProblem[];
}

export function ChooserTable(props: ChooserTableProps) {
  const { graph, node, apply, readOnly = false } = props;
  const table = node.chooser;
  if (!table) return null;
  const id = node.id;
  const results = graph.nodes.filter((n) => n.id !== id && !reaches(graph, n.id, id));
  const first = results[0];
  const newCondition = () => {
    const r = addRow(graph, conditionRows(null), defaultSubject(graph));
    return "refused" in r ? null : rowsCondition(r.next);
  };
  return (
    <div class="ag-chooser" role="group" aria-label={`Chooser ${nodeTitle(node)}`}>
      <div class="ag-section-head"><span>Chooser table</span><span class="ag-muted">the first row whose condition holds picks its node</span></div>
      <table class="ag-table ag-sheet" aria-label={`${id} rows`}>
        <thead><tr><th>#</th><th>When</th><th>Picks</th><th /></tr></thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} data-row={i} class={(props.problems?.(i) ?? []).length ? "invalid" : ""}>
              <td class="ag-priority">{i + 1}</td>
              <td>
                <ConditionRows graph={graph} condition={row.if} label={`${id} row ${i + 1}`} readOnly={readOnly}
                  apply={(r, l) => apply("refused" in r ? r : setChooserCondition(graph, id, i, r.next), l)} empty="Add a condition: a row needs one" />
                {(props.problems?.(i) ?? []).map((p, k) => <p key={k} class={`ag-problem ${p.severity}`}>{p.message}</p>)}
              </td>
              <td>
                <select aria-label={`${id} row ${i + 1} result`} value={row.result} disabled={readOnly} onChange={(e) => apply(setChooserResult(graph, id, i, (e.currentTarget as HTMLSelectElement).value), `Change ${id} row ${i + 1}`)}>
                  {results.map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
                </select>
              </td>
              <td class="ag-row-actions">
                <button class="icon" aria-label={`Move ${id} row ${i + 1} up`} disabled={readOnly || i === 0} onClick={() => apply(moveChooserRow(graph, id, i, i - 1), `Move ${id} row ${i + 1} up`)}>↑</button>
                <button class="icon" aria-label={`Move ${id} row ${i + 1} down`} disabled={readOnly || i === table.rows.length - 1} onClick={() => apply(moveChooserRow(graph, id, i, i + 1), `Move ${id} row ${i + 1} down`)}>↓</button>
                <button class="icon" aria-label={`Remove ${id} row ${i + 1}`} disabled={readOnly} onClick={() => apply(removeChooserRow(graph, id, i), `Remove ${id} row ${i + 1}`)}>×</button>
              </td>
            </tr>
          ))}
          <tr class="ag-fallback">
            <td />
            <td>Otherwise</td>
            <td>
              <select aria-label={`${id} fallback`} value={table.fallback ?? ""} disabled={readOnly} onChange={(e) => apply(setChooserFallback(graph, id, (e.currentTarget as HTMLSelectElement).value || null), `Change ${id} fallback`)}>
                <option value="">Nothing</option>
                {results.map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
              </select>
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <button class="ag-add" disabled={readOnly || !first} title={first ? undefined : "Add a node for a row to pick first"}
        onClick={() => {
          const c = newCondition();
          if (first && c) apply(addChooserRow(graph, id, first.id, c), `Add a row to ${id}`);
        }}>+ Row</button>
    </div>
  );
}
