// The Particle Graph editor (ADR 0060) for one effect asset: systems of stacked contexts and
// blocks, value and event nodes wired into them, the Blackboard, the live preview, and the
// compiler's problems on the graph. Built on the shared graph layer (src/editor/graph/) and
// following the Shader Graph panel's conventions: every edit is a pure function on the graph, handed
// to the file's asset document (ADR 0134), which keeps undo and redo, writes it, and replaces the
// graph when the file changes elsewhere. Edits made during one pointer gesture (a curve key or note
// dragged) or one colour pick coalesce into one undo step and one write.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { expandParticleGraph, outputTypeResolved, portRateResolved } from "../../../../../engine/scene/particleSubgraphs";
import type { ParticleProgram } from "../../../../../engine/scene/particleCompile";
import type { ContextKind, GraphGroup, GraphNode, GraphProblem, ParticleGraph, Vec2 } from "../../../../../engine/scene/particleGraph";
import type { PortType } from "../../../../../engine/scene/particleNodes";
import { usePanelHistory, type UndoHistory, editor, GraphPreviewCard, NO_DRAG, NO_PAN, NoteView, NodeSearchPopup, Minimap, SelectionBox, GraphFindBox, WireRefusal, px, toGraph, useGraphCanvas, useGraphFind, useGraphSearch, useGraphSelection, useGraphWiring, usePreviewCardSize, type CanvasNode, type Point, type EditorProject, EmptyState } from "../../../../../editor/sdk";
import { compileEffectGraph, effectFileMigrated, particleDocument, projectParticleAssets } from "../../particleAssets";
import { ASSET_INPUT, BLOCK_CONTEXTS, addPseudoNode, assetMeta, assetToDoc, canMoveToAsset, editorNodeDef, extractSubgraph, isPseudo, setAssetMeta, wireRulesGraph } from "../../particleGraph/assetDocs";
import {
  addBlock,
  addNode,
  addSystem,
  canMoveBlock,
  connectWire,
  disconnect,
  disconnectEvent,
  moveBlock,
  moveItems,
  particleGraphEdits,
  particleWiring,
  removeBlock,
  collapsedSystems,
  setSystemCollapsed,
  splitRef,
  whyNotWire,
} from "../../particleGraph/graphEdit";
import { indexProblems, locateProblem } from "../../particleGraph/problems";
import { Blackboard, PROPERTY_DRAG } from "./Blackboard";
import { GraphEditorContext, type BlockDrop, type GraphEditorApi } from "./editorContext";
import { NODE_WIDTH, SYSTEM_WIDTH, canvasNode, measureCanvas, sameMeasure, type Measured } from "./layout";
import { NodeView } from "./NodeView";
import { ParticleGraphPreview } from "./PreviewPane";
import { assetCanvasItems, blockItems, canvasItems, nodeItems, particleFindItems, type GraphSearchItem } from "./search";
import { SystemView } from "./SystemView";
import { Wires, type WireSelection } from "./Wires";
import "../../../../../editor/graph/graph.css";
import "./particleGraph.css";

/** Effects framed once this session (the first view fits the graph as measured). */
const framed = new Set<string>();

/** What a dropped wire connects a node from the search to. */
type Pending = { side: "output" | "input"; ref: string } | null;
type SearchTarget = { kind: "canvas" } | { kind: "context"; system: string; context: ContextKind; output: number };

const effectName = (path: string) => editor.assets.fileName(path).replace(/\.(particles|particlesubgraph|particleblock)\.json$/i, "");

