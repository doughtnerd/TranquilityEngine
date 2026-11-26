// A state machine's canvas (ADR 0373 "state machines as nested canvases, transitions drawn with their priority number"):
// its states, the Entry marker wired to the entry state and the Any State node, on the shared graph layer. Drag from a
// state's right edge to another state to add a transition (from Entry: set the entry state; from Any State: an any-state
// transition), each refused with its reason where the machine can't take it. Transitions are arrows with their priority
// number (1 is tried first, "A1" for any-state ones); click a number to open that transition in the list. Double-click a
// state to open its sub-graph.
import { useRef, useState } from "preact/hooks";
import type { AnimGraph, MachineState, StateMachine } from "../../../../engine/animation/animGraph";
import { Minimap, SelectionBox, WireRefusal, handleProps, isFieldTarget, px, startBoxSelect, toGraph, useGraphCanvas, useGraphWiring, useNodeDrag, type CanvasNode, type EditResult, type GraphDragHooks, type GraphWiringEdits, type Point, EmptyState } from "../../../../editor/sdk";
import { nodeById } from "./graphEditLogic";
import {
  ANY_ID, ENTRY_ID, addState, addTransition, entryOf, moveStates, priorityLabel, removeState, setEntry,
  type TransitionRef,
} from "./machineLogic";
import { transitionKey, worst, type ProblemIndex } from "./problemLogic";
import { useLiveOverlay } from "../debugger/overlayContext";
import type { LiveTransition } from "../debugger/overlayLogic";

const STATE_W = 150, STATE_H = 40;
const split = (ref: string) => { const i = ref.lastIndexOf("."); return { node: ref.slice(0, i), port: ref.slice(i + 1) }; };

/** Where a state is drawn: its position, or a grid place by its index. */
export const statePosition = (s: MachineState, i: number): Point => (s.position ? { x: s.position[0], y: s.position[1] } : { x: 220 + (i % 4) * 200, y: 40 + Math.floor(i / 4) * 110 });
const ENTRY_AT: Point = { x: 0, y: 40 };
const ANY_AT: Point = { x: 0, y: 160 };

export interface MachineCanvasProps {
  graph: AnimGraph;
  machine: string;
  viewKey: string;
  /** The selected state names. */
  selection: ReadonlySet<string>;
  onSelection(names: ReadonlySet<string>): void;
  /** The open transition, or null. */
  transition: TransitionRef | null;
  onTransition(ref: TransitionRef | null): void;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly: boolean;
  problems: ProblemIndex;
  onOpenState(name: string): void;
}

function StateView(props: { id: string; label: string; at: Point; kind: "state" | "entry" | "any"; entry: boolean; exit: boolean; selected: boolean; problem: "error" | "warning" | null; flowId: string; readOnly: boolean; drag: GraphDragHooks; onDown(e: PointerEvent): void; onOpen(): void; onPortDown(e: MouseEvent, node: string, port: string, side: "input" | "output"): void; live?: { current: boolean; target: boolean; normalized: number; stateTime: number } }) {
  const el = useRef<HTMLDivElement>(null);
  useNodeDrag(el, props.id, props.readOnly || props.kind !== "state", props.drag);
  const out = handleProps(props.flowId, props.id, "out", "output");
  const inp = handleProps(props.flowId, props.id, "in", "input");
  return (
    <div
      ref={el}
      class={`ag-state ag-state-${props.kind}${props.selected ? " selected" : ""}${props.entry ? " entry" : ""}${props.exit ? " exit" : ""}${props.problem ? ` ${props.problem}` : ""}${props.live?.current ? " live-current" : ""}${props.live?.target ? " live-target" : ""}`}
      style={{ left: px(props.at.x), top: px(props.at.y), width: px(STATE_W), height: px(STATE_H) }}
      data-state={props.id}
      aria-label={props.kind === "state" ? `State ${props.label}` : props.label}
      onPointerDown={(e) => props.onDown(e as unknown as PointerEvent)}
      onDblClick={() => props.kind === "state" && props.onOpen()}
    >
      {props.kind === "state" && <span {...inp} class={`${inp.class} ag-state-in`} onMouseDown={(e) => props.onPortDown(e, props.id, "in", "input")} />}
      <span class="ag-state-label">{props.label}</span>
      {props.live?.current && (
        <span class="dbg-state-phase" title={`${props.live.stateTime.toFixed(2)} s in the state, normalised time ${props.live.normalized.toFixed(2)}`}>
          <span class="dbg-state-phase-fill" style={{ width: `${(props.live.normalized - Math.floor(props.live.normalized)) * 100}%` }} />
        </span>
      )}
      <span {...out} class={`${out.class} ag-state-out`} title={props.kind === "entry" ? "Drag to the entry state" : "Drag to a state to add a transition"} onMouseDown={(e) => props.onPortDown(e, props.id, "out", "output")} />
    </div>
  );
}

