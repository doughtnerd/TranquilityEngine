// The rig stack as a list (ADR 0373 "rig-stack entries as a list with gizmos in the viewport"): the graph's rig nodes,
// each with what it acts on and its weight. Picking one selects its node in the graph and shows its gizmos in the scene
// view over the selected character (`rigGizmo.ts`).
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import { rigEntries } from "./rigLogic";

export interface RigEntriesProps {
  graph: AnimGraph;
  /** The picked entry's node id (its gizmos show), or null. */
  selected: string | null;
  onSelect(id: string | null): void;
}

export function RigEntries(props: RigEntriesProps) {
  const entries = rigEntries(props.graph);
  return (
    <div class="ag-rig" role="group" aria-label="Rig stack">
      <div class="ag-section-head"><span>Rig stack</span><span class="ag-muted">pick one to see its gizmos in the Scene view</span></div>
      {entries.length === 0 && <p class="ag-muted">No rig nodes. Add IK, look-at, spring or constraint nodes from the Rig family.</p>}
      <ul class="ag-rig-list" role="listbox" aria-label="Rig entries">
        {entries.map((e) => (
          <li key={e.id} role="option" aria-selected={props.selected === e.id} class={props.selected === e.id ? "active" : ""} onClick={() => props.onSelect(props.selected === e.id ? null : e.id)}>
            <span class="ag-rig-title">{e.title}</span>
            <span class="ag-muted">{e.kind}: {e.summary}</span>
            <span class="ag-rig-weight" title="Weight">{typeof e.weight === "number" ? `× ${e.weight}` : `× ${e.weight}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
