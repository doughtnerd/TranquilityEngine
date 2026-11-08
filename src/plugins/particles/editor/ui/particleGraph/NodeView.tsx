// A value, operator, property or event node (ADR 0060): a compact card with typed output ports
// (marked "per particle" when the value varies per particle), input ports with inline fields
// while unwired, and the node's settings (curves and gradients in popovers, a Property node's
// Blackboard property in a dropdown).
import { useRef } from "preact/hooks";
import type { GraphNode } from "../../../../../engine/scene/particleGraph";
import type { NodeSettingDef } from "../../../../../engine/scene/particleNodes";
import { NO_DRAG, NO_PAN, NO_WHEEL, px, type Point } from "../../../../../editor/graph";
import { ASSET_INPUT, ASSET_OUTPUT, editorNodeDef, whyNotPortName } from "../../particleGraph/assetDocs";
import { setNodeInput, setNodeSetting } from "../../particleGraph/graphEdit";
import { status } from "../../../../../editor/state";
import { NumField } from "../particles/valueInputs";
import { Port, ProblemBadge } from "./BlockView";
import { useGraphEditor } from "./editorContext";
import { NODE_WIDTH } from "./layout";
import { useCanvasDrag, type DragHooks } from "./SystemView";
import { AssetValue, ChoiceValue, ColorSwatch, CurveValue, GradientValue, InlineValue, VectorValue, asGradient, asKeys } from "./valueFields";