/** The arrow and priority label of one transition, between two boxes' centres (offset sideways when both ways are wired). */
function Arrow(props: { a: Point; b: Point; offset: number; label: string; selected: boolean; problem: "error" | "warning" | null; onClick(): void; self: boolean; live?: LiveTransition; fading?: boolean }) {
  const { a, b } = props;
  const liveClass = `${props.live ? ` live-${props.live.blocker}` : ""}${props.fading ? " live-fading" : ""}`;
  const why = props.live ? <title>{`Transition ${props.label}: ${props.live.why}`}</title> : props.fading ? <title>{`Transition ${props.label} is in progress.`}</title> : null;
  if (props.self) {
    const x = a.x + STATE_W / 2, y = a.y;
    return (
      <g class={`ag-arrow${props.selected ? " selected" : ""}${liveClass}`}>
        {why}
        <path class="ag-arrow-line" d={`M ${x - 20} ${y} C ${x - 30} ${y - 40}, ${x + 30} ${y - 40}, ${x + 20} ${y}`} markerEnd="url(#ag-arrowhead)" />
        <g class={`ag-priority-badge${props.problem ? ` ${props.problem}` : ""}`} onClick={props.onClick} role="button" aria-label={`Transition ${props.label}`}>
          <circle cx={x} cy={y - 30} r={9} /><text x={x} y={y - 26}>{props.label}</text>
        </g>
      </g>
    );
  }
  const ca = { x: a.x + STATE_W / 2, y: a.y + STATE_H / 2 }, cb = { x: b.x + STATE_W / 2, y: b.y + STATE_H / 2 };
  const dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const o = props.offset;
  // Start and end at the boxes' edges (both boxes are the same size).
  const edge = Math.min((STATE_W / 2 + 4) / Math.max(Math.abs(dx), 1e-6), (STATE_H / 2 + 4) / Math.max(Math.abs(dy), 1e-6));
  const p0 = { x: ca.x + dx * edge + nx * o, y: ca.y + dy * edge + ny * o };
  const end = { x: cb.x - dx * edge + nx * o, y: cb.y - dy * edge + ny * o };
  const mid = { x: (p0.x + end.x) / 2, y: (p0.y + end.y) / 2 };
  return (
    <g class={`ag-arrow${props.selected ? " selected" : ""}${liveClass}`}>
      {why}
      <line class="ag-arrow-line" x1={p0.x} y1={p0.y} x2={end.x} y2={end.y} markerEnd="url(#ag-arrowhead)" />
      <g class={`ag-priority-badge${props.problem ? ` ${props.problem}` : ""}`} onClick={props.onClick} role="button" aria-label={`Transition ${props.label}`}>
        <circle cx={mid.x} cy={mid.y} r={9} /><text x={mid.x} y={mid.y + 4}>{props.label}</text>
      </g>
    </g>
  );
}

