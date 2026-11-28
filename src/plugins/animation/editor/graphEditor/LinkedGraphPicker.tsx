// The linked-graph picker and the slot fields (ADR 0373 "a linked-graph picker"; ADR 0372 slots and linked graphs): a
// linked node's name (what `anim.link` names) and its default graph (any graph but this one, so it can't link itself),
// and a slot's name (what `anim.play(…, { slot })` names) and group. Each edit is refused-or-next (duplicate names, the
// graph linking itself), one undo step.
import type { AnimGraph, GraphNode } from "../../../../engine/animation/animGraph";
import { AssetPicker, TextField, editor, type EditResult, assetRefTarget } from "../../../../editor/sdk";
import { setLinked, setSlot } from "./graphEditLogic";

export interface LinkedGraphPickerProps {
  graph: AnimGraph;
  node: GraphNode;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  /** The graph being edited's project path. */
  self: string;
}

export function LinkedGraphPicker(props: LinkedGraphPickerProps) {
  const { graph, node, apply, readOnly = false, self } = props;
  if (node.linked) {
    const graphRef = node.linked.graph ?? "";
    return (
      <div class="ag-side" role="group" aria-label={`Linked graph ${node.linked.name}`}>
        <div class="ag-section-head"><span>Linked graph</span><span class="ag-muted">code swaps it per Animator with anim.link</span></div>
        <label class="ag-field"><span>Name</span>
          <TextField value={node.linked.name} label={`${node.id} linked name`} onCommit={(v) => apply(setLinked(graph, node.id, { name: v }, self), `Rename linked graph ${node.linked!.name}`)} />
        </label>
        <label class="ag-field"><span>Default graph</span>
          <AssetPicker value={graphRef} kinds={["animgraph"]} label={`${node.id} default graph`} disabled={readOnly} accepts={(p) => p !== self}
            onCommit={(v) => apply(setLinked(graph, node.id, { graph: v || null }, self), `Link ${node.linked!.name} to ${v ? editor.assets.fileName(assetRefTarget(v)) : "nothing"}`)} />
        </label>
        {graphRef && (
          <button class="ag-link" onClick={() => editor.assets.open(assetRefTarget(graphRef))}>Open the linked graph</button>
        )}
      </div>
    );
  }
  if (node.slot) {
    return (
      <div class="ag-side" role="group" aria-label={`Slot ${node.slot.name}`}>
        <div class="ag-section-head"><span>Slot</span><span class="ag-muted">code plays clips into it by name</span></div>
        <label class="ag-field"><span>Name</span>
          <TextField value={node.slot.name} label={`${node.id} slot name`} onCommit={(v) => apply(setSlot(graph, node.id, { name: v }), `Rename slot ${node.slot!.name}`)} />
        </label>
        <label class="ag-field"><span>Group</span>
          <TextField value={node.slot.group ?? ""} label={`${node.id} slot group`} placeholder="none" onCommit={(v) => apply(setSlot(graph, node.id, { group: v || null }), `Set slot ${node.slot!.name} group`)} />
        </label>
      </div>
    );
  }
  return null;
}
