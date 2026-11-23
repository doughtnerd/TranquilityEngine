// A node's card (ADR 0373 "Node cards generated from the node catalogue's schema", including third-party nodes, as
// audio's effect cards are): its id and name, then one typed field per parameter its kind declares (`graphNodes/`'s
// `NodeParamSchema`: kind, unit, range, default, animatable), with an asset picker for asset kinds and a parameter
// binding for parameter references and animatable values; the compiler's problems sit under the field they name. No
// field is written by hand per kind: a kind added to the catalogue (or a plugin node's schema) gets its card from this.
import type { ComponentChildren } from "preact";
import type { AnimGraph, GraphNode, NodeParamValue } from "../../../../engine/animation/animGraph";
import type { NodeParamSchema, ParamUnit } from "../../../../engine/animation/graphNodes";
import { AssetPicker, type EditResult } from "../../../../editor/sdk";
import { ASSET_FIELD_KINDS, FAMILY_LABELS, kindLabel, renameNode, schemaOf, setNodeName, setNodeParam, setOutput } from "./graphEditLogic";
import type { PlacedProblem } from "./problemLogic";

export interface NodeCardProps {
  graph: AnimGraph;
  node: GraphNode;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  /** Problems per field name ("" for the node's own). */
  problems?: (field: string) => readonly PlacedProblem[];
  /** The graph's own path (a linked-graph field doesn't offer it). */
  self?: string;
  /** Under the fields (the kind's side-table editor). */
  children?: ComponentChildren;
}

const UNIT_SUFFIX: Readonly<Record<ParamUnit, string>> = {
  none: "", seconds: "s", meters: "m", degrees: "°", radians: "rad", ratio: "", percent: "%", hertz: "Hz", metersPerSecond: "m/s", degreesPerSecond: "°/s", multiplier: "×",
};

const fieldLabel = (s: NodeParamSchema) => kindLabel(s.name);

/** List text as the field shows it: comma-separated. */
const listText = (v: NodeParamValue | undefined) => (Array.isArray(v) ? (v as readonly unknown[]).join(", ") : "");

/** List text back to a value of `s`'s list kind (numbers for number lists, names otherwise); empty is the default. */
function parseList(s: NodeParamSchema, text: string): NodeParamValue | undefined {
  const parts = text.split(",").map((x) => x.trim()).filter((x) => x !== "");
  if (parts.length === 0) return undefined;
  if (s.kind === "floatList" || s.kind === "intList") return parts.map(Number);
  return parts;
}

