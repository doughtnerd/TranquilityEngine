// A system (ADR 0060): a titled frame holding its four contexts top to bottom (Spawn, Initialize,
// Update, Output) joined by flow connectors, as in VFX Graph. Drag it by its title or a context
// header; double-click the title to rename it.
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CONTEXT_KINDS, type ParticleGraphSystem } from "../../../../../engine/scene/particleGraph";
import { addOutput, outputCount, renameSystem, setSystemEnabled } from "../../particleGraph/graphEdit";
import { ProblemBadge } from "./BlockView";
import { ContextView } from "./ContextView";
import { useGraphEditor } from "./editorContext";
import { SYSTEM_WIDTH } from "./layout";
import { NO_DRAG, NO_PAN, px, useNodeDrag, type GraphDragHooks, type Point } from "../../../../../editor/sdk";

function SystemName(props: { system: ParticleGraphSystem }) {
  const { graph, readOnly, commit } = useGraphEditor();
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (!editing) {
    return (
      <span class="pg-system-name" title={readOnly ? props.system.name : "Double-click to rename"} onDblClick={() => !readOnly && setEditing(true)}>
        {props.system.name}
      </span>
    );
  }
  const done = (save: boolean) => {
    const name = input.current?.value ?? "";
    setEditing(false);
    if (save) commit(renameSystem(graph, props.system.id, name));
  };
  return (
    <input
      ref={input}
      type="text"
      class={`pg-system-rename ${NO_DRAG}`}
      aria-label="System name"
      value={props.system.name}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      }}
    />
  );
}

export function SystemView(props: { system: ParticleGraphSystem; at: Point; selected: boolean; collapsed: boolean; onCollapse(collapsed: boolean): void; onDown(e: PointerEvent, id: string): void; drag: GraphDragHooks }) {
  const api = useGraphEditor();
  const { system, at } = props;
  const el = useRef<HTMLDivElement>(null);
  useNodeDrag(el, system.id, api.readOnly, props.drag);
  const off = system.enabled === false;
  return (
    <div
      ref={el}
      class={`pg-system ${NO_PAN}${props.selected ? " selected" : ""}${off ? " off" : ""}`}
      style={{ left: px(at.x), top: px(at.y), width: px(SYSTEM_WIDTH) }}
      data-owner={system.id}
      aria-label={`System ${system.name}`}
      onPointerDown={(e) => props.onDown(e, system.id)}
    >
      <div class="pg-system-head">
        <button type="button" class={`pg-fold ${NO_DRAG}`} aria-label={props.collapsed ? `Expand ${system.name}` : `Collapse ${system.name}`} aria-expanded={!props.collapsed} title={props.collapsed ? "Expand" : "Collapse"} onClick={() => props.onCollapse(!props.collapsed)}>
          {props.collapsed ? "▸" : "▾"}
        </button>
        <SystemName system={system} />
        <ProblemBadge problems={api.problems.byItem.get(system.id)} />
        <input type="checkbox" class={NO_DRAG} aria-label="System enabled" title={off ? "Enable the system" : "Disable the system (it doesn't play)"} disabled={api.readOnly} checked={!off} onChange={(e) => api.commit(setSystemEnabled(api.graph, system.id, (e.currentTarget as HTMLInputElement).checked))} />
      </div>
      {!props.collapsed && (
        <div class="pg-system-body">
          {CONTEXT_KINDS.map((kind, i) => (
            <Fragment key={kind}>
              {i > 0 && <div class="pg-flow" aria-hidden="true" />}
              <ContextView system={system} kind={kind} />
            </Fragment>
          ))}
          {Array.from({ length: outputCount(system) - 1 }, (_, i) => (
            <Fragment key={`output${i + 1}`}>
              <div class="pg-flow" aria-hidden="true" />
              <ContextView system={system} kind="output" output={i + 1} />
            </Fragment>
          ))}
          <button type="button" class="pg-add-output" aria-label={`Add output to ${system.name}`} title="Add another Output context (copies the main output's type and settings)" disabled={api.readOnly} onClick={() => api.commit(addOutput(api.graph, system.id).graph)}>
            + Output
          </button>
        </div>
      )}
    </div>
  );
}
