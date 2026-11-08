// The wires (ADR 0060): value wires from node outputs into node and block inputs, coloured by
// type (dashed amber when the source combines per-particle values, which needs the GPU backend),
// and event wires into systems' Start and Stop, drawn dotted and heavier. Click one to select it;
// Delete removes it.
import type { ParticleGraph } from "../../../../../engine/scene/particleGraph";
import { nodeDef } from "../../../../../engine/scene/particleNodes";
import { wirePath, type CanvasNode, type DraftWire, type Point } from "../../../../../editor/graph";
import { portPoint, portTypeClass } from "./layout";

export type WireSelection = { kind: "edge"; to: string } | { kind: "event"; from: string; to: string };

/** A value wire's or event wire's end as an owner (system or node) and a port on it. */
function endOf(graph: ParticleGraph, ref: string, side: "input" | "output", event: boolean): { owner: string; port: string } {
  const parts = ref.split(".");
  if (parts.length >= 3) return { owner: parts[0], port: parts.slice(1).join(".") };
  if (parts.length === 2) return { owner: parts[0], port: parts[1] };
  // An event node: its event output.
  const node = graph.nodes.find((n) => n.id === ref);
  const port = (event && node && nodeDef(node.type)?.outputs.find((o) => o.type === "event")?.name) || "out";
  return side === "output" ? { owner: ref, port } : { owner: ref, port: "" };
}

export function Wires(props: {
  graph: ParticleGraph;
  nodes: ReadonlyMap<string, CanvasNode>;
  /** Value-wire source → its type. */
  types: ReadonlyMap<string, string>;
  /** Value-wire targets the CPU backend can't run. */
  gpu: ReadonlySet<string>;
  selected: WireSelection | null;
  /** A value-wire target being re-wired (drawn as the draft instead). */
  detached: string | null;
  draft: DraftWire | null;
  onSelect(w: WireSelection): void;
}) {
  const { graph, nodes, selected } = props;
  const at = (ref: string, side: "input" | "output", event: boolean): Point | null => {
    const e = endOf(graph, ref, side, event);
    return portPoint(nodes, e.owner, e.port, side);
  };
  const hit = (d: string, w: WireSelection) => (
    <path
      class="sg-wire-hit"
      d={d}
      onPointerDown={(ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        props.onSelect(w);
      }}
    />
  );
  return (
    <svg class="sg-wires pg-wires">
      {graph.edges.map((e) => {
        if (e.to === props.detached) return null;
        const a = at(e.from, "output", false), b = at(e.to, "input", false);
        if (!a || !b) return null;
        const d = wirePath(a, b);
        const gpu = props.gpu.has(e.to);
        const isSel = selected?.kind === "edge" && selected.to === e.to;
        return (
          <g key={`e-${e.to}`} class={`sg-wire pg-wire ${portTypeClass(props.types.get(e.from))}${gpu ? " gpu" : ""}${isSel ? " selected" : ""}`} data-edge={`${e.from}>${e.to}`}>
            {gpu && <title>Needs the GPU backend: this chain combines per-particle values, so the input uses its own value for now.</title>}
            {hit(d, { kind: "edge", to: e.to })}
            <path class="sg-wire-line" d={d} />
          </g>
        );
      })}
      {graph.events.map((e) => {
        const a = at(e.from, "output", true), b = at(e.to, "input", true);
        if (!a || !b) return null;
        const d = wirePath(a, b);
        const isSel = selected?.kind === "event" && selected.from === e.from && selected.to === e.to;
        return (
          <g key={`v-${e.from}>${e.to}`} class={`sg-wire pg-wire pg-event-wire${isSel ? " selected" : ""}`} data-event={`${e.from}>${e.to}`}>
            {hit(d, { kind: "event", from: e.from, to: e.to })}
            <path class="sg-wire-line" d={d} />
          </g>
        );
      })}
      {props.draft && <path class={`sg-draft${props.draft.valid ? " valid" : ""}`} d={wirePath(props.draft.from, props.draft.to)} />}
    </svg>
  );
}
