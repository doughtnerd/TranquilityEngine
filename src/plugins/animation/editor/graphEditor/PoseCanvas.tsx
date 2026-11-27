// The pose-node canvas of the animation graph editor (ADR 0373 "Built on `src/editor/graph/` (xyflow). Pose nodes and
// pins"): the graph's nodes (or one state's sub-graph) with their pose pins and wires, on the shared graph layer — pan and
// zoom (`useGraphCanvas`), the wiring gesture with its refusal hint (`useGraphWiring`), node drags (`useNodeDrag`), box
// select, the minimap and the node search over the catalogue. Edits are `graphEditLogic.ts`'s; the panel applies them as
// one labelled undo step each. Double-click a state machine to open its canvas.
import { useMemo, useRef, useState } from "preact/hooks";
import type { AnimGraph, GraphFamily, GraphNode } from "../../../../engine/animation/animGraph";
import { Minimap, NO_PAN, NodeSearchPopup, SelectionBox, WireRefusal, handleProps, isFieldTarget, px, startBoxSelect, toGraph, useGraphCanvas, useGraphSearch, useGraphWiring, useNodeDrag, wirePath, type CanvasNode, type EditResult, type GraphDragHooks, type GraphWiringEdits, type Point, type SearchItem, EmptyState } from "../../../../editor/sdk";
import {
  FAMILY_LABELS, OUT, addNode, catalogueEntries, connect, disconnect, inPin, inputPins, kindLabel, moveNodes, nodeById, nodeTitle, pinIndex, removeNodes, whyNotConnect, type Added,
} from "./graphEditLogic";
import { worst, type ProblemIndex } from "./problemLogic";
import { useLiveOverlay } from "../debugger/overlayContext";
import type { LiveNode } from "../debugger/overlayLogic";

export const NODE_W = 180;
const HEAD = 28;
const ROW = 22;

/** Where a node is drawn: its position, or a grid place by its index when it has none. */
export const nodePosition = (n: GraphNode, i: number): Point => (n.position ? { x: n.position[0], y: n.position[1] } : { x: (i % 4) * 230, y: Math.floor(i / 4) * 150 });
const KIND = 16;
const nodeHeight = (n: GraphNode) => HEAD + KIND + inputPins(n).length * ROW + 8;

/** A pin reference split into node and pin (ids have no dots). */
const split = (ref: string) => { const i = ref.lastIndexOf("."); return { node: ref.slice(0, i), port: ref.slice(i + 1) }; };

export interface PoseCanvasProps {
  graph: AnimGraph;
  /** The asset path (the view is kept per graph and canvas). */
  viewKey: string;
  /** The nodes shown (null: all of them). */
  visible: ReadonlySet<string> | null;
  selection: ReadonlySet<string>;
  onSelection(ids: ReadonlySet<string>): void;
  apply(result: EditResult<AnimGraph>, label: string): void;
  /** A node was added (on this canvas): a state's sub-graph takes it as its root when it has none. */
  onAdded?(added: Added): void;
  readOnly: boolean;
  problems: ProblemIndex;
  onOpenMachine(id: string): void;
}

interface PoseSearchItem extends SearchItem { family: GraphFamily; kind: string }

