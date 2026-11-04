// The Blackboard (ADR 0060): the effect's properties, as in VFX Graph. Exposed properties show on
// each ParticleSystem as per-instance overrides and scripts set them with `setProperty`. Drag a
// property onto the canvas (or click Place) to read it with a Property node.
import { GRAPH_PROPERTY_TYPES, type GraphProperty, type GraphPropertyType } from "../../../engine/scene/particleGraph";
import { status } from "../../state";
import { PROPERTY_LABELS, addProperty, moveProperty, removeProperty, renameProperty, setPropertyExposed, setPropertyValue, whyNotPropertyName } from "../../particleGraph/graphEdit";
import { useGraphEditor } from "./editorContext";
import { AssetValue, ColorSwatch, CurveValue, GradientValue, NumberValue, VectorValue, asGradient, asKeys, fieldOf } from "./valueFields";

/** The drag data type of a property dragged from the Blackboard. */
export const PROPERTY_DRAG = "application/x-myco-particle-property";

function PropertyValue(props: { prop: GraphProperty }) {
  const { graph, readOnly, commit, assets } = useGraphEditor();
  const { prop } = props;
  const set = (v: GraphProperty["value"]) => commit(setPropertyValue(graph, prop.name, v));
  const label = `${prop.name} value`;
  switch (prop.type) {
    case "number":
      return <NumberValue label={label} value={prop.value} forms={["constant", "random"]} readOnly={readOnly} onChange={set} />;
    case "vector2":
    case "vector3":
      return <VectorValue label={label} value={prop.value} size={prop.type === "vector2" ? 2 : 3} readOnly={readOnly} onChange={set} />;
    case "color":
      return <ColorSwatch label={label} value={typeof prop.value === "string" ? prop.value : "#ffffff"} readOnly={readOnly} onChange={set} />;
    case "curve":
      return <CurveValue label={label} keys={asKeys(fieldOf(prop.value, "curve"))} readOnly={readOnly} onChange={(keys) => set({ curve: keys })} />;
    case "gradient":
      return <GradientValue label={label} gradient={asGradient(fieldOf(prop.value, "gradient"))} readOnly={readOnly} onChange={(g) => set({ gradient: g })} />;
    case "texture":
      return <AssetValue label={label} value={typeof prop.value === "string" ? prop.value : ""} assets={assets.images} none="(none)" readOnly={readOnly} onChange={set} />;
  }
}

export function Blackboard(props: { collapsed: boolean; onCollapse(collapsed: boolean): void; placeNode(name: string): void }) {
  const { graph, readOnly, commit } = useGraphEditor();
  if (props.collapsed) {
    return (
      <aside class="pg-blackboard collapsed" aria-label="Blackboard">
        <button type="button" class="pg-fold" aria-label="Show the Blackboard" title="Show the Blackboard (properties)" onClick={() => props.onCollapse(false)}>
          ▸
        </button>
      </aside>
    );
  }
  return (
    <aside class="pg-blackboard" aria-label="Blackboard">
      <div class="pg-blackboard-head">
        <button type="button" class="pg-fold" aria-label="Hide the Blackboard" title="Hide the Blackboard" onClick={() => props.onCollapse(true)}>
          ◂
        </button>
        <span>Blackboard</span>
        <select
          aria-label="Add property"
          title="Add a property"
          disabled={readOnly}
          value=""
          onChange={(e) => {
            const type = (e.currentTarget as HTMLSelectElement).value as GraphPropertyType;
            (e.currentTarget as HTMLSelectElement).value = "";
            if (type) commit(addProperty(graph, type).graph);
          }}
        >
          <option value="">+ Add…</option>
          {GRAPH_PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROPERTY_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      {graph.properties.length === 0 && <p class="pg-hint">Properties are values each Particle System can override, and scripts can set (setProperty). Add one, then drag it onto the canvas.</p>}
      {graph.properties.map((p, i) => (
        <div
          key={p.name}
          class="pg-property"
          aria-label={`Property ${p.name}`}
          draggable={!readOnly}
          onDragStart={(e) => {
            if ((e.target as HTMLElement).closest("input, select, button, textarea")) return e.preventDefault();
            e.dataTransfer?.setData(PROPERTY_DRAG, p.name);
            e.dataTransfer?.setData("text/plain", p.name);
          }}
        >
          <div class="pg-property-row">
            <span class="pg-grip" title="Drag onto the canvas to read this property">
              ⠿
            </span>
            <input
              type="text"
              aria-label="Property name"
              disabled={readOnly}
              value={p.name}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const name = (e.currentTarget as HTMLInputElement).value;
                const why = whyNotPropertyName(graph, p.name, name);
                if (why) {
                  status.value = { kind: "error", text: `Can't rename ${p.name}: ${why}.` };
                  (e.currentTarget as HTMLInputElement).value = p.name;
                } else commit(renameProperty(graph, p.name, name));
              }}
            />
            <span class="pg-property-type">{PROPERTY_LABELS[p.type]}</span>
          </div>
          <div class="pg-property-row">
            <PropertyValue prop={p} />
          </div>
          <div class="pg-property-row pg-property-actions">
            <label title="Show on each Particle System as an override">
              <input type="checkbox" aria-label={`${p.name} exposed`} disabled={readOnly} checked={p.exposed} onChange={(e) => commit(setPropertyExposed(graph, p.name, (e.currentTarget as HTMLInputElement).checked))} /> Exposed
            </label>
            <span class="pg-spacer" />
            <button type="button" title="Place a node that reads this property" disabled={readOnly} onClick={() => props.placeNode(p.name)}>
              Place
            </button>
            <button type="button" title="Move up" aria-label={`Move ${p.name} up`} disabled={readOnly || i === 0} onClick={() => commit(moveProperty(graph, p.name, -1))}>
              ↑
            </button>
            <button type="button" title="Move down" aria-label={`Move ${p.name} down`} disabled={readOnly || i === graph.properties.length - 1} onClick={() => commit(moveProperty(graph, p.name, 1))}>
              ↓
            </button>
            <button type="button" class="danger" title="Remove the property and the nodes that read it" aria-label={`Remove ${p.name}`} disabled={readOnly} onClick={() => commit(removeProperty(graph, p.name))}>
              ×
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}