/** One field: the control its kind takes. */
function ParamField(props: { graph: AnimGraph; node: GraphNode; s: NodeParamSchema; set(value: NodeParamValue | undefined): void; readOnly: boolean; self?: string }) {
  const { graph, node, s, set, readOnly, self } = props;
  const value = node.params[s.name];
  const label = `${node.id} ${s.name}`;
  const current = value ?? s.default ?? undefined;
  const params = (types = s.parameterTypes) => graph.parameters.filter((p) => !types || types.includes(p.type));
  const numberInput = (v: number | undefined, step: string, commit: (n: number) => void, aria = label) => (
    <input type="number" step={step} min={s.min} max={s.max} aria-label={aria} value={v ?? ""} placeholder={s.default === null ? "none" : undefined} disabled={readOnly}
      onChange={(e) => { const n = (e.currentTarget as HTMLInputElement).valueAsNumber; if (Number.isFinite(n)) commit(n); else if ((e.currentTarget as HTMLInputElement).value === "") set(undefined); }} />
  );
  switch (s.kind) {
    case "float": {
      const bound = typeof value === "string" ? value : "";
      return (
        <span class="ag-field-control">
          {!bound && numberInput(typeof current === "number" ? current : undefined, "any", (n) => set(n))}
          {s.animatable && (
            <select aria-label={`${label} parameter`} title="Drive it with a float parameter instead" value={bound} disabled={readOnly} onChange={(e) => set((e.currentTarget as HTMLSelectElement).value || undefined)}>
              <option value="">{bound ? "Constant" : "No parameter"}</option>
              {params().map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          )}
        </span>
      );
    }
    case "int": return numberInput(typeof current === "number" ? current : undefined, "1", (n) => set(n));
    case "bool": return <input type="checkbox" aria-label={label} checked={current === true} disabled={readOnly} onChange={(e) => set((e.currentTarget as HTMLInputElement).checked)} />;
    case "enum":
      return (
        <select aria-label={label} value={String(current ?? s.choices![0])} disabled={readOnly} onChange={(e) => set((e.currentTarget as HTMLSelectElement).value)}>
          {s.choices!.map((c) => <option key={c} value={c}>{kindLabel(c)}</option>)}
        </select>
      );
    case "vec2": case "vec3": case "quat": {
      const v = (Array.isArray(current) ? current : []) as number[];
      const n = s.kind === "vec2" ? 2 : s.kind === "vec3" ? 3 : 4;
      return (
        <span class="ag-vec">
          {Array.from({ length: n }, (_, k) => numberInput(v[k] ?? 0, "any", (x) => set(Array.from({ length: n }, (_, j) => (j === k ? x : (v[j] ?? 0)))), `${label} ${"xyzw"[k]}`))}
        </span>
      );
    }
    case "parameter":
      return (
        <select aria-label={label} value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={(e) => set((e.currentTarget as HTMLSelectElement).value || undefined)}>
          <option value="">None</option>
          {typeof value === "string" && !graph.parameters.some((p) => p.name === value) && <option value={value}>{value} (missing)</option>}
          {params().map((p) => <option key={p.name} value={p.name}>{p.name} ({p.type})</option>)}
        </select>
      );
    case "asset":
      return (
        <AssetPicker
          value={typeof value === "string" ? value : ""}
          kinds={s.asset ? ASSET_FIELD_KINDS[s.asset] : []}
          label={label}
          disabled={readOnly}
          accepts={self ? (p) => p !== self : undefined}
          onCommit={(v) => set(v || undefined)}
        />
      );
    case "name": case "bone": case "target":
      return (
        <input type="text" aria-label={label} value={typeof value === "string" ? value : ""} placeholder={s.kind === "bone" ? "bone or Humanoid role" : "none"} disabled={readOnly}
          onChange={(e) => set((e.currentTarget as HTMLInputElement).value.trim() || undefined)} />
      );
    default:
      return (
        <input type="text" aria-label={label} value={listText(value)} placeholder={s.kind === "parameterList" ? "parameter names, comma-separated" : "comma-separated"} disabled={readOnly}
          onChange={(e) => set(parseList(s, (e.currentTarget as HTMLInputElement).value))} />
      );
  }
}

export function NodeCard(props: NodeCardProps) {
  const { graph, node, apply, readOnly = false } = props;
  const schema = schemaOf(node);
  const own = props.problems?.("") ?? [];
  const isOutput = graph.output === node.id;
  return (
    <div class={`ag-card ag-family-${node.family}`} role="group" aria-label={`Node ${node.id}`} data-node-card={node.id}>
      <div class="ag-card-head">
        <span class="ag-card-kind">{FAMILY_LABELS[node.family]} · {kindLabel(node.kind)}</span>
        <label class="ag-output-toggle" title="The node whose pose the graph outputs">
          <input type="checkbox" aria-label={`${node.id} is the output`} checked={isOutput} disabled={readOnly} onChange={(e) => apply(setOutput(graph, (e.currentTarget as HTMLInputElement).checked ? node.id : null), (e.currentTarget as HTMLInputElement).checked ? `Make ${node.id} the output` : "Clear the output")} />
          Output
        </label>
      </div>
      {schema?.doc && <p class="ag-muted ag-doc">{schema.doc}</p>}
      <div class="ag-fields">
        <label class="ag-field"><span>Id</span>
          <input type="text" aria-label={`${node.id} id`} value={node.id} disabled={readOnly} onChange={(e) => apply(renameNode(graph, node.id, (e.currentTarget as HTMLInputElement).value), `Rename node ${node.id}`)} />
        </label>
        <label class="ag-field"><span>Name</span>
          <input type="text" aria-label={`${node.id} name`} value={node.name} placeholder={kindLabel(node.kind)} disabled={readOnly} onChange={(e) => apply(setNodeName(graph, node.id, (e.currentTarget as HTMLInputElement).value), `Name node ${node.id}`)} />
        </label>
        {(schema?.params ?? []).filter((s) => !(node.kind === "blendSpace1D" || node.kind === "blendSpace2D") || s.name !== "coords").map((s) => {
          const problems = props.problems?.(s.name) ?? [];
          const unit = UNIT_SUFFIX[s.unit];
          return (
            <div class={`ag-field${problems.length ? " invalid" : ""}`} key={s.name} data-field={s.name} title={s.doc}>
              <span>{fieldLabel(s)}{unit && <span class="ag-unit"> ({unit})</span>}</span>
              <ParamField graph={graph} node={node} s={s} readOnly={readOnly} self={props.self}
                set={(v) => apply(setNodeParam(graph, node.id, s.name, v), `Set ${node.id} ${s.name}`)} />
              {problems.map((p, k) => <span key={k} class={`ag-problem ${p.severity}`}>{p.message}</span>)}
            </div>
          );
        })}
        {Object.keys(node.params).filter((k) => !schema?.params.some((s) => s.name === k)).map((k) => (
          <div class="ag-field invalid" key={k} data-field={k}>
            <span>{k}</span>
            <span class="ag-muted">not a {kindLabel(node.kind)} parameter</span>
            <button class="icon" aria-label={`Remove ${node.id} ${k}`} disabled={readOnly} onClick={() => apply(setNodeParam(graph, node.id, k, undefined), `Remove ${node.id} ${k}`)}>×</button>
          </div>
        ))}
      </div>
      {own.map((p, k) => <p key={k} class={`ag-problem ${p.severity}`}>{p.message}</p>)}
      {props.children}
    </div>
  );
}