/** One node on the canvas: its header (title, kind, badges), its pins, its output. */
function NodeView(props: {
  node: GraphNode; at: Point; selected: boolean; output: boolean; flowId: string; readOnly: boolean; problem: "error" | "warning" | null; problemCount: number;
  drag: GraphDragHooks; onDown(e: PointerEvent): void; onPortDown(e: MouseEvent, node: string, port: string, side: "input" | "output"): void; onOpen(): void; detached: string | null;
  /** The live debugger's state of the node (T52): active, with its weight and phase; undefined when inactive or not debugging. */
  live?: LiveNode | undefined;
}) {
  const { node } = props;
  const el = useRef<HTMLDivElement>(null);
  useNodeDrag(el, node.id, props.readOnly, props.drag);
  const pins = inputPins(node);
  return (
    <div
      ref={el}
      class={`ag-node ag-family-${node.family}${props.selected ? " selected" : ""}${props.problem ? ` ${props.problem}` : ""}${props.live ? " live-active" : ""}`}
      style={{ left: px(props.at.x), top: px(props.at.y), width: px(NODE_W) }}
      data-node={node.id}
      onPointerDown={(e) => props.onDown(e as unknown as PointerEvent)}
      onDblClick={() => node.machine && props.onOpen()}
      aria-label={`Node ${nodeTitle(node)}`}
    >
      <div class="ag-node-head">
        <span class="ag-node-title">{nodeTitle(node)}</span>
        {props.output && <span class="ag-badge" title="The graph's output">out</span>}
        {props.live && <span class="ag-badge dbg-live-badge" title={`Weight ${props.live.weight.toFixed(2)}, phase ${props.live.normalized.toFixed(2)} (${props.live.time.toFixed(2)} s)`}>{Math.round(props.live.weight * 100)}%</span>}
        {props.problemCount > 0 && <span class={`ag-badge ${props.problem}`} title={`${props.problemCount} problem${props.problemCount === 1 ? "" : "s"}`}>{props.problemCount}</span>}
        <span {...handleProps(props.flowId, node.id, OUT, "output")} class={`${handleProps(props.flowId, node.id, OUT, "output").class} ag-pin ag-pin-out`} title="Pose" onMouseDown={(e) => props.onPortDown(e, node.id, OUT, "output")} />
      </div>
      <div class="ag-node-kind">{kindLabel(node.kind)}{node.machine ? ` · ${node.machine.states.length} states` : ""}</div>
      {pins.map((p) => {
        const h = handleProps(props.flowId, node.id, p.id, "input");
        const wired = p.wired && props.detached !== `${node.id}.${p.id}`;
        return (
          <div class="ag-node-pin" key={p.id}>
            <span {...h} class={`${h.class} ag-pin ag-pin-in${wired ? " wired" : ""}`} title={p.label} onMouseDown={(e) => props.onPortDown(e, node.id, p.id, "input")} />
            <span class="ag-pin-label">{p.label}</span>
          </div>
        );
      })}
      {props.live && (
        <span class="dbg-weight" aria-label={`${nodeTitle(node)} weight ${props.live.weight.toFixed(2)}, phase ${props.live.normalized.toFixed(2)}`}>
          <span class="dbg-weight-fill" style={{ width: `${Math.min(1, Math.max(0, props.live.weight)) * 100}%` }} />
          <span class="dbg-phase-mark" style={{ left: `${(props.live.normalized - Math.floor(props.live.normalized)) * 100}%` }} />
        </span>
      )}
    </div>
  );
}

