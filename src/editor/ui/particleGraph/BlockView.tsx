// A block in a context's stack (ADR 0060): a title row with a drag handle, an enable toggle and a
// remove button, then one row per input: a port on the left edge to wire a node in, and the
// inline field (or, when wired, the name of what feeds it). Trigger Event blocks have an event
// output on the right. A block of an unknown type is kept and shown as a red row.
import type { ContextKind, GraphBlock, GraphProblem, ParticleGraphSystem } from "../../../engine/scene/particleGraph";
import { blockDef, type BlockInputDef } from "../../../engine/scene/particleBlocks";
import { customBlockPorts } from "../../../engine/scene/particleSubgraphs";
import { NO_DRAG, handleProps } from "../../graph";
import { blockInputs } from "../../particleGraph/assetDocs";
import { isWireableInput, removeBlock, setBlockEnabled, setBlockInput } from "../../particleGraph/graphEdit";
import { useGraphEditor } from "./editorContext";
import { portTypeClass } from "./layout";
import { InlineValue } from "./valueFields";

/** A red or amber dot listing the problems about something. */
export function ProblemBadge(props: { problems?: readonly GraphProblem[] }) {
  const list = props.problems;
  if (!list?.length) return null;
  const error = list.some((p) => p.severity === "error");
  return (
    <span class={`pg-badge ${error ? "error" : "warning"}`} role="img" aria-label={`${list.length} problem${list.length === 1 ? "" : "s"}`} title={list.map((p) => p.message).join("\n")}>
      {error ? "!" : "⚠"}
    </span>
  );
}

/** A port element: what xyflow needs to find it, plus what the panel measures. */
export function Port(props: { owner: string; port: string; side: "input" | "output"; type: string; label: string; filled?: boolean; title?: string }) {
  const api = useGraphEditor();
  const h = handleProps(api.flowId, props.owner, props.port, props.side);
  return (
    <span
      {...h}
      class={`${h.class} pg-port ${props.side === "input" ? "in" : "out"} ${portTypeClass(props.type)}${props.filled ? " filled" : ""}`}
      data-port={props.port}
      data-side={props.side}
      aria-label={`${props.label} ${props.side}`}
      title={props.title ?? `${props.label} (${props.type})`}
      onMouseDown={(e) => api.onPortDown(e, props.owner, props.port, props.side)}
    />
  );
}

function InputRow(props: { system: ParticleGraphSystem; block: GraphBlock; input: BlockInputDef }) {
  const api = useGraphEditor();
  const { system, block, input } = props;
  const port = `${block.id}.${input.name}`;
  const from = api.wired.get(`${system.id}.${port}`);
  const gpu = api.problems.gpuWires.has(`${system.id}.${port}`);
  const assets = input.type === "asset" ? (block.type === "custom" ? api.assets.blocks : api.assets.images) : undefined;
  return (
    <div class={`pg-input${from ? " wired" : ""}`}>
      {isWireableInput(input) && <Port owner={system.id} port={port} side="input" type={input.type} label={input.label} filled={!!from} />}
      <span class="pg-input-label" title={input.unit ? `${input.label} (${input.unit})` : input.label}>
        {input.label}
      </span>
      {from ? (
        <span class={`pg-wired-from${gpu ? " gpu" : ""}`} title={gpu ? "This wire needs the GPU backend; the block uses its own value for now." : `Wired from ${api.sourceLabel(from)}`}>
          ← {api.sourceLabel(from)}
        </span>
      ) : (
        <InlineValue
          type={input.type}
          value={block.inputs[input.name]}
          fallback={input.default}
          forms={input.forms}
          choices={input.choices}
          label={input.label}
          min={input.min}
          max={input.max}
          step={input.step}
          unit={input.unit}
          assets={assets}
          readOnly={api.readOnly}
          onChange={(v) => api.commit(setBlockInput(api.graph, system.id, block.id, input.name, v))}
        />
      )}
    </div>
  );
}

export function BlockView(props: { system: ParticleGraphSystem; kind: ContextKind; block: GraphBlock }) {
  const api = useGraphEditor();
  const { system, block } = props;
  const def = blockDef(block.type);
  const key = `${system.id}.${block.id}`;
  const off = block.enabled === false;
  const customMissing = block.type === "custom" && customBlockPorts(block, api.resolve).missing;
  const label = def ? def.label : `Unknown block ${block.type}`;
  const remove = (
    <button type="button" class={`pg-x ${NO_DRAG}`} aria-label="Remove block" title="Remove the block" disabled={api.readOnly} onClick={() => api.commit(removeBlock(api.graph, system.id, block.id))}>
      ×
    </button>
  );
  const handle = (
    <span
      class={`pg-drag ${NO_DRAG}${api.readOnly ? " disabled" : ""}`}
      aria-label="Drag to reorder"
      title={props.kind === "update" ? "Drag to reorder. Update blocks apply in order, top first." : "Drag to reorder"}
      onPointerDown={(e) => api.startBlockDrag(e, system.id, block.id)}
    >
      ⠿
    </span>
  );
  const cls = `pg-block${off ? " off" : ""}${api.selectedBlock === key ? " selected" : ""}${api.draggingBlock === key ? " dragging" : ""}${def ? "" : " unknown"}`;
  return (
    <div class={cls} data-block={block.id} aria-label={`Block ${label}`} title={def?.description} onPointerDown={() => api.selectBlock(key)}>
      <div class="pg-block-head">
        {handle}
        {def && <input type="checkbox" class={NO_DRAG} aria-label="Enabled" title={off ? "Enable the block" : "Disable the block"} disabled={api.readOnly} checked={!off} onChange={(e) => api.commit(setBlockEnabled(api.graph, system.id, block.id, (e.currentTarget as HTMLInputElement).checked))} />}
        <span class="pg-block-title">{label}</span>
        <ProblemBadge problems={api.problems.byItem.get(key)} />
        {remove}
        {def?.event && <Port owner={system.id} port={block.id} side="output" type="event" label="Event" filled={api.eventSources.has(key)} title="Event: wire it to another system's Start to spawn from these particles" />}
      </div>
      {blockInputs(block, api.resolve).map((input) => (
        <InputRow key={input.name} system={system} block={block} input={input} />
      ))}
      {block.type === "custom" && block.inputs.asset && customMissing && (
        <p class="pg-missing" role="status" title="The block asset isn't in the project, or isn't a particle block.">
          Missing asset
        </p>
      )}
    </div>
  );
}