export function MachineCanvas(props: MachineCanvasProps) {
  const { graph, machine, selection, readOnly } = props;
  const m = nodeById(graph, machine)?.machine as StateMachine;
  const overlay = useLiveOverlay();
  const liveMachine = overlay?.machines.get(machine);
  const [dragging, setDragging] = useState<ReadonlyMap<string, Point> | null>(null);
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);
  const pos = (s: MachineState, i: number) => dragging?.get(s.name) ?? statePosition(s, i);
  const port = (id: string, at: Point, inputs: boolean): CanvasNode => ({
    id, x: at.x, y: at.y, width: STATE_W, height: STATE_H, selected: selection.has(id),
    inputs: inputs ? [{ id: "in", x: 0, y: STATE_H / 2 }] : [], outputs: [{ id: "out", x: STATE_W, y: STATE_H / 2 }],
  });
  const canvasNodes: CanvasNode[] = [port(ENTRY_ID, ENTRY_AT, false), port(ANY_ID, ANY_AT, false), ...m.states.map((s, i) => port(s.name, pos(s, i), true))];
  const live = useRef({ graph, nodes: canvasNodes, apply: props.apply });
  live.current = { graph, nodes: canvasNodes, apply: props.apply };
  const lastLabel = useRef("Add transition");

  const canvas = useGraphCanvas({
    viewKey: `${props.viewKey}#${machine}`,
    nodes: canvasNodes,
    onContextMenu: (e, at) => {
      if ((e.target as Element).closest(".ag-state") || readOnly) return;
      e.preventDefault();
      addStateAt(at);
    },
  });
  const addStateAt = (at: Point) => {
    const p = toGraph(at, canvas.viewRef.current);
    const r = addState(live.current.graph, machine, [p.x - STATE_W / 2, p.y - STATE_H / 2]);
    props.apply("refused" in r ? r : { next: r.next.graph }, "Add state");
    if (!("refused" in r)) props.onSelection(new Set([r.next.state]));
  };

  const edit = (g: AnimGraph, from: string, to: string): EditResult<AnimGraph> => {
    const f = split(from).node, t = split(to).node;
    if (f === ENTRY_ID) { lastLabel.current = `Make ${t} the entry state`; return setEntry(g, machine, t); }
    const owner = f === ANY_ID ? null : f;
    lastLabel.current = `Add transition ${owner ?? "Any State"} → ${t}`;
    return addTransition(g, machine, owner, t);
  };
  const edits: GraphWiringEdits<AnimGraph> = {
    sourceOf: () => null,
    whyNot: (g, from, to) => { const r = edit(g, from, to); return "refused" in r ? r.refused : null; },
    connect: (g, from, to) => { const r = edit(g, from, to); return "refused" in r ? g : r.next; },
    disconnect: (g) => g,
    split,
  };
  const wiring = useGraphWiring({
    flowPrefix: "agm",
    edits,
    graph: () => live.current.graph,
    commit: (next) => live.current.apply({ next }, lastLabel.current),
    readOnly,
    root: canvas.pane,
    canvas: () => canvas,
    nodes: () => live.current.nodes,
    onDropInSpace: () => {},
  });
  const drag: GraphDragHooks = {
    pane: () => canvas.pane.current!,
    nodes: () => live.current.nodes.filter((n) => n.id !== ENTRY_ID && n.id !== ANY_ID),
    view: () => canvas.viewRef.current,
    panBy: canvas.panBy,
    onMove: (mv) => setDragging(new Map(mv)),
    onEnd: (mv) => {
      setDragging(null);
      if (mv.size) live.current.apply({ next: moveStates(live.current.graph, machine, mv) }, mv.size === 1 ? `Move state ${[...mv.keys()][0]}` : `Move ${mv.size} states`);
    },
  };
  const onDown = (e: PointerEvent, id: string) => {
    if (isFieldTarget(e.target) || e.button !== 0) return;
    canvas.pane.current?.focus({ preventScroll: true });
    if (id === ENTRY_ID || id === ANY_ID) {
      props.onSelection(new Set());
      if (id === ANY_ID) props.onTransition(null);
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id); else next.add(id);
      props.onSelection(next);
    } else if (!selection.has(id)) props.onSelection(new Set([id]));
  };

  const at = (name: string): Point | null => {
    if (name === ANY_ID) return ANY_AT;
    const i = m.states.findIndex((s) => s.name === name);
    return i < 0 ? null : pos(m.states[i]!, i);
  };
  const pairs = new Set<string>();
  for (const s of m.states) for (const t of s.transitions) pairs.add(`${s.name}>${t.to}`);
  const arrows: { from: string; to: string; ref: TransitionRef }[] = [
    ...m.anyState.map((t, index) => ({ from: ANY_ID, to: t.to, ref: { from: null, index } as TransitionRef })),
    ...m.states.flatMap((s) => s.transitions.map((t, index) => ({ from: s.name, to: t.to, ref: { from: s.name, index } as TransitionRef }))),
  ];
  // Several transitions between the same two states fan out.
  const fan = new Map<string, number>();
  const entry = entryOf(m);
  const entryAt = entry ? at(entry) : null;

  return (
    <div
      class="sg-pane ag-pane ag-machine-pane"
      ref={canvas.pane}
      onPointerMove={canvas.onPointerMove}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest(".ag-state, .ag-priority-badge, .sg-minimap")) return;
        canvas.pane.current?.focus({ preventScroll: true });
        props.onTransition(null);
        startBoxSelect(e as unknown as PointerEvent, { pane: canvas.pane.current!, view: () => canvas.viewRef.current, nodes: () => live.current.nodes.filter((n) => n.id !== ENTRY_ID && n.id !== ANY_ID), selection, onSelection: props.onSelection, onBox: setBox });
      }}
      onKeyDown={(e) => {
        if (isFieldTarget(e.target)) return;
        if ((e.key === "Delete" || e.key === "Backspace") && selection.size && !readOnly) {
          e.preventDefault();
          let g = live.current.graph;
          for (const name of selection) { const r = removeState(g, machine, name); if (!("refused" in r)) g = r.next; }
          props.apply({ next: g }, selection.size === 1 ? `Remove state ${[...selection][0]}` : `Remove ${selection.size} states`);
          props.onSelection(new Set());
        } else if (e.key === "f" || e.key === "F") canvas.frameAll();
        else if (e.key === "Escape") { props.onSelection(new Set()); props.onTransition(null); }
      }}
      tabIndex={-1}
      aria-label="State machine"
    >
      <div class="sg-viewport" style={{ transform: `translate(${canvas.view.x}px, ${canvas.view.y}px) scale(${canvas.view.zoom})` }}>
        <svg class="sg-wires ag-arrows">
          <defs>
            <marker id="ag-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class="ag-arrowhead" />
            </marker>
          </defs>
          {entryAt && <line class="ag-entry-line" x1={ENTRY_AT.x + STATE_W} y1={ENTRY_AT.y + STATE_H / 2} x2={entryAt.x} y2={entryAt.y + STATE_H / 2} markerEnd="url(#ag-arrowhead)" />}
          {arrows.map((a) => {
            const pa = at(a.from), pb = at(a.to);
            if (!pa || !pb) return null;
            const key = `${a.from}>${a.to}`;
            const n = fan.get(key) ?? 0;
            fan.set(key, n + 1);
            const both = pairs.has(`${a.to}>${a.from}`);
            const offset = (both ? 7 : 0) + n * 14;
            const ps = props.problems.byTransition.get(transitionKey(machine, a.ref));
            const selected = props.transition?.from === a.ref.from && props.transition?.index === a.ref.index;
            const fading = liveMachine?.active?.from === a.ref.from && liveMachine?.active?.index === a.ref.index;
            return <Arrow key={`${key}#${a.ref.index}#${a.ref.from ?? "@"}`} a={pa} b={pb} offset={offset} self={a.from === a.to} label={priorityLabel(a.ref)} selected={selected} problem={worst(ps)}
              live={overlay?.transitions.get(transitionKey(machine, a.ref))} fading={fading}
              onClick={() => { props.onTransition(a.ref); props.onSelection(a.ref.from ? new Set([a.ref.from]) : new Set()); }} />;
          })}
          {wiring.draft && <line class={`sg-draft${wiring.draft.valid ? " valid" : ""}`} x1={wiring.draft.from.x} y1={wiring.draft.from.y} x2={wiring.draft.to.x} y2={wiring.draft.to.y} />}
        </svg>
        <StateView id={ENTRY_ID} label="Entry" kind="entry" at={ENTRY_AT} entry={false} exit={false} selected={false} problem={null} flowId={wiring.flowId} readOnly={readOnly} drag={drag} onDown={(e) => onDown(e, ENTRY_ID)} onOpen={() => {}} onPortDown={wiring.onPortDown} />
        <StateView id={ANY_ID} label="Any State" kind="any" at={ANY_AT} entry={false} exit={false} selected={false} problem={null} flowId={wiring.flowId} readOnly={readOnly} drag={drag} onDown={(e) => onDown(e, ANY_ID)} onOpen={() => {}} onPortDown={wiring.onPortDown} />
        {m.states.map((s, i) => (
          <StateView key={s.name} id={s.name} label={s.name} kind="state" at={pos(s, i)} entry={entry === s.name} exit={s.exit} selected={selection.has(s.name)}
            problem={worst(props.problems.byState.get(`${machine}/${s.name}`))} flowId={wiring.flowId} readOnly={readOnly} drag={drag}
            onDown={(e) => onDown(e, s.name)} onOpen={() => props.onOpenState(s.name)} onPortDown={wiring.onPortDown}
            live={liveMachine ? { current: liveMachine.current === s.name, target: liveMachine.target === s.name, normalized: liveMachine.normalized, stateTime: liveMachine.stateTime } : undefined} />
        ))}
        <WireRefusal draft={wiring.draft} hint={wiring.hint} />
      </div>
      {m.states.length === 0 && <div class="ag-canvas-hint"><EmptyState compact title="Right-click to add a state." /></div>}
      {box && <SelectionBox box={box} />}
      <Minimap nodes={canvasNodes} view={canvas.view} size={canvas.paneSize} pane={canvas.paneApi} />
    </div>
  );
}