export function PoseCanvas(props: PoseCanvasProps) {
  const { graph, visible, selection, readOnly } = props;
  const overlay = useLiveOverlay();
  const [dragging, setDragging] = useState<ReadonlyMap<string, Point> | null>(null);
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);
  const shown = graph.nodes.map((n, i) => ({ n, i })).filter(({ n }) => !visible || visible.has(n.id));
  const pos = (n: GraphNode, i: number) => dragging?.get(n.id) ?? nodePosition(n, i);
  const canvasNodes: CanvasNode[] = shown.map(({ n, i }) => {
    const p = pos(n, i);
    const pins = inputPins(n);
    return {
      id: n.id, x: p.x, y: p.y, width: NODE_W, height: nodeHeight(n), selected: selection.has(n.id),
      inputs: pins.map((pin, k) => ({ id: pin.id, x: 0, y: HEAD + KIND + ROW * k + ROW / 2 })),
      outputs: [{ id: OUT, x: NODE_W, y: HEAD / 2 }],
    };
  });
  const live = useRef({ graph, nodes: canvasNodes, apply: props.apply });
  live.current = { graph, nodes: canvasNodes, apply: props.apply };
  const lastLabel = useRef("Connect nodes");

  const canvas = useGraphCanvas({
    viewKey: props.viewKey,
    nodes: canvasNodes,
    onContextMenu: (e, at) => {
      if ((e.target as Element).closest(".ag-node")) return;
      e.preventDefault();
      search.open(at, { pending: null });
    },
  });
  const search = useGraphSearch<{ pending: { side: "input" | "output"; ref: string } | null }>({ pane: canvas.pane, root: canvas.pane, readOnly });

  const edits: GraphWiringEdits<AnimGraph> = {
    sourceOf: (g, input) => { const { node, port } = split(input); const src = nodeById(g, node)?.inputs[pinIndex(port)]; return src ? `${src}.${OUT}` : null; },
    whyNot: (g, from, to) => {
      const f = split(from), t = split(to);
      if (f.port !== OUT || pinIndex(t.port) < 0) return "wire an output to an input";
      return whyNotConnect(g, f.node, t.node, pinIndex(t.port));
    },
    connect: (g, from, to) => {
      const f = split(from), t = split(to);
      const r = connect(g, f.node, t.node, pinIndex(t.port));
      lastLabel.current = `Connect ${f.node} to ${t.node}`;
      return "refused" in r ? g : r.next;
    },
    disconnect: (g, input) => { const t = split(input); lastLabel.current = `Disconnect ${t.node}`; return disconnect(g, t.node, pinIndex(t.port)); },
    split,
  };
  const wiring = useGraphWiring({
    flowPrefix: "ag",
    edits,
    graph: () => live.current.graph,
    commit: (next) => live.current.apply({ next }, lastLabel.current),
    readOnly,
    root: canvas.pane,
    canvas: () => canvas,
    nodes: () => live.current.nodes,
    onDropInSpace: (at, from) => search.open(at, { pending: { side: from.side, ref: from.ref } }),
  });

  const drag: GraphDragHooks = {
    pane: () => canvas.pane.current!,
    nodes: () => live.current.nodes,
    view: () => canvas.viewRef.current,
    panBy: canvas.panBy,
    onMove: (m) => setDragging(new Map(m)),
    onEnd: (m) => {
      setDragging(null);
      if (m.size) live.current.apply({ next: moveNodes(live.current.graph, m) }, m.size === 1 ? `Move ${[...m.keys()][0]}` : `Move ${m.size} nodes`);
    },
  };

  const items = useMemo<PoseSearchItem[]>(() => catalogueEntries().map((e) => ({ key: `${e.family}/${e.kind}`, label: e.label, category: FAMILY_LABELS[e.family], keywords: `${e.label} ${e.kind} ${FAMILY_LABELS[e.family]} ${e.doc}`, family: e.family, kind: e.kind })), []);
  const pick = (item: PoseSearchItem) => {
    if (!search.search) return;
    const { at, pending } = search.search;
    const p = toGraph(at, canvas.viewRef.current);
    const g = live.current.graph;
    const made = addNode(g, item.family, item.kind, [p.x, p.y]);
    if ("refused" in made) { props.apply(made, `Add ${item.label}`); search.close(); return; }
    let next = made.next.graph;
    if (pending?.side === "output") {
      const r = connect(next, split(pending.ref).node, made.next.id, 0);
      if (!("refused" in r)) next = r.next;
    } else if (pending?.side === "input") {
      const t = split(pending.ref);
      const r = connect(next, made.next.id, t.node, pinIndex(t.port));
      if (!("refused" in r)) next = r.next;
    }
    props.apply({ next }, `Add ${item.label}`);
    props.onAdded?.({ graph: next, id: made.next.id });
    props.onSelection(new Set([made.next.id]));
    search.close();
  };

  const onItemDown = (e: PointerEvent, id: string) => {
    if (isFieldTarget(e.target) || e.button !== 0) return;
    canvas.pane.current?.focus({ preventScroll: true });
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id); else next.add(id);
      props.onSelection(next);
    } else if (!selection.has(id)) props.onSelection(new Set([id]));
  };

  const byId = new Map(canvasNodes.map((c) => [c.id, c]));
  const wires = shown.flatMap(({ n }) => n.inputs.map((src, k) => ({ src, dst: n.id, k }))).filter((w) => byId.has(w.src) && byId.has(w.dst) && wiring.detached !== `${w.dst}.${inPin(w.k)}`);

  return (
    <div
      class="sg-pane ag-pane"
      ref={canvas.pane}
      onPointerMove={canvas.onPointerMove}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest(".ag-node, .sg-search, .sg-minimap")) return;
        search.dismiss();
        canvas.pane.current?.focus({ preventScroll: true });
        startBoxSelect(e as unknown as PointerEvent, { pane: canvas.pane.current!, view: () => canvas.viewRef.current, nodes: () => live.current.nodes, selection, onSelection: props.onSelection, onBox: setBox });
      }}
      onKeyDown={(e) => {
        if (isFieldTarget(e.target)) return;
        if ((e.key === "Delete" || e.key === "Backspace") && selection.size && !readOnly) {
          e.preventDefault();
          props.apply({ next: removeNodes(live.current.graph, selection) }, selection.size === 1 ? `Remove ${[...selection][0]}` : `Remove ${selection.size} nodes`);
          props.onSelection(new Set());
        } else if (e.key === " ") {
          e.preventDefault();
          search.open(canvas.pointer.current ?? canvas.paneCenter(), { pending: null });
        } else if (e.key === "f" || e.key === "F") canvas.frameAll();
        else if (e.key === "Escape") { search.dismiss(); props.onSelection(new Set()); }
      }}
      tabIndex={-1}
      aria-label="Pose graph"
    >
      <div class="sg-viewport" style={{ transform: `translate(${canvas.view.x}px, ${canvas.view.y}px) scale(${canvas.view.zoom})` }}>
        <svg class="sg-wires">
          {wires.map((w) => {
            const a = byId.get(w.src)!, b = byId.get(w.dst)!;
            const pin = b.inputs[w.k];
            if (!pin) return null;
            return (
              <g class="sg-wire" key={`${w.src}-${w.dst}-${w.k}`}>
                <path class="sg-wire-line ag-wire" d={wirePath({ x: a.x + a.width, y: a.y + HEAD / 2 }, { x: b.x + pin.x, y: b.y + pin.y })} />
              </g>
            );
          })}
          {wiring.draft && <path class={`sg-draft${wiring.draft.valid ? " valid" : ""}`} d={wirePath(wiring.draft.from, wiring.draft.to)} />}
        </svg>
        {shown.map(({ n, i }) => {
          const ps = props.problems.byNode.get(n.id);
          return (
            <NodeView key={n.id} node={n} at={pos(n, i)} selected={selection.has(n.id)} output={graph.output === n.id} flowId={wiring.flowId} readOnly={readOnly}
              problem={worst(ps)} problemCount={ps?.length ?? 0} drag={drag} onDown={(e) => onItemDown(e, n.id)} onPortDown={wiring.onPortDown}
              onOpen={() => props.onOpenMachine(n.id)} detached={wiring.detached} live={overlay?.nodes.get(n.id)} />
          );
        })}
        <WireRefusal draft={wiring.draft} hint={wiring.hint} />
      </div>
      {shown.length === 0 && <div class="ag-canvas-hint"><EmptyState compact title="Right-click or press Space to add a node." /></div>}
      {box && <SelectionBox box={box} />}
      <Minimap nodes={canvasNodes} view={canvas.view} size={canvas.paneSize} pane={canvas.paneApi} />
      {search.search && (
        <div class={NO_PAN}>
          <NodeSearchPopup items={items} at={search.search.popup} onPick={pick} onClose={search.close} />
        </div>
      )}
    </div>
  );
}
