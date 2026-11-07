// The Particle Graph editor (ADR 0060) for one effect asset: systems of stacked contexts and
// blocks, value and event nodes wired into them, the Blackboard, the live preview, and the
// compiler's problems on the graph. Built on the shared graph layer (src/editor/graph/) and
// following the Shader Graph panel's conventions: every edit is a pure function on the graph,
// recorded for undo, shown, and saved; a change to the file from elsewhere replaces the graph.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { compileParticleGraph } from "../../../engine/scene/particleCompile";
import type { ContextKind, GraphGroup, GraphProblem, ParticleGraph, Vec2 } from "../../../engine/scene/particleGraph";
import { formatParticleGraph } from "../../../engine/scene/particleGraphFormat";
import { nodeDef, outputType } from "../../../engine/scene/particleNodes";
import { assetKind, fileName, listedFiles } from "../../assetBrowser";
import { NO_DRAG, NO_PAN, NoteView, NodeSearchPopup, Minimap, SelectionBox, isFieldTarget, px, startBoxSelect, startConnection, startPointerDrag, toGraph, useGraphCanvas, writeGraphClipboard, type CanvasNode, type DraftWire, type Point } from "../../graph";
import { errorStatus } from "../../messages";
import { effectHistory, readEffect, recordEffectEdit, redoEffectEdit, undoEffectEdit, writeEffect } from "../../particleAssets";
import {
  addBlock,
  addNode,
  addNote,
  addSystem,
  canMoveBlock,
  connectWire,
  copyItems,
  disconnect,
  disconnectEvent,
  duplicateItems,
  groupItems,
  moveBlock,
  moveItems,
  pasteItems,
  removeBlock,
  removeItems,
  removeNote,
  collapsedSystems,
  setGroupTitle,
  setSystemCollapsed,
  sourceOf,
  splitRef,
  ungroup,
  updateNote,
  whyNotWire,
  type ParticleClipboard,
} from "../../particleGraph/graphEdit";
import { indexProblems, locateProblem } from "../../particleGraph/problems";
import type { EditorProject } from "../../projects";
import { docVersion, status } from "../../state";
import { Blackboard, PROPERTY_DRAG } from "./Blackboard";
import { GraphEditorContext, type BlockDrop, type GraphEditorApi } from "./editorContext";
import { NODE_WIDTH, SYSTEM_WIDTH, canvasNode, measureCanvas, sameMeasure, type Measured } from "./layout";
import { NodeView } from "./NodeView";
import { ParticleGraphPreview } from "./PreviewPane";
import { blockItems, canvasItems, nodeItems, type GraphSearchItem } from "./search";
import { SystemView, type DragHooks } from "./SystemView";
import { Wires, type WireSelection } from "./Wires";
import "../../graph/graph.css";
import "./particleGraph.css";

/** Systems and nodes copied with Ctrl+C or cut with Ctrl+X, pasted into any effect. */
let clipboard: ParticleClipboard | null = null;
/** Effects framed once this session (the first view fits the graph as measured). */
const framed = new Set<string>();
/** The preview card's size, kept while the panel is open. */
let previewSize = { w: 300, h: 220 };

/** What a dropped wire connects a node from the search to. */
type Pending = { side: "output" | "input"; ref: string } | null;
type SearchTarget = { kind: "canvas" } | { kind: "context"; system: string; context: ContextKind; output: number };

const effectName = (path: string) => fileName(path).replace(/\.particles\.json$/i, "");