export function ParticleGraphEditor(props: { project: EditorProject; path: string }) {
  const { project, path } = props;
  const doc = particleDocument(project, path);
  const readOnly = doc.readOnly;
  const version = editor.project.version; // sub-graph and block assets this graph uses may change on disk or elsewhere in the editor
  const graph = doc.value.value;
  // Its parse problems: `GraphProblem`s (they say where), as the plugin's formats report them; a file that couldn't
  // be read at all has one problem without a severity (the asset kind host's, ADR 0233), an error.
  const parseProblems = useMemo(() => doc.problems.value.map((p): GraphProblem => ("severity" in p ? (p as GraphProblem) : { severity: "error", message: p.message })), [doc.problems.value]);
  // An old-format file (written as a graph by the first edit).
  const migrated = useMemo(() => effectFileMigrated(project, path), [version, path]);
  useEffect(() => () => void doc.flush(), [doc]); // write a pending gesture's edits when the panel closes
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<WireSelection | null>(null);
  const [blockDrag, setBlockDrag] = useState<{ key: string; drop: BlockDrop | null } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [previewSize, setPreviewSize] = usePreviewCardSize("particle-graph", { w: 300, h: 220 });
  const [blackboardCollapsed, setBlackboardCollapsed] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [measured, setMeasured] = useState<Map<string, Measured>>(new Map());

  const root = useRef<HTMLDivElement>(null);
  // Selection, box select, item drags and the shared shortcuts (ADR 0228, 0259); a selected wire or block is this panel's own.
  const keys = useGraphSelection({
    edits: particleGraphEdits,
    graph: () => doc.value.peek(),
    commit: (next) => commit(next),
    move: moveItems,
    readOnly,
    root,
    canvas: () => canvas,
    nodes: () => live.current.nodes,
    paneIgnore: ".pg-system, .pg-node, .sg-search, .sg-find, .sg-wire-hit, .sg-note, .sg-group-head, .sg-minimap, .sg-previewcard, .pg-popover",
    openSearch: () => openSearchAtPointer(),
    openFind: () => find.open(),
    deleteOther: () => {
      const g = doc.value.peek();
      if (selectedWire) {
        commit(selectedWire.kind === "edge" ? disconnect(g, selectedWire.to) : disconnectEvent(g, selectedWire.from, selectedWire.to));
        setSelectedWire(null);
      } else if (selectedBlock) {
        const [system, block] = selectedBlock.split(".");
        commit(removeBlock(g, system, block));
        setSelectedBlock(null);
      } else return false;
      return true;
    },
    onItemDown: (e) => {
      setSelectedWire(null);
      setProblemsOpen(false);
      if (!(e.target as Element).closest(".pg-block")) setSelectedBlock(null);
    },
    onPaneDown: () => {
      search.dismiss();
      setSelectedWire(null);
      setSelectedBlock(null);
      setProblemsOpen(false);
    },
    onEscape: () => {
      search.dismiss();
      setSelectedBlock(null);
      setSelectedWire(null);
      setProblemsOpen(false);
    },
  });
  const { selection, setSelection, box, dragging } = keys;
  const viewport = useRef<HTMLDivElement>(null);
  /** A pointer gesture or colour pick in progress: its edits coalesce into one undo step (written when it ends). */
  const gesture = useRef({ pointer: false, color: false });

  const collapsed = useMemo(() => collapsedSystems(graph), [graph]);
  /** Reads a project asset's JSON by `asset:` reference (sub-graph and custom block ports come from these). */
  const resolve = projectParticleAssets(project);
  const assetDoc = assetMeta(graph);
  /** The graph as the wire rules read it (an open asset's Input nodes as constants). */
  const rulesGraph = useMemo(() => wireRulesGraph(graph), [graph]);
  /**
   * The effect as the game will play it (ADR 0315): its sub-graphs inlined (`graph`, which the wire rules read), its
   * problems and the program the preview shows. An open sub-graph or custom block isn't an effect: it's only expanded.
   */
  const expansion = useMemo((): { graph: ParticleGraph; problems: GraphProblem[]; program: ParticleProgram | null } => {
    if (!assetDoc) return compileEffectGraph(project, rulesGraph);
    return { ...expandParticleGraph(rulesGraph, resolve), program: null };
  }, [rulesGraph, version, assetDoc]);
  const problems = useMemo(() => [...parseProblems, ...expansion.problems], [parseProblems, expansion]);
  const typeOf = (node: GraphNode, port: string): PortType | null =>
    node.type === ASSET_INPUT ? ((node.settings?.type as PortType | undefined) ?? "number") : isPseudo(node.type) ? null : outputTypeResolved(rulesGraph, node, port, resolve, expansion.graph);
  const problemIndex = useMemo(() => indexProblems(graph, problems), [graph, problems]);
  const wired = useMemo(() => new Map(graph.edges.map((e) => [e.to, e.from])), [graph]);
  const eventTargets = useMemo(() => new Set(graph.events.map((e) => e.to)), [graph]);
  const eventSources = useMemo(() => new Set(graph.events.map((e) => e.from)), [graph]);
  const wireTypes = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of graph.edges) {
      const [id, port] = splitRef(e.from);
      const node = graph.nodes.find((n) => n.id === id);
      m.set(e.from, (node && typeOf(node, port)) ?? "number");
    }
    return m;
  }, [graph, expansion]);

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
      if (target.closest(".pg-node, .sg-previewcard, .pg-popover")) return;
      e.preventDefault();
      const ctx = target.closest<HTMLElement>("[data-context]");
      search.open(at, { target: ctx ? contextTarget(ctx) : { kind: "canvas" }, pending: null });
    },
  });
  const { pane, paneApi, view, paneSize, paneCenter, frameAll } = canvas;

  // xyflow and the drags read the latest state through these (the graph: the document's, edits included).
  const live = useRef({ get graph() { return doc.value.peek(); }, nodes: canvasNodes });
  live.current = { get graph() { return doc.value.peek(); }, nodes: canvasNodes };

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

  /**
   * Apply an edit through the document: one undo step, shown and saved (a read-only project says so in
   * the status bar). During a pointer gesture or a colour pick, edits coalesce into one step.
   */
  const commit = (next: ParticleGraph) => {
    if (next === doc.value.peek()) return;
    doc.edit(next, gesture.current.pointer || gesture.current.color ? { coalesce: true } : undefined);
  };

  /** A pointer gesture starts: its edits coalesce until the pointer is released, then they're written. */
  const startGesture = (e: PointerEvent) => {
    if (e.button !== 0 || gesture.current.pointer) return;
    gesture.current.pointer = true;
    const end = () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      gesture.current.pointer = false;
      void doc.flush();
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  };
  const isColorInput = (t: EventTarget | null) => t instanceof HTMLInputElement && t.type === "color";

  /** Collapse or expand a system's frame: a view change, so it saves but stays out of undo. */
  const setCollapsed = (id: string, c: boolean) => {
    if (readOnly) return;
    doc.edit(setSystemCollapsed(doc.value.peek(), id, c), { history: false });
  };

  // Undo and redo restore the graph as it was edited, but keep the frames as they are now.
  const keepView = (restored: ParticleGraph, current: ParticleGraph): ParticleGraph => {
    const now = collapsedSystems(current);
    let g = restored;
    for (const s of restored.systems) g = setSystemCollapsed(g, s.id, now.has(s.id));
    return g;
  };
  /** Move through the document's history, keeping the frames as they are. */
  const step = (move: () => void) => {
    if (readOnly) return;
    const now = doc.value.peek();
    move();
    doc.edit(keepView(doc.value.peek(), now), { history: false });
  };
  const undo = () => doc.canUndo.peek() && step(() => doc.undo());
  const redo = () => doc.canRedo.peek() && step(() => doc.redo());
  // While the panel has the focus, this is the active history (ADR 0145): Ctrl+Z, Edit > Undo and the
  // History panel act on the document through it, so they keep the frames too.
  const panelHistory = useMemo<UndoHistory>(
    () => ({
      get name() {
        return doc.path;
      },
      get canUndo() {
        return !doc.readOnly && doc.canUndo.value;
      },
      get canRedo() {
        return !doc.readOnly && doc.canRedo.value;
      },
      get undoLabel() {
        return doc.undoLabel.value;
      },
      get redoLabel() {
        return doc.redoLabel.value;
      },
      undo: () => void latest.current.undo(),
      redo: () => void latest.current.redo(),
      back: () => latest.current.step(() => doc.history.back()),
      forward: () => latest.current.step(() => doc.history.forward()),
      tree: {
        version: doc.history.version,
        get states() {
          return doc.history.states;
        },
        get current() {
          return doc.history.current;
        },
        get saved() {
          return doc.history.saved;
        },
        jumpTo: (seq) => latest.current.step(() => doc.history.jumpTo(seq)),
      },
    }),
    [doc],
  );
  const latest = useRef({ undo, redo, step });
  latest.current = { undo, redo, step };
  usePanelHistory(root, panelHistory);

  // --- search ----------------------------------------------------------------------------------------

  const contextTarget = (el: HTMLElement): SearchTarget => {
    const [system, context, output] = el.dataset.context!.split(":") as [string, ContextKind, string | undefined];
    return { kind: "context", system, context, output: Number(output ?? 0) };
  };

  /** The search: where it opened, what it adds to (the canvas or a context), and the port a dropped wire connects the new node to. */
  const search = useGraphSearch<{ target: SearchTarget; pending: Pending }>({ pane: canvas.pane, root, readOnly });

  /** Space: the search for what's under the pointer (a context's blocks, or the canvas). */
  const openSearchAtPointer = () => {
    const at = canvas.pointer.current ?? paneCenter();
    const r = pane.current!.getBoundingClientRect();
    const ctx = document.elementFromPoint(r.left + at.x, r.top + at.y)?.closest<HTMLElement>("[data-context]");
    search.open(at, { target: ctx ? contextTarget(ctx) : { kind: "canvas" }, pending: null });
  };

  const pick = (item: GraphSearchItem) => {
    if (!search.search) return;
    const { at, target, pending } = search.search;
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
      const left = pending?.side === "input";
      const place: [number, number] = [left ? p.x - NODE_WIDTH - 20 : p.x, p.y - 14];
      const made = isPseudo(item.pick.type) ? addPseudoNode(g, item.pick.type, place, item.pick.settings) : addNode(g, item.pick.type, place, item.pick.settings);
      let next = made.graph;
      const def = editorNodeDef(next.nodes.find((n) => n.id === made.id)!, resolve);
      if (pending?.side === "output") {
        const input = def?.inputs.find((i) => !i.noPort && !whyNotWire(next, pending.ref, `${made.id}.${i.name}`, resolve));
        if (input) next = connectWire(next, pending.ref, `${made.id}.${input.name}`, resolve);
      } else if (pending?.side === "input") {
        const output = def?.outputs.find((o) => !whyNotWire(next, `${made.id}.${o.name}`, pending.ref, resolve));
        if (output) next = connectWire(next, `${made.id}.${output.name}`, pending.ref, resolve);
      }
      commit(next);
      setSelection(new Set([made.id]));
    }
    search.close();
  };

  const open = search.search;
  const searchItems = useMemo(() => {
    if (!open) return [];
    if (open.target.kind === "context") return blockItems(open.target.context);
    if (assetDoc) return assetCanvasItems(assetDoc);
    return open.pending ? nodeItems(graph) : canvasItems(graph);
  }, [open, graph.properties, assetDoc?.kind, assetDoc?.contexts?.join()]);

  // --- wiring ----------------------------------------------------------------------------------------

  const isEventPort = (owner: string, port: string, side: "input" | "output") => {
    const g = live.current.graph;
    if (g.systems.some((s) => s.id === owner)) return port === "start" || port === "stop" || side === "output";
    const node = g.nodes.find((n) => n.id === owner);
    return !!node && editorNodeDef(node)?.outputs.find((o) => o.name === port)?.type === "event";
  };

  // The wiring gesture (ADR 0259): a value wire dropped in empty space opens the search for nodes that fit it; an event wire opens nothing.
  const wiring = useGraphWiring({
    flowPrefix: "pg",
    edits: particleWiring(resolve),
    graph: () => doc.value.peek(),
    commit: (next) => commit(next),
    readOnly,
    root,
    canvas: () => canvas,
    nodes: () => live.current.nodes,
    onDropInSpace: (at, from) => {
      if (!isEventPort(from.node, from.port, from.side)) search.open(at, { target: { kind: "canvas" }, pending: { side: from.side, ref: from.ref } });
    },
  });
  const { flowId, draft, detached } = wiring;

  // --- find ------------------------------------------------------------------------------------------

  // Ctrl+F (ADR 0117): systems by name and block, nodes by title, type and settings, notes and group titles.
  const find = useGraphFind({
    edits: particleGraphEdits,
    graph,
    items: (g) => particleFindItems(g, resolve),
    setSelection,
    frameAll,
    nodes: () => live.current.nodes,
    root,
    onOpen: () => search.dismiss(),
    onGo: (m) => {
      setSelectedWire(null);
      setSelectedBlock(null);
      setProblemsOpen(false);
      for (const id of m.frame) if (collapsed.has(id)) setCollapsed(id, false);
    },
  });

  // --- selection and drags ---------------------------------------------------------------------------

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

  // --- commands --------------------------------------------------------------------------------------

  /** Move the selected operator nodes into a new sub-graph asset beside this file, replaced by a Sub-graph node (one undo step; the asset file stays). */
  const saveAsSubgraph = async () => {
    if (readOnly) return;
    const probe = extractSubgraph(live.current.graph, selection, "asset:", resolve);
    if (!probe) {
      editor.messages.info("Select operator nodes to save as a sub-graph (property and event nodes can't move into one).");
      return;
    }
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const made = await editor.assets.create("particlesubgraph", { folder, value: assetToDoc(probe.asset, "subgraph").graph, name: "Sub-graph" });
    if (!made) return;
    const done = extractSubgraph(live.current.graph, selection, `asset:${made}`, resolve);
    if (!done) return;
    commit(done.graph);
    setSelection(new Set([done.node]));
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

  // --- drawing ---------------------------------------------------------------------------------------

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
    onPortDown: wiring.onPortDown,
    openBlockSearch: (system, context, output, client) => {
      const r = pane.current!.getBoundingClientRect();
      search.open({ x: client.x - r.left, y: client.y - r.top }, { target: { kind: "context", system, context, output }, pending: null });
    },
    startBlockDrag,
    draggingBlock: blockDrag?.key ?? null,
    blockDrop: blockDrag?.drop ?? null,
    path,
    resolve,
    assetDoc,
    typeOf,
    rateOf: (ref) => portRateResolved(rulesGraph, ref, resolve, expansion.graph),
    sourceLabel: (from) => {
      const [id, port] = splitRef(from);
      const node = graph.nodes.find((n) => n.id === id);
      const def = node && editorNodeDef(node, resolve);
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
      <div
        class={`particle-graph${maximized ? " maximized" : ""}`}
        data-asset-document={doc.path}
        ref={root}
        tabIndex={0}
        {...keys.rootProps}
        onPointerDownCapture={startGesture}
        onInputCapture={(e) => {
          if (isColorInput(e.target)) gesture.current.color = true;
        }}
        onChangeCapture={(e) => {
          if (!isColorInput(e.target)) return;
          gesture.current.color = false;
          void doc.flush();
        }}
        aria-label="Particle Graph"
      >
        <div class="sg-toolbar pg-toolbar">
          <span class="sg-name" title={path}>
            {effectName(path)}
          </span>
          {assetDoc && (
            <span class="pg-asset-fields">
              <span title={assetDoc.kind === "block" ? "Edited as a document of its own: the Input nodes are the block's inputs, the Block nodes its blocks." : "Edited as a document of its own: the Input and Output nodes are the ports of the Sub-graph node that uses it."}>
                {assetDoc.kind === "block" ? "Custom block asset" : "Sub-graph asset"}
              </span>
              {assetDoc.kind === "block" && (
                <>
                  <label>
                    Label
                    <input type="text" aria-label="Block label" disabled={readOnly} value={assetDoc.label ?? ""} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => commit(setAssetMeta(live.current.graph, { label: (e.currentTarget as HTMLInputElement).value }))} />
                  </label>
                  {BLOCK_CONTEXTS.map((c) => (
                    <label key={c} title={`The block can be added to the ${c} context`}>
                      <input
                        type="checkbox"
                        aria-label={`Context ${c}`}
                        disabled={readOnly}
                        checked={(assetDoc.contexts ?? []).includes(c)}
                        onChange={(e) => {
                          const on = (e.currentTarget as HTMLInputElement).checked;
                          const next = BLOCK_CONTEXTS.filter((k) => (k === c ? on : (assetDoc.contexts ?? []).includes(k)));
                          commit(setAssetMeta(live.current.graph, { contexts: next.length ? next : assetDoc.contexts }));
                        }}
                      />
                      {c}
                    </label>
                  ))}
                </>
              )}
            </span>
          )}
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
          <button title="Find in this graph (Ctrl+F)" aria-pressed={find.isOpen} onClick={find.toggle}>
            Find
          </button>
          <button title="Undo (Ctrl+Z)" disabled={readOnly || !doc.canUndo.value} onClick={undo}>
            Undo
          </button>
          <button title="Redo (Ctrl+Y)" disabled={readOnly || !doc.canRedo.value} onClick={redo}>
            Redo
          </button>
          <button title="Add a system or node (Space, or right-click the canvas; over a context, add a block)" disabled={readOnly} onClick={() => search.open(paneCenter(), { target: { kind: "canvas" }, pending: null })}>
            Add
          </button>
          <button
            title="Move the selected operator nodes into a new particle sub-graph asset, replaced by a Sub-graph node"
            disabled={readOnly || !graph.nodes.some((n) => selection.has(n.id) && canMoveToAsset(n))}
            onClick={() => void saveAsSubgraph()}
          >
            Save as sub-graph
          </button>
          <button title="Put the selected systems and nodes in a group (Ctrl+G)" disabled={readOnly || selection.size === 0} onClick={keys.groupSelection}>
            Group
          </button>
          <button title="Add a sticky note" disabled={readOnly} onClick={keys.addNoteHere}>
            Note
          </button>
          <button title="Show everything (F)" onClick={() => frameAll()}>
            Frame
          </button>
          <button aria-pressed={showMinimap} class={showMinimap ? "active" : ""} title="Show the minimap" onClick={() => setShowMinimap(!showMinimap)}>
            Minimap
          </button>
          {!assetDoc && (
            <button aria-pressed={showPreview} class={showPreview ? "active" : ""} title="Show the preview" onClick={() => setShowPreview(!showPreview)}>
              Preview
            </button>
          )}
          <button aria-pressed={maximized} title={maximized ? "Back into the layout" : "Fill the window"} onClick={() => setMaximized(!maximized)}>
            {maximized ? "Restore" : "Maximize"}
          </button>
        </div>
        {migrated && !readOnly && <p class="pg-notice">This effect is in the old format (myco.particles@1). Your first edit saves it as a graph.</p>}
        {readOnly && <p class="pg-notice">This project is read-only: you can look at the effect, but not change it.</p>}
        <div class="pg-body">
          {!assetDoc && <Blackboard collapsed={blackboardCollapsed} onCollapse={setBlackboardCollapsed} placeNode={(name) => placeProperty(name)} />}
          <div
            class="sg-pane pg-pane"
            ref={pane}
            onPointerDown={keys.onPaneDown}
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
                    <div class={`sg-group-head ${NO_PAN}`} onPointerDown={(e) => keys.startGroupDrag(e, g.id)}>
                      <input type="text" class={NO_DRAG} aria-label="Group title" disabled={readOnly} value={g.title} onChange={(e) => commit(particleGraphEdits.setGroupTitle(live.current.graph, g.id, (e.currentTarget as HTMLInputElement).value))} />
                      <button title="Ungroup (the systems and nodes stay)" aria-label={`Ungroup ${g.title}`} disabled={readOnly} onClick={() => commit(particleGraphEdits.ungroup(live.current.graph, g.id))}>
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
              {graph.notes.map((n) => (
                <NoteView key={n.id} note={n} zoom={view.zoom} readOnly={readOnly} onChange={(patch) => commit(particleGraphEdits.updateNote(live.current.graph, n.id, patch))} onRemove={() => commit(particleGraphEdits.removeNote(live.current.graph, n.id))} />
              ))}
              {graph.systems.map((s) => (
                <SystemView
                  key={s.id}
                  system={s}
                  at={position(s)}
                  selected={selection.has(s.id)}
                  collapsed={collapsed.has(s.id)}
                  onCollapse={(c) => setCollapsed(s.id, c)}
                  onDown={keys.onItemDown}
                  drag={keys.drag}
                />
              ))}
              {graph.nodes.map((n) => (
                <NodeView key={n.id} node={n} at={position(n)} selected={selection.has(n.id)} onDown={keys.onItemDown} drag={keys.drag} />
              ))}
              <Wires
                graph={graph}
                nodes={nodeById}
                types={wireTypes}
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
              <WireRefusal draft={draft} hint={wiring.hint} />
            </div>
            {empty && <div class="pg-canvas-hint"><EmptyState compact title={assetDoc ? "Right-click or press Space to add a node." : "Right-click or press Space to add a system."} /></div>}
            {box && <SelectionBox box={box} />}
            {showMinimap && <Minimap nodes={canvasNodes} view={view} size={paneSize} pane={paneApi} />}
            {showPreview && expansion.program && (
              <GraphPreviewCard label="Effect preview" size={previewSize} onResize={setPreviewSize} onClose={() => setShowPreview(false)}>
                <ParticleGraphPreview program={expansion.program} problems={problems.length} />
              </GraphPreviewCard>
            )}
            <GraphFindBox find={find} placeholder="Find systems, blocks, nodes, notes…" />
            {open && (
              <NodeSearchPopup
                items={searchItems}
                at={open.popup}
                onPick={pick}
                onClose={search.close}
                {...(open.target.kind === "context" ? { title: "Add block", placeholder: "Search blocks", none: "No blocks match" } : {})}
              />
            )}
          </div>
        </div>
      </div>
    </GraphEditorContext.Provider>
  );
}
