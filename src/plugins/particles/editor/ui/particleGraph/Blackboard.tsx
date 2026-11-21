// The Blackboard (ADR 0060): the effect's properties, as in VFX Graph. Exposed properties show on
// each ParticleSystem as per-instance overrides and scripts set them with `setProperty`. Drag a
// property onto the canvas (or click Place) to read it with a Property node.
import { GRAPH_PROPERTY_TYPES, type GraphPropertyType } from "../../../../../engine/scene/particleGraph";
import { PROPERTY_LABELS, particleGraphEdits, setPropertyExposed } from "../../particleGraph/graphEdit";
import { useGraphEditor } from "./editorContext";
import { ParticlePropertyValue } from "../ParticlePropertyValue";
import { editor } from "../../../../../editor/sdk";

/** The drag data type of a property dragged from the Blackboard. */
export const PROPERTY_DRAG = "application/x-myco-particle-property";

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
            if (type) commit(particleGraphEdits.addProperty(graph, type).graph);
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
                const why = particleGraphEdits.whyNotPropertyName(graph, p.name, name);
                if (why) {
                  editor.messages.error(`Can't rename ${p.name}: ${why}.`);
                  (e.currentTarget as HTMLInputElement).value = p.name;
                } else commit(particleGraphEdits.renameProperty(graph, p.name, name));
              }}
            />
            <span class="pg-property-type">{PROPERTY_LABELS[p.type]}</span>
          </div>
          <div class="pg-property-row">
            <ParticlePropertyValue type={p.type} value={p.value} label={`${p.name} value`} readOnly={readOnly} onValue={(v) => commit(particleGraphEdits.setPropertyValue(graph, p.name, v))} />
          </div>
          <div class="pg-property-row pg-property-actions">
            <label title="Show on each Particle System as an override">
              <input type="checkbox" aria-label={`${p.name} exposed`} disabled={readOnly} checked={p.exposed} onChange={(e) => commit(setPropertyExposed(graph, p.name, (e.currentTarget as HTMLInputElement).checked))} /> Exposed
            </label>
            <span class="pg-spacer" />
            <button type="button" title="Place a node that reads this property" disabled={readOnly} onClick={() => props.placeNode(p.name)}>
              Place
            </button>
            <button type="button" title="Move up" aria-label={`Move ${p.name} up`} disabled={readOnly || i === 0} onClick={() => commit(particleGraphEdits.moveProperty(graph, p.name, -1))}>
              ↑
            </button>
            <button type="button" title="Move down" aria-label={`Move ${p.name} down`} disabled={readOnly || i === graph.properties.length - 1} onClick={() => commit(particleGraphEdits.moveProperty(graph, p.name, 1))}>
              ↓
            </button>
            <button type="button" class="danger" title="Remove the property and the nodes that read it" aria-label={`Remove ${p.name}`} disabled={readOnly} onClick={() => commit(particleGraphEdits.removeProperty(graph, p.name))}>
              ×
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}