export function ParticleGraphEditor(props: { project: EditorProject; path: string }) {
  const { project, path } = props;
  const readOnly = !project.canSave;
  docVersion.value; // re-read the file when it changes on disk or elsewhere in the editor

  const first = useMemo(() => readEffect(project, path), []);
  const [graph, setGraph] = useState<ParticleGraph>(first.graph);
  const [parseProblems, setParseProblems] = useState<GraphProblem[]>(first.problems);
  const [migrated, setMigrated] = useState(first.migrated);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<WireSelection | null>(null);
  const [dragging, setDragging] = useState<Map<string, Point> | null>(null);
  const [draft, setDraft] = useState<DraftWire | null>(null);
  const [detached, setDetached] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [search, setSearch] = useState<{ at: Point; target: SearchTarget; pending: Pending } | null>(null);
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);
  const [blockDrag, setBlockDrag] = useState<{ key: string; drop: BlockDrop | null } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [blackboardCollapsed, setBlackboardCollapsed] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [measured, setMeasured] = useState<Map<string, Measured>>(new Map());
  const [, setHistoryTick] = useState(0);

  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const flowId = useMemo(() => `pg${Math.random().toString(36).slice(2, 8)}`, []);
  /** The file text last read or written, to tell our own writes from changes made elsewhere. */
  const fileText = useRef(formatParticleGraph(first.graph));
  /** Saves in flight: until they land, the project still serves the text before them. */
  const saving = useRef(0);
  /** Why the wire being drawn can't end at the port under the pointer (set while xyflow checks it). */
  const refusal = useRef<string | null>(null);

  // A change to the file from outside the panel (an undo of a rename, another window…) replaces the graph.
  const onDisk = readEffect(project, path);
  const diskText = formatParticleGraph(onDisk.graph);
  if (diskText !== fileText.current && !dragging && saving.current === 0) {
    fileText.current = diskText;
    queueMicrotask(() => {
      setGraph(onDisk.graph);
      setParseProblems(onDisk.problems);
      setMigrated(onDisk.migrated);
    });
  }

  const collapsed = useMemo(() => collapsedSystems(graph), [graph]);
  const compiled = useMemo(() => compileParticleGraph(graph), [graph]);
  const problems = useMemo(() => {
    const seen = new Set<string>();
    return [...parseProblems, ...compiled.problems].filter((p) => {
      const key = `${p.at}|${p.message}`;
      return !seen.has(key) && !!seen.add(key);
    });
  }, [parseProblems, compiled]);
  const problemIndex = useMemo(() => indexProblems(graph, problems), [graph, problems]);
  const wired = useMemo(() => new Map(graph.edges.map((e) => [e.to, e.from])), [graph]);
  const eventTargets = useMemo(() => new Set(graph.events.map((e) => e.to)), [graph]);
  const eventSources = useMemo(() => new Set(graph.events.map((e) => e.from)), [graph]);
  const wireTypes = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of graph.edges) {
      const [id, port] = splitRef(e.from);
      const node = graph.nodes.find((n) => n.id === id);
      m.set(e.from, (node && outputType(graph, node, port)) ?? "number");
    }
    return m;
  }, [graph]);

  const position = (item: { id: string; position: Vec2 }): Point => dragging?.get(item.id) ?? { x: item.position[0], y: item.position[1] };
  const canvasNodes: CanvasNode[] = [
    ...graph.systems.map((s) => canvasNode(s.id, position(s), measured.get(s.id), { w: SYSTEM_WIDTH, h: 480 }, selection.has(s.id))),
    ...graph.nodes.map((n) => canvasNode(n.id, position(n), measured.get(n.id), { w: NODE_WIDTH, h: 80 }, selection.has(n.id))),
  ];
  const nodeById = new Map(canvasNodes.map((n) => [n.id, n]));

  const canvas = useGraphCanvas({
    viewKey: path,
    nodes: canvasNodes,
    onContextMenu: (e, at) => {
      const target = e.target as Element;
      if (target.closest(".pg-node, .pg-previewcard, .pg-popover")) return;
      e.preventDefault();
      const ctx = target.closest<HTMLElement>("[data-context]");
      openSearch(at, ctx ? contextTarget(ctx) : { kind: "canvas" }, null);
    },
  });
  const { pane, paneApi, view, paneSize, panBy, paneCenter, frameAll } = canvas;

  // xyflow and the drags read the latest state through these.
  const live = useRef({ graph, nodes: canvasNodes });
  live.current = { graph, nodes: canvasNodes };

  // --- measuring -------------------------------------------------------------------------------------

  const measuredRef = useRef(measured);
  const remeasure = () => {
    const vp = viewport.current;
    if (!vp) return;
    const m = measureCanvas(vp, canvas.viewRef.current.zoom);
    if (sameMeasure(m, measuredRef.current)) return;
    measuredRef.current = m;
    setMeasured(m);
  };
  const resize = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    resize.current = new ResizeObserver(() => remeasure());
    return () => resize.current?.disconnect();
  }, []);
  useLayoutEffect(() => {
    remeasure();
    for (const el of viewport.current?.querySelectorAll("[data-owner]") ?? []) resize.current?.observe(el);
  });
  // The first view of an effect this session fits it as measured.
  useEffect(() => {
    if (framed.has(path) || measured.size === 0) return;
    framed.add(path);
    frameAll();
  }, [measured]);

  // --- editing ---------------------------------------------------------------------------------------

  const save = (next: ParticleGraph) => {
    fileText.current = formatParticleGraph(next);
    saving.current++;
    writeEffect(project, path, next)
      .catch((err) => (status.value = errorStatus(`Couldn't save ${fileName(path)}`, err)))
      .finally(() => {
        saving.current--;
        docVersion.value++;
      });
  };

  const show = (next: ParticleGraph) => {
    live.current.graph = next;
    setGraph(next);
    setHistoryTick((t) => t + 1);
    setMigrated(false);
    save(next);
  };

  /** Apply an edit: remember the graph before it for undo, show it, and save it. */
  const commit = (next: ParticleGraph) => {
    const before = live.current.graph;
    if (next === before) return;
    if (readOnly) {
      status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to edit particle effects.` };
      return;
    }
    recordEffectEdit(path, before);
    show(next);
  };

  /** Collapse or expand a system's frame: a view change, so it marks the asset dirty (saves) but stays out of undo. */
  const setCollapsed = (id: string, c: boolean) => {
    if (readOnly) return;
    const next = setSystemCollapsed(live.current.graph, id, c);
    if (next !== live.current.graph) show(next);
  };

  // Undo and redo restore the graph as it was edited, but keep the frames as they are now.
  const keepView = (restored: ParticleGraph): ParticleGraph => {
    const now = collapsedSystems(live.current.graph);
    let g = restored;
    for (const s of restored.systems) g = setSystemCollapsed(g, s.id, now.has(s.id));
    return g;
  };
  const history = effectHistory(path);
  const undo = () => {
    if (readOnly) return;
    const prev = undoEffectEdit(path, live.current.graph);
    if (prev) show(keepView(prev));
  };
  const redo = () => {
    if (readOnly) return;
    const next = redoEffectEdit(path, live.current.graph);
    if (next) show(keepView(next));
  };

  // --- search ----------------------------------------------------------------------------------------

  const contextTarget = (el: HTMLElement): SearchTarget => {
    const [system, context, output] = el.dataset.context!.split(":") as [string, ContextKind, string | undefined];
    return { kind: "context", system, context, output: Number(output ?? 0) };
  };

  const openSearch = (at: Point, target: SearchTarget, pending: Pending) => {
    if (readOnly) return;
    const w = pane.current?.clientWidth ?? 600, h = pane.current?.clientHeight ?? 400;
    setSearch({ at: { x: Math.max(4, Math.min(at.x, w - 250)), y: Math.max(4, Math.min(at.y, h - 330)) }, target, pending });
  };

  /** Space: the search for what's under the pointer (a context's blocks, or the canvas). */
  const openSearchAtPointer = () => {
    const at = canvas.pointer.current ?? paneCenter();
    const r = pane.current!.getBoundingClientRect();
    const ctx = document.elementFromPoint(r.left + at.x, r.top + at.y)?.closest<HTMLElement>("[data-context]");
    openSearch(at, ctx ? contextTarget(ctx) : { kind: "canvas" }, null);
  };

  const closeSearch = () => {
    setSearch(null);
    root.current?.focus({ preventScroll: true });
  };

  const pick = (item: GraphSearchItem) => {
    if (!search) return;
    const { at, target, pending } = search;
    const p = toGraph(at, canvas.viewRef.current);
    const g = live.current.graph;
    if (item.pick.kind === "block" && target.kind === "context") {
      const made = addBlock(g, target.system, target.context, item.pick.type, undefined, target.output);
      commit(made.graph);
      if (made.id) setSelectedBlock(`${target.system}.${made.id}`);
    } else if (item.pick.kind === "system") {
      const made = addSystem(g, item.pick.template, [p.x, p.y]);
      commit(made.graph);
      setSelection(new Set([made.id]));
    } else if (item.pick.kind === "node") {
      const def = nodeDef(item.pick.type);
      const left = pending?.side === "input";
      const made = addNode(g, item.pick.type, [left ? p.x - NODE_WIDTH - 20 : p.x, p.y - 14], item.pick.settings);
      let next = made.graph;
      if (pending?.side === "output") {
        const input = def?.inputs.find((i) => !whyNotWire(next, pending.ref, `${made.id}.${i.name}`));
        if (input) next = connectWire(next, pending.ref, `${made.id}.${input.name}`);
      } else if (pending?.side === "input") {
        const output = def?.outputs.find((o) => !whyNotWire(next, `${made.id}.${o.name}`, pending.ref));
        if (output) next = connectWire(next, `${made.id}.${output.name}`, pending.ref);
      }
      commit(next);
      setSelection(new Set([made.id]));
    }
    closeSearch();
  };

  const searchItems = useMemo(() => {
    if (!search) return [];
    if (search.target.kind === "context") return blockItems(search.target.context);
    return search.pending ? nodeItems(graph) : canvasItems(graph);
  }, [search, graph.properties]);

  // --- wiring ----------------------------------------------------------------------------------------

  const connectOptions = (onConnect: (from: string, to: string) => void, onSpace: (at: Point) => void, onEnd: () => void = () => undefined) => ({
    flowId,
    pane: pane.current!,
    nodes: () => live.current.nodes,
    view: () => canvas.viewRef.current,
    panBy,
    canConnect: (from: string, to: string) => {
      refusal.current = whyNotWire(live.current.graph, from, to);
      return !refusal.current;
    },
    onDraft: (d: DraftWire | null) => {
      setDraft(d);
      setHint(d && !d.valid ? refusal.current : null);
      refusal.current = null;
    },
    onConnect,
    onDropInSpace: onSpace,
    onEnd: () => {
      setHint(null);
      onEnd();
    },
  });

  const isEventPort = (owner: string, port: string, side: "input" | "output") => {
    if (graph.systems.some((s) => s.id === owner)) return port === "start" || port === "stop" || side === "output";
    const node = graph.nodes.find((n) => n.id === owner);
    return !!node && nodeDef(node.type)?.outputs.find((o) => o.name === port)?.type === "event";
  };

  const onPortDown = (e: MouseEvent, owner: string, port: string, side: "input" | "output") => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    root.current?.focus({ preventScroll: true });
    const ref = `${owner}.${port}`;
    const src = side === "input" ? sourceOf(graph, ref) : undefined;
    if (src) {
      // Dragging a wired input picks its wire up from the input end.
      const [srcNode, srcPort] = splitRef(src);
      const srcEl = pane.current!.querySelector(`[data-id="${flowId}-${srcNode}-${srcPort}-source"]`);
      if (!srcEl) return;
      setDetached(ref);
      startConnection(
        e,
        srcEl,
        srcNode,
        srcPort,
        "output",
        connectOptions(
          (from, to) => commit(connectWire(disconnect(live.current.graph, ref), from, to)),
          () => commit(disconnect(live.current.graph, ref)),
          () => setDetached(null),
        ),
      );
      return;
    }
    const event = isEventPort(owner, port, side);
    startConnection(
      e,
      e.currentTarget as Element,
      owner,
      port,
      side,
      connectOptions(
        (from, to) => commit(connectWire(live.current.graph, from, to)),
        (at) => !event && openSearch(at, { kind: "canvas" }, { side, ref }),
      ),
    );
  };

  // --- selection and drags ---------------------------------------------------------------------------

  const onItemDown = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    if (!isFieldTarget(e.target)) root.current?.focus({ preventScroll: true });
    setSelectedWire(null);
    setProblemsOpen(false);
    if (!(e.target as Element).closest(".pg-block")) setSelectedBlock(null);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
    } else if (!selection.has(id)) setSelection(new Set([id]));
  };

  const onPaneDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest(".pg-system, .pg-node, .sg-search, .sg-wire-hit, .sg-note, .sg-group-head, .sg-minimap, .pg-previewcard, .pg-popover")) return;
    root.current?.focus({ preventScroll: true });
    setSearch(null);
    setSelectedWire(null);
    setSelectedBlock(null);
    setProblemsOpen(false);
    startBoxSelect(e, { pane: pane.current!, view: () => canvas.viewRef.current, nodes: () => live.current.nodes, selection, onSelection: setSelection, onBox: setBox });
  };

  const dragHooks: DragHooks = {
    pane: () => pane.current!,
    nodes: () => live.current.nodes,
    view: () => canvas.viewRef.current,
    panBy,
    onMove: (m) => setDragging(new Map(m)),
    onEnd: (m) => {
      setDragging(null);
      if (!readOnly) commit(moveItems(live.current.graph, new Map([...m].map(([id, p]) => [id, [p.x, p.y] as Vec2]))));
    },
  };

  /** Drag a block by its handle to another slot, or into another context it fits. */
  const startBlockDrag = (e: PointerEvent, system: string, block: string) => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    const key = `${system}.${block}`;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    setSelectedBlock(key);
    let drop: BlockDrop | null = null;
    setBlockDrag({ key, drop });
    const move = (m: PointerEvent) => {
      const el = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>("[data-context]");
      drop = null;
      if (el) {
        const [s, k, ox] = el.dataset.context!.split(":") as [string, ContextKind, string | undefined];
        const o = Number(ox ?? 0);
        if (canMoveBlock(live.current.graph, system, block, s, k, o)) {
          const rows = [...el.querySelectorAll<HTMLElement>("[data-block]")];
          let index = rows.findIndex((r) => {
            const b = r.getBoundingClientRect();
            return m.clientY < b.top + b.height / 2;
          });
          if (index < 0) index = rows.length;
          drop = { system: s, kind: k, output: o, index };
        }
      }
      setBlockDrag({ key, drop });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setBlockDrag(null);
      if (drop) commit(moveBlock(live.current.graph, system, block, drop.system, drop.kind, drop.index, drop.output));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  /** Drag a group by its title: its systems and nodes move together, as one undo step. */
  const startGroupDrag = (e: PointerEvent, group: GraphGroup) => {
    if (e.button !== 0 || readOnly || isFieldTarget(e.target)) return;
    const base = new Map([...graph.systems, ...graph.nodes].filter((n) => group.members.includes(n.id)).map((n) => [n.id, { x: n.position[0], y: n.position[1] }]));
    const moved = (dx: number, dy: number) => new Map([...base].map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
    startPointerDrag(e, {
      zoom: () => canvas.viewRef.current.zoom,
      onMove: (dx, dy) => setDragging(moved(dx, dy)),
      onEnd: (dx, dy) => {
        setDragging(null);
        commit(moveItems(live.current.graph, new Map([...moved(dx, dy)].map(([id, p]) => [id, [p.x, p.y] as Vec2]))));
      },
    });
  };

  // --- commands --------------------------------------------------------------------------------------

  const deleteSelection = () => {
    const g = live.current.graph;
    if (selectedWire) {
      commit(selectedWire.kind === "edge" ? disconnect(g, selectedWire.to) : disconnectEvent(g, selectedWire.from, selectedWire.to));
      setSelectedWire(null);
    } else if (selectedBlock) {
      const [system, block] = selectedBlock.split(".");
      commit(removeBlock(g, system, block));
      setSelectedBlock(null);
    } else if (selection.size) {
      commit(removeItems(g, selection));
      setSelection(new Set());
    }
  };

  const pasteHere = () => {
    if (!clipboard || readOnly) return;
    const at = toGraph(canvas.pointer.current ?? paneCenter(), canvas.viewRef.current);
    const made = pasteItems(live.current.graph, clipboard, [at.x, at.y]);
    commit(made.graph);
    setSelection(new Set(made.ids));
  };

  const groupSelection = () => {
    if (selection.size === 0) return;
    commit(groupItems(live.current.graph, selection).graph);
  };

  const addNoteHere = () => {
    const at = toGraph(paneCenter(), canvas.viewRef.current);
    commit(addNote(live.current.graph, [at.x - 100, at.y - 50]).graph);
  };

  const placeProperty = (name: string, at: Point = paneCenter()) => {
    const p = toGraph(at, canvas.viewRef.current);
    const made = addNode(live.current.graph, "property", [p.x - NODE_WIDTH / 2, p.y - 14], { name });
    commit(made.graph);
    setSelection(new Set([made.id]));
  };

  const focusProblem = (p: GraphProblem) => {
    setProblemsOpen(false);
    const place = locateProblem(graph, p.at);
    if (!place) return;
    const id = place.node ?? place.system!;
    setSelection(new Set([id]));
    setSelectedBlock(place.block ? `${place.system}.${place.block}` : null);
    setSelectedWire(null);
    if (collapsed.has(id)) setCollapsed(id, false);
    const n = live.current.nodes.find((c) => c.id === id);
    if (n) frameAll([n]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isFieldTarget(e.target)) return;
    const key = (e.key ?? "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && key === "z" && !e.altKey) e.shiftKey ? redo() : undo();
    else if (mod && key === "y") redo();
    else if (mod && key === "d") {
      const made = duplicateItems(live.current.graph, selection);
      commit(made.graph);
      setSelection(new Set(made.ids));
    } else if (mod && key === "a") setSelection(new Set([...graph.systems, ...graph.nodes].map((n) => n.id)));
    else if (mod && (key === "c" || key === "x")) {
      const clip = copyItems(live.current.graph, selection);
      if (clip) {
        clipboard = clip;
        writeGraphClipboard(clip);
        if (key === "x") {
          commit(removeItems(live.current.graph, selection));
          setSelection(new Set());
        }
      }
    } else if (mod && key === "v") pasteHere();
    else if (mod && key === "g") groupSelection();
    else if (!mod && (key === "delete" || key === "backspace")) deleteSelection();
    else if (!mod && key === " ") openSearchAtPointer();
    else if (!mod && key === "f") frameAll();
    else if (key === "escape") {
      setSearch(null);
      setSelection(new Set());
      setSelectedBlock(null);
      setSelectedWire(null);
      setProblemsOpen(false);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // --- drawing ---------------------------------------------------------------------------------------

  const files = listedFiles(project.files);
  const assets = useMemo(
    () => ({
      images: files.filter((f) => assetKind(f) === "image").map((f) => `asset:${f}`),
      materials: files.filter((f) => assetKind(f) === "material" || assetKind(f) === "shadergraph").map((f) => `asset:${f}`),
      meshes: files.filter((f) => assetKind(f) === "model").map((f) => `asset:${f}`),
    }),
    [project.files],
  );

  const api: GraphEditorApi = {
    graph,
    readOnly,
    flowId,
    commit,
    wired,
    eventTargets,
    eventSources,
    problems: problemIndex,
    selectedBlock,
    selectBlock: (key) => {
      setSelectedBlock(key);
      setSelectedWire(null);
    },
    onPortDown,
    openBlockSearch: (system, context, output, client) => {
      const r = pane.current!.getBoundingClientRect();
      openSearch({ x: client.x - r.left, y: client.y - r.top }, { kind: "context", system, context, output }, null);
    },
    startBlockDrag,
    draggingBlock: blockDrag?.key ?? null,
    blockDrop: blockDrag?.drop ?? null,
    assets,
    sourceLabel: (from) => {
      const [id, port] = splitRef(from);
      const node = graph.nodes.find((n) => n.id === id);
      const def = node && nodeDef(node.type);
      if (!node || !def) return from;
      const name = node.type === "property" && node.settings?.name ? String(node.settings.name) : def.label;
      return def.outputs.length > 1 ? `${name} ${def.outputs.find((o) => o.name === port)?.label ?? port}` : name;
    },
    zoom: () => canvas.viewRef.current.zoom,
  };

  const groupRect = (g: GraphGroup) => {
    const members = canvasNodes.filter((n) => g.members.includes(n.id));
    if (members.length === 0) return null;
    const pad = 16, head = 28;
    const x0 = Math.min(...members.map((n) => n.x)) - pad, y0 = Math.min(...members.map((n) => n.y)) - pad - head;
    const x1 = Math.max(...members.map((n) => n.x + n.width)) + pad, y1 = Math.max(...members.map((n) => n.y + n.height)) + pad;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  const errors = problems.filter((p) => p.severity === "error").length;
  const empty = graph.systems.length === 0 && graph.nodes.length === 0;

  return (
    <GraphEditorContext.Provider value={api}>
      <div class={`particle-graph${maximized ? " maximized" : ""}`} ref={root} tabIndex={0} onKeyDown={onKeyDown} aria-label="Particle Graph">
        <div class="sg-toolbar pg-toolbar">
          <span class="sg-name" title={path}>
            {effectName(path)}
          </span>
          <span class="pg-problems-anchor">
            <button
              type="button"
              class={`pg-problem-count${problems.length ? (errors ? " error" : " warning") : ""}`}
              aria-label="Problems"
              aria-expanded={problemsOpen}
              title={problems.length ? "Show the problems" : "No problems"}
              disabled={problems.length === 0}
              onClick={() => setProblemsOpen(!problemsOpen)}
            >
              {problems.length === 0 ? "No problems" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`}
            </button>
            {problemsOpen && problems.length > 0 && (
              <ul class="pg-problem-list" aria-label="Particle graph problems">
                {problems.map((p) => (
                  <li key={`${p.at}|${p.message}`} class={p.severity}>
                    <button type="button" title={p.at ? `Show ${p.at}` : undefined} onClick={() => focusProblem(p)}>
                      {p.severity === "error" ? "Error: " : ""}
                      {p.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
          <span class="sg-spacer" />
          <button title="Undo (Ctrl+Z)" disabled={readOnly || history.undo.length === 0} onClick={undo}>
            Undo
          </button>
          <button title="Redo (Ctrl+Y)" disabled={readOnly || history.redo.length === 0} onClick={redo}>
            Redo
          </button>
          <button title="Add a system or node (Space, or right-click the canvas; over a context, add a block)" disabled={readOnly} onClick={() => openSearch(paneCenter(), { kind: "canvas" }, null)}>
            Add
          </button>
          <button title="Put the selected systems and nodes in a group (Ctrl+G)" disabled={readOnly || selection.size === 0} onClick={groupSelection}>
            Group
          </button>
          <button title="Add a sticky note" disabled={readOnly} onClick={addNoteHere}>
            Note
          </button>
          <button title="Show everything (F)" onClick={() => frameAll()}>
            Frame
          </button>
          <button aria-pressed={showMinimap} class={showMinimap ? "active" : ""} title="Show the minimap" onClick={() => setShowMinimap(!showMinimap)}>
            Minimap
          </button>
          <button aria-pressed={showPreview} class={showPreview ? "active" : ""} title="Show the preview" onClick={() => setShowPreview(!showPreview)}>
            Preview
          </button>
          <button aria-pressed={maximized} title={maximized ? "Back into the layout" : "Fill the window"} onClick={() => setMaximized(!maximized)}>
            {maximized ? "Restore" : "Maximize"}
          </button>
        </div>
        {migrated && !readOnly && <p class="pg-notice">This effect is in the old format (myco.particles@1). Your first edit saves it as a graph.</p>}
        {readOnly && <p class="pg-notice">This project is read-only: you can look at the effect, but not change it.</p>}
        <div class="pg-body">
          <Blackboard collapsed={blackboardCollapsed} onCollapse={setBlackboardCollapsed} placeNode={(name) => placeProperty(name)} />
          <div
            class="sg-pane pg-pane"
            ref={pane}
            onPointerDown={onPaneDown}
            onPointerMove={canvas.onPointerMove}
            onContextMenu={(e) => e.preventDefault()}
            onDragOver={(e) => {
              if (!readOnly && e.dataTransfer?.types.includes(PROPERTY_DRAG)) e.preventDefault();
            }}
            onDrop={(e) => {
              const name = e.dataTransfer?.getData(PROPERTY_DRAG);
              if (!name || readOnly) return;
              e.preventDefault();
              const r = pane.current!.getBoundingClientRect();
              placeProperty(name, { x: e.clientX - r.left, y: e.clientY - r.top });
            }}
          >
            <div class="sg-viewport" ref={viewport} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
              {graph.groups.map((g) => {
                const r = groupRect(g);
                if (!r) return null;
                return (
                  <div key={g.id} class="sg-group" style={{ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) }} aria-label={`Group ${g.title}`}>
                    <div class={`sg-group-head ${NO_PAN}`} onPointerDown={(e) => startGroupDrag(e, g)}>
                      <input type="text" class={NO_DRAG} aria-label="Group title" disabled={readOnly} value={g.title} onChange={(e) => commit(setGroupTitle(live.current.graph, g.id, (e.currentTarget as HTMLInputElement).value))} />
                      <button title="Ungroup (the systems and nodes stay)" aria-label={`Ungroup ${g.title}`} disabled={readOnly} onClick={() => commit(ungroup(live.current.graph, g.id))}>
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
              {graph.notes.map((n) => (
                <NoteView key={n.id} note={n} zoom={view.zoom} readOnly={readOnly} onChange={(patch) => commit(updateNote(live.current.graph, n.id, patch))} onRemove={() => commit(removeNote(live.current.graph, n.id))} />
              ))}
              {graph.systems.map((s) => (
                <SystemView
                  key={s.id}
                  system={s}
                  at={position(s)}
                  selected={selection.has(s.id)}
                  collapsed={collapsed.has(s.id)}
                  onCollapse={(c) => setCollapsed(s.id, c)}
                  onDown={onItemDown}
                  drag={dragHooks}
                />
              ))}
              {graph.nodes.map((n) => (
                <NodeView key={n.id} node={n} at={position(n)} selected={selection.has(n.id)} onDown={onItemDown} drag={dragHooks} />
              ))}
              <Wires
                graph={graph}
                nodes={nodeById}
                types={wireTypes}
                gpu={problemIndex.gpuWires}
                selected={selectedWire}
                detached={detached}
                draft={draft}
                onSelect={(w) => {
                  root.current?.focus({ preventScroll: true });
                  setSelection(new Set());
                  setSelectedBlock(null);
                  setSelectedWire(w);
                }}
              />
              {draft && hint && (
                <div class="pg-refusal" style={{ left: px(draft.to.x + 12), top: px(draft.to.y + 12) }} role="tooltip">
                  {hint}
                </div>
              )}
            </div>
            {empty && <p class="pg-canvas-empty">Right-click or press Space to add a system.</p>}
            {box && <SelectionBox box={box} />}
            {showMinimap && <Minimap nodes={canvasNodes} view={view} size={paneSize} pane={paneApi} />}
            {showPreview && <PreviewCard graph={graph} problems={problems.length} onClose={() => setShowPreview(false)} />}
            {search && (
              <NodeSearchPopup
                items={searchItems}
                at={search.at}
                onPick={pick}
                onClose={closeSearch}
                {...(search.target.kind === "context" ? { title: "Add block", placeholder: "Search blocks", none: "No blocks match" } : {})}
              />
            )}
          </div>
        </div>
      </div>
    </GraphEditorContext.Provider>
  );
}

/** The live preview as a floating card in the canvas's corner: collapse it, close it, or resize it from its top-left corner. */
function PreviewCard(props: { graph: ParticleGraph; problems: number; onClose(): void }) {
  const [open, setOpen] = useState(true);
  const [size, setSize] = useState(previewSize);
  const resize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, ...size };
    startPointerDrag(e, {
      zoom: () => 1,
      onMove: (dx, dy) => setSize((previewSize = { w: Math.max(200, start.w - dx), h: Math.max(140, start.h - dy) })),
      onEnd: () => undefined,
    });
  };
  return (
    <div class={`pg-previewcard ${NO_PAN}`} aria-label="Effect preview" onPointerDown={(e) => e.stopPropagation()}>
      {open && <div class="pg-previewcard-resize" title="Drag to resize" onPointerDown={resize} />}
      <div class="pg-previewcard-head">
        <button type="button" class="pg-fold" aria-label={open ? "Collapse the preview" : "Expand the preview"} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <span>Preview</span>
        <span class="sg-spacer" />
        <button type="button" class="pg-x" aria-label="Hide the preview" title="Hide the preview (Preview in the toolbar shows it again)" onClick={props.onClose}>
          ×
        </button>
      </div>
      {open && (
        <div class="pg-previewcard-body" style={{ width: px(size.w), height: px(size.h) }}>
          <ParticleGraphPreview graph={props.graph} problems={props.problems} />
        </div>
      )}
    </div>
  );
}
