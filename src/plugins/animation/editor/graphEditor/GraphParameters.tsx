// The graph's parameters panel (ADR 0373 "Parameters through the one parameter list module (0304)", with the shared
// parameter card): the SDK's `ParameterCards` over the graph's list (`parameterLogic.ts`), with the graph's own fields in
// each card — its type, a typed default and the replicate / predicted / computed flags — and where it is used.
import { GRAPH_PARAM_TYPES, type AnimGraph, type GraphParamType, type GraphParameter } from "../../../../engine/animation/animGraph";
import { ParameterCards, type EditResult } from "../../../../editor/sdk";
import { graphParameters, parameterOf, parameterUses, setParameterDefault, setParameterFlag, setParameterType } from "./parameterLogic";
import type { PlacedProblem } from "./problemLogic";

export interface GraphParametersProps {
  graph: AnimGraph;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  problems?: (parameter: string) => readonly PlacedProblem[];
}

function DefaultField(props: { p: GraphParameter; disabled: boolean; set(v: GraphParameter["default"]): void }) {
  const { p } = props;
  const label = `${p.name} default`;
  if (p.type === "bool") return <input type="checkbox" aria-label={label} checked={p.default === true} disabled={props.disabled} onChange={(e) => props.set((e.currentTarget as HTMLInputElement).checked)} />;
  if (p.type === "node") return <input type="text" aria-label={label} value={typeof p.default === "string" ? p.default : ""} placeholder="none" disabled={props.disabled} onChange={(e) => props.set((e.currentTarget as HTMLInputElement).value.trim() || null)} />;
  if (p.type === "float" || p.type === "int") {
    return <input type="number" step={p.type === "int" ? "1" : "any"} aria-label={label} value={p.default as number} disabled={props.disabled}
      onChange={(e) => { const n = (e.currentTarget as HTMLInputElement).valueAsNumber; if (Number.isFinite(n)) props.set(n); }} />;
  }
  const v = p.default as readonly number[];
  return (
    <span class="ag-vec">
      {v.map((c, k) => (
        <input key={k} type="number" step="any" aria-label={`${label} ${"xyzw"[k]}`} value={c} disabled={props.disabled}
          onChange={(e) => { const n = (e.currentTarget as HTMLInputElement).valueAsNumber; if (Number.isFinite(n)) props.set(v.map((x, j) => (j === k ? n : x))); }} />
      ))}
    </span>
  );
}

export function GraphParameters(props: GraphParametersProps) {
  const { graph, apply, readOnly = false } = props;
  return (
    <div class="ag-parameters">
      <ParameterCards
        list={graphParameters}
        holder={graph}
        apply={apply}
        readOnly={readOnly}
        hint="set by code (anim.set) and read by conditions and nodes"
        empty="No parameters yet."
        removeTitle={(d) => {
          const u = parameterUses(graph, d.name);
          return u.conditions ? "Conditions compare it: remove those rows first" : u.bindings.length ? `Remove it (${u.bindings.join(", ")} go back to their defaults)` : "Remove it";
        }}
        fields={(d) => {
          const p = parameterOf(graph, d.name);
          if (!p) return null;
          const uses = parameterUses(graph, p.name);
          const used = [...(uses.conditions ? [`${uses.conditions} condition${uses.conditions === 1 ? "" : "s"}`] : []), ...uses.bindings, ...uses.layers.map((l) => `layer ${l}`)];
          return (
            <div class="param-fields">
              <label class="param-field"><span>Type</span>
                <select aria-label={`${p.name} type`} value={p.type} disabled={readOnly} onChange={(e) => apply(setParameterType(graph, p.name, (e.currentTarget as HTMLSelectElement).value as GraphParamType), `Make ${p.name} ${(e.currentTarget as HTMLSelectElement).value}`)}>
                  {GRAPH_PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label class="param-field"><span>Default</span>
                <DefaultField p={p} disabled={readOnly} set={(v) => apply(setParameterDefault(graph, p.name, v), `Set ${p.name} default`)} />
              </label>
              {(["replicate", "predicted", "computed"] as const).map((f) => (
                <label class="param-field ag-flag" key={f} title={f === "computed" ? "Filled by anim.compute in Gather, not set by code" : f === "predicted" ? "Predicted on clients (needs replicate)" : "Sent to clients"}>
                  <span>{f === "replicate" ? "Replicated" : f === "predicted" ? "Predicted" : "Computed"}</span>
                  <input type="checkbox" aria-label={`${p.name} ${f}`} checked={p[f]} disabled={readOnly} onChange={(e) => apply(setParameterFlag(graph, p.name, f, (e.currentTarget as HTMLInputElement).checked), `${(e.currentTarget as HTMLInputElement).checked ? "Set" : "Clear"} ${p.name} ${f}`)} />
                </label>
              ))}
              <span class="param-field param-wide ag-muted">{used.length ? `Used by ${used.join(", ")}` : "Not used yet"}</span>
              {(props.problems?.(p.name) ?? []).map((x, k) => <span key={k} class={`param-field param-wide ag-problem ${x.severity}`}>{x.message}</span>)}
            </div>
          );
        }}
      />
    </div>
  );
}