function SettingField(props: { node: GraphNode; setting: NodeSettingDef }) {
  const { graph, readOnly, commit, assets } = useGraphEditor();
  const { node, setting } = props;
  const raw = node.settings?.[setting.name];
  const value = raw !== undefined ? raw : setting.default;
  const set = (v: unknown) => commit(setNodeSetting(graph, node.id, setting.name, v));
  const label = setting.label;
  switch (setting.kind) {
    case "number":
      return <NumField label={label} value={typeof value === "number" ? value : 0} disabled={readOnly} onCommit={set} />;
    case "enum":
      return <ChoiceValue label={label} value={String(value)} choices={setting.choices ?? []} readOnly={readOnly} onChange={set} />;
    case "curve":
      return <CurveValue label={label} keys={asKeys(value)} readOnly={readOnly} onChange={set} />;
    case "gradient": {
      // The ADR's example keeps a Gradient node's keys flat in its settings.
      const flat = raw === undefined && setting.name === "gradient" && Array.isArray(node.settings?.colors) ? node.settings : value;
      return <GradientValue label={label} gradient={asGradient(flat)} readOnly={readOnly} onChange={set} />;
    }
    case "color":
      return <ColorSwatch label={label} value={typeof value === "string" ? value : "#ffffff"} readOnly={readOnly} onChange={set} />;
    case "vector": {
      const size = Array.isArray(setting.default) ? setting.default.length : 3;
      return <VectorValue label={label} value={value} size={size} readOnly={readOnly} onChange={set} />;
    }
    default:
      if (node.type === "subgraph" && setting.name === "asset") {
        return <AssetValue label={label} value={String(value ?? "")} assets={assets.subgraphs} none="(pick a sub-graph)" readOnly={readOnly} onChange={set} />;
      }
      if ((node.type === ASSET_INPUT || node.type === ASSET_OUTPUT) && setting.name === "name") {
        return (
          <input
            type="text"
            class={`pg-text ${NO_DRAG}`}
            aria-label={label}
            disabled={readOnly}
            value={String(value ?? "")}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              const why = whyNotPortName(graph, node.id, el.value);
              if (why) {
                status.value = { kind: "info", text: why };
                el.value = String(value ?? "");
              } else set(el.value.trim());
            }}
          />
        );
      }
      if (node.type === "property" && setting.name === "name") {
        const names = graph.properties.map((p) => p.name);
        return (
          <select class={`pg-select ${NO_DRAG} ${NO_WHEEL}`} aria-label={label} disabled={readOnly} value={String(value)} onChange={(e) => set((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">(pick a property)</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {value && !names.includes(String(value)) && <option value={String(value)}>{`${value} (missing)`}</option>}
          </select>
        );
      }
      return <input type="text" class={`pg-text ${NO_DRAG}`} aria-label={label} disabled={readOnly} value={String(value ?? "")} onChange={(e) => set((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />;
  }
}

export function NodeView(props: { node: GraphNode; at: Point; selected: boolean; onDown(e: PointerEvent, id: string): void; drag: DragHooks }) {
  const api = useGraphEditor();
  const { node, at } = props;
  const { graph } = api;
  const el = useRef<HTMLDivElement>(null);
  useCanvasDrag(el, node.id, api.readOnly, props.drag);
  const def = editorNodeDef(node, api.resolve);
  const label = def?.label ?? `Unknown node ${node.type}`;
  const title = node.type === "property" && node.settings?.name ? String(node.settings.name) : label;
  const problems = api.problems.byItem.get(node.id);
  return (
    <div
      ref={el}
      class={`pg-node ${NO_PAN}${props.selected ? " selected" : ""}${def ? "" : " unknown"}${problems?.some((p) => p.severity === "error") ? " has-problem" : ""}`}
      style={{ left: px(at.x), top: px(at.y), width: px(NODE_WIDTH) }}
      data-owner={node.id}
      aria-label={`Node ${label}`}
      title={def?.description}
      onPointerDown={(e) => props.onDown(e, node.id)}
    >
      <div class={`pg-node-head cat-${(def?.category ?? "unknown").toLowerCase()}`}>
        <span class="pg-node-title">{title}</span>
        <ProblemBadge problems={problems} />
      </div>
      {def?.missing && (
        <p class="pg-missing" role="status" title="The sub-graph asset isn't in the project, or isn't a particle sub-graph. Pick one below.">
          {node.settings?.asset ? "Missing asset" : "No asset: pick one below"}
        </p>
      )}
      {def?.outputs.map((o) => {
        const ref = `${node.id}.${o.name}`;
        const type = api.typeOf(node, o.name) ?? o.type;
        const perParticle = type !== "event" && api.rateOf(ref) === "particle";
        const filled = type === "event" ? api.eventSources.has(node.id) : [...api.wired.values()].includes(ref);
        return (
          <div key={`o-${o.name}`} class="pg-row out">
            {perParticle && (
              <span class="pg-rate" title="Per particle: a value for each particle (not one per frame)">
                per particle
              </span>
            )}
            <span class="pg-row-label">{o.label}</span>
            <Port owner={node.id} port={o.name} side="output" type={type} label={o.label} filled={filled} title={`${o.label} (${type}${perParticle ? ", per particle" : ""})`} />
          </div>
        );
      })}
      {def?.inputs.map((i) => {
        const ref = `${node.id}.${i.name}`;
        const from = api.wired.get(ref);
        return (
          <div key={`i-${i.name}`} class={`pg-row in${from ? " wired" : ""}`}>
            {!i.noPort && <Port owner={node.id} port={i.name} side="input" type={i.type} label={i.label} filled={!!from} />}
            <span class="pg-row-label">{i.label}</span>
            {from ? (
              <span class="pg-wired-from">← {api.sourceLabel(from)}</span>
            ) : (
              <InlineValue
                type={i.block?.type ?? i.type}
                value={node.inputs?.[i.name]}
                fallback={i.default}
                forms={i.block?.forms}
                choices={i.block?.choices}
                min={i.block?.min}
                max={i.block?.max}
                step={i.block?.step}
                unit={i.block?.unit}
                label={i.label}
                readOnly={api.readOnly}
                onChange={(v) => api.commit(setNodeInput(graph, node.id, i.name, v))}
              />
            )}
          </div>
        );
      })}
      {def?.settings?.map((s) => (
        <div key={`s-${s.name}`} class="pg-row setting">
          <span class="pg-row-label">{s.label}</span>
          <SettingField node={node} setting={s} />
        </div>
      ))}
    </div>
  );
}
