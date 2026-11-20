// The wiring gesture (ADR 0259): pressing a port draws a wire; letting go over a port the graph
// accepts connects it, over one it refuses shows why, and in empty space opens what the panel says
// (the node search). Pressing a wired input picks its wire up from the input end: it can be dropped
// on another input, or in empty space to remove it. A panel plugs in its graph's wire edits
// (`GraphWiringEdits`: what feeds an input, why a wire is refused, connect and disconnect) and what a
// drop in space opens; the layer gives back the draft wire, the detached input and the refusal hint
// to draw. `wireGesture` is the gesture's decisions as pure functions; `useGraphWiring` runs it on
// the canvas through xyflow (`./xyflow.ts`).
import { useMemo, useRef, useState } from "preact/hooks";
import { startConnection, type CanvasNode, type DraftWire, type Point, type View } from "./xyflow";

export type PortSide = "input" | "output";

/** A port on the canvas: its node, its id on the node, its side, and its reference (`node.port`, the graph's own spelling). */
export interface GraphPort {
  node: string;
  port: string;
  side: PortSide;
  ref: string;
}

/** A graph's wire edits, pure functions from one graph to the next (as the graph document's are). */
export interface GraphWiringEdits<G> {
  /** The output reference wired into the input `ref`, or null (or undefined) if none is. */
  sourceOf(graph: G, input: string): string | null | undefined;
  /** Why the output `from` can't be wired to the input `to`, said for the user, or null if it can. */
  whyNot(graph: G, from: string, to: string): string | null;
  /** Wire `from` to `to` (replacing what the input had); unchanged if it isn't allowed. */
  connect(graph: G, from: string, to: string): G;
  /** Remove the wire into the input `input`. */
  disconnect(graph: G, input: string): G;
  /** Split a reference into its node and port (the inverse of the panel's `node.port` spelling). */
  split(ref: string): { node: string; port: string };
}

/** What pressing a port starts, decided from the graph at the press. */
export interface WireGesture<G> {
  /** The port the wire is drawn from: the pressed one, or the output feeding a pressed wired input. */
  anchor: GraphPort;
  /** The input whose wire was picked up (drawn as gone while the gesture lasts), or null. */
  detached: string | null;
  /** Why the wire can't end at `from` → `to`, judged on the graph the connect applies to (a picked-up wire already removed). */
  whyNot(graph: G, from: string, to: string): string | null;
  /** The edit when the wire lands on a port it may end on. */
  connect(graph: G, from: string, to: string): G;
  /** The edit when it's let go in empty space: the picked-up wire removed, or null for a new wire (the panel opens its search). */
  drop(graph: G): G | null;
}

/** Decide what pressing `port` does in `graph`. */
export function wireGesture<G>(edits: GraphWiringEdits<G>, graph: G, port: GraphPort): WireGesture<G> {
  const src = port.side === "input" ? edits.sourceOf(graph, port.ref) : null;
  if (!src) {
    return {
      anchor: port,
      detached: null,
      whyNot: (g, from, to) => edits.whyNot(g, from, to),
      connect: (g, from, to) => edits.connect(g, from, to),
      drop: () => null,
    };
  }
  const input = port.ref;
  const { node, port: id } = edits.split(src);
  const without = (g: G) => edits.disconnect(g, input);
  return {
    anchor: { node, port: id, side: "output", ref: src },
    detached: input,
    whyNot: (g, from, to) => edits.whyNot(without(g), from, to),
    connect: (g, from, to) => edits.connect(without(g), from, to),
    drop: (g) => without(g),
  };
}

/** What the wiring uses of the canvas (`useGraphCanvas` returns it). */
export interface GraphWiringCanvas {
  readonly pane: { readonly current: HTMLElement | null };
  readonly viewRef: { readonly current: View };
  panBy(dx: number, dy: number): Promise<boolean>;
}

export interface GraphWiringOptions<G> {
  /** The flow id prefix of this panel's port elements (`handleProps`), such as `sg` or `pg`. */
  flowPrefix: string;
  edits: GraphWiringEdits<G>;
  /** The graph as it is now (the document's latest). */
  graph(): G;
  /** Apply an edit (one undo step). */
  commit(next: G): void;
  /** A read-only file: ports don't start wires. */
  readOnly: boolean;
  /** The panel's focusable root, which takes the keyboard when a port is pressed. */
  root: { readonly current: HTMLElement | null };
  /** The canvas, read when a gesture starts (so this hook can come before `useGraphCanvas`). */
  canvas(): GraphWiringCanvas;
  /** The canvas nodes now, with their ports. */
  nodes(): readonly CanvasNode[];
  /** A new wire from `from` was let go in empty space at this pane point: open what the panel offers there (or nothing). */
  onDropInSpace(at: Point, from: GraphPort): void;
}

/** The wiring gesture of a graph panel: hand `onPortDown` to the port elements and draw `draft`, `detached` and `hint`. */
export function useGraphWiring<G>(o: GraphWiringOptions<G>) {
  const [draft, setDraft] = useState<DraftWire | null>(null);
  const [detached, setDetached] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const flowId = useMemo(() => `${o.flowPrefix}${Math.random().toString(36).slice(2, 8)}`, []);
  /** Why the wire being drawn can't end at the port under the pointer (set while xyflow checks it, read on its next draft). */
  const refusal = useRef<string | null>(null);

  /** Press a port element (on its mousedown). */
  const onPortDown = (e: MouseEvent, node: string, port: string, side: PortSide) => {
    if (e.button !== 0 || o.readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    o.root.current?.focus({ preventScroll: true });
    const canvas = o.canvas();
    const pane = canvas.pane.current;
    if (!pane) return;
    const pressed: GraphPort = { node, port, side, ref: `${node}.${port}` };
    const gesture = wireGesture(o.edits, o.graph(), pressed);
    const { anchor } = gesture;
    const el = gesture.detached ? pane.querySelector(`[data-id="${flowId}-${anchor.node}-${anchor.port}-source"]`) : (e.currentTarget as Element);
    if (!el) return;
    setDetached(gesture.detached);
    startConnection(e, el, anchor.node, anchor.port, anchor.side, {
      flowId,
      pane,
      nodes: o.nodes,
      view: () => canvas.viewRef.current,
      panBy: (dx, dy) => canvas.panBy(dx, dy),
      canConnect: (from, to) => {
        refusal.current = gesture.whyNot(o.graph(), from, to);
        return !refusal.current;
      },
      onDraft: (d) => {
        setDraft(d);
        setHint(d && !d.valid ? refusal.current : null);
        refusal.current = null;
      },
      onConnect: (from, to) => o.commit(gesture.connect(o.graph(), from, to)),
      onDropInSpace: (at) => {
        const next = gesture.drop(o.graph());
        if (next) o.commit(next);
        else o.onDropInSpace(at, anchor);
      },
      onEnd: () => {
        setHint(null);
        setDetached(null);
      },
    });
  };

  return { flowId, draft, detached, hint, onPortDown };
}
