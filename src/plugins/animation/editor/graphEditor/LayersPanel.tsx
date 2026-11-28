// The layers and their masks (ADR 0373 "mask panels"; ADR 0372 layers): the graph's layers stacked over the output in
// order, each with the node it plays, its avatar mask (none: the full body), override or additive, its weight and the
// float parameter that may drive it. Every edit is refused-or-next (a duplicate name, a non-float weight parameter), one
// undo step.
import { LAYER_MODES, type AnimGraph, type LayerMode } from "../../../../engine/animation/animGraph";
import { AssetPicker, TextField, editor, type EditResult, assetRefTarget } from "../../../../editor/sdk";
import { addLayer, moveLayer, nodeTitle, removeLayer, setLayer } from "./graphEditLogic";
import type { PlacedProblem } from "./problemLogic";

export interface LayersPanelProps {
  graph: AnimGraph;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  problems?: (layer: string) => readonly PlacedProblem[];
}

export function LayersPanel(props: LayersPanelProps) {
  const { graph, apply, readOnly = false } = props;
  const floats = graph.parameters.filter((p) => p.type === "float");
  return (
    <div class="ag-layers" role="group" aria-label="Layers">
      <div class="ag-section-head"><span>Layers</span><span class="ag-muted">stacked over the output, first to last</span></div>
      {graph.layers.length === 0 && <p class="ag-muted">No layers: the output plays on the whole body.</p>}
      {graph.layers.map((l, i) => {
        const problems = props.problems?.(l.name) ?? [];
        return (
          <div class={`ag-layer${problems.length ? " invalid" : ""}`} key={l.name} role="group" aria-label={`Layer ${l.name}`} data-layer={l.name}>
            <div class="ag-layer-head">
              <TextField value={l.name} label={`Layer ${l.name} name`} onCommit={(v) => apply(setLayer(graph, l.name, { name: v }), `Rename layer ${l.name}`)} />
              <button class="icon" aria-label={`Move layer ${l.name} up`} disabled={readOnly || i === 0} onClick={() => apply(moveLayer(graph, l.name, -1), `Move layer ${l.name} up`)}>↑</button>
              <button class="icon" aria-label={`Move layer ${l.name} down`} disabled={readOnly || i === graph.layers.length - 1} onClick={() => apply(moveLayer(graph, l.name, 1), `Move layer ${l.name} down`)}>↓</button>
              <button class="icon" aria-label={`Remove layer ${l.name}`} disabled={readOnly} onClick={() => apply(removeLayer(graph, l.name), `Remove layer ${l.name}`)}>×</button>
            </div>
            <div class="ag-fields">
              <label class="ag-field"><span>Plays</span>
                <select aria-label={`Layer ${l.name} root`} value={l.root} disabled={readOnly} onChange={(e) => apply(setLayer(graph, l.name, { root: (e.currentTarget as HTMLSelectElement).value }), `Change layer ${l.name}`)}>
                  {graph.nodes.map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
                </select>
              </label>
              <label class="ag-field ag-field-wide"><span>Mask</span>
                <AssetPicker value={l.mask ?? ""} kinds={["avatarmask"]} label={`Layer ${l.name} mask`} none="Full body" disabled={readOnly}
                  onCommit={(v) => apply(setLayer(graph, l.name, { mask: v || null }), `Set layer ${l.name} mask`)} />
              </label>
              {l.mask && <button class="ag-link" onClick={() => editor.assets.open(assetRefTarget(l.mask!))}>Open the mask</button>}
              <label class="ag-field"><span>Mode</span>
                <select aria-label={`Layer ${l.name} mode`} value={l.mode} disabled={readOnly} onChange={(e) => apply(setLayer(graph, l.name, { mode: (e.currentTarget as HTMLSelectElement).value as LayerMode }), `Change layer ${l.name} mode`)}>
                  {LAYER_MODES.map((m) => <option key={m} value={m}>{m === "override" ? "Override" : "Additive"}</option>)}
                </select>
              </label>
              <label class="ag-field"><span>Weight</span>
                <input type="number" step="0.05" min={0} max={1} aria-label={`Layer ${l.name} weight`} value={l.weight} disabled={readOnly}
                  onChange={(e) => apply(setLayer(graph, l.name, { weight: (e.currentTarget as HTMLInputElement).valueAsNumber }), `Set layer ${l.name} weight`)} />
              </label>
              <label class="ag-field"><span>Weight parameter</span>
                <select aria-label={`Layer ${l.name} weight parameter`} value={l.weightParameter ?? ""} disabled={readOnly}
                  onChange={(e) => apply(setLayer(graph, l.name, { weightParameter: (e.currentTarget as HTMLSelectElement).value || null }), `Set layer ${l.name} weight parameter`)}>
                  <option value="">None</option>
                  {floats.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              </label>
            </div>
            {problems.map((p, k) => <p key={k} class={`ag-problem ${p.severity}`}>{p.message}</p>)}
          </div>
        );
      })}
      <button class="ag-add" disabled={readOnly || graph.nodes.length === 0} title={graph.nodes.length ? undefined : "Add a node for a layer to play first"} onClick={() => apply(addLayer(graph), "Add layer")}>+ Layer</button>
    </div>
  );
}
