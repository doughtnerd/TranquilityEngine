import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { MaterialPreview, type PreviewMesh } from "../../engine/editor";
import { compileShaderGraph, shaderGraphListing, type CompiledShaderGraph } from "../../engine/render/shaderGraph/compile";
import { NODES, nodeDef, type PortDef, type SettingDef, type ValueType } from "../../engine/render/shaderGraph/nodes";
import { formatShaderGraph, GRAPH_PROPERTY_TYPES, portRef, propertySize, splitPortRef, type GraphNode, type GraphPropertyType, type GraphValue, type InputValue, type ShaderGraph } from "../../engine/scene/shaderGraph";
import { assetKind, fileName } from "../assetBrowser";
import { errorStatus } from "../messages";
import type { EditorProject } from "../projects";
import {
  addNode,
  addProperty,
  categoryRank,
  connect,
  disconnect,
  duplicateNodes,
  firstInputFor,
  firstOutputFor,
  moveNodes,
  moveProperty,
  removeNodes,
  removeProperty,
  renameProperty,
  setGraphOptions,
  setInput,
  setPropertyType,
  setPropertyValue,
  setSetting,
  sourceOf,
  whyNotConnect,
  whyNotPropertyName,
} from "../shaderGraph/graphEdit";
import { HEADER, ROW, inlineFields, nodeBox, nodeTitle, portOffset, settingValue, type NodeBox } from "../shaderGraph/nodeLayout";
import { NO_DRAG, NO_PAN, NO_WHEEL, createNodeDrag, createPane, handleProps, startConnection, toGraph, wirePath, type CanvasNode, type DraftWire, type Point, type View } from "../shaderGraph/xyflow";
import { createMaterialForGraph, graphHistory, openShaderGraph, readShaderGraph, recordEdit, writeShaderGraph, createShaderGraph, openShaderGraphAsset } from "../shaderGraphAssets";
import { currentProject, docVersion, status } from "../state";
import "./shaderGraph.css";

/** Each graph's view (pan and zoom) this session, so switching tabs keeps it. */
const views = new Map<string, View>();

/** What a dropped connection or the node search connects a new node to. */
type Pending = { side: "output" | "input"; ref: string; type: ValueType | "dynamic" } | null;

/** The Shader Graph panel (ADR 0046): the graph open from the Assets panel, or how to open one. */
export function ShaderGraphPanel() {
  const path = openShaderGraph.value;
  const project = currentProject.value;
  if (!project) return <p class="empty">No project open</p>;
  if (!path || !project.files.includes(path)) {
    return (
      <div class="shader-graph-empty">
        <p>Double-click a shader graph (<code>*.shadergraph.json</code>) in the Assets panel to edit it here.</p>
        <button disabled={!project.canSave} onClick={() => void createShaderGraph("").then((made) => made && openShaderGraphAsset(made))}>
          New Shader Graph
        </button>
      </div>
    );
  }
  return <GraphEditor key={path} project={project} path={path} />;
}

/** A CSS length (Preact 11 doesn't add `px` to numbers). */
const px = (n: number) => `${n}px`;
const cssType = (t: ValueType | "dynamic") => `t-${t === "dynamic" ? "float" : t}`;
const isFieldTarget = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, select, textarea, button");

function GraphEditor(props: { project: EditorProject; path: string }) {
  const { project, path } = props;
  const readOnly = !project.canSave;
  docVersion.value; // re-read the file when it changes on disk or elsewhere in the editor

  const [graph, setGraph] = useState<ShaderGraph>(() => readShaderGraph(project, path).graph);
  const [parseProblems, setParseProblems] = useState<string[]>(() => readShaderGraph(project, path).problems);
  const [view, setViewState] = useState<View>(() => views.get(path) ?? { x: 80, y: 80, zoom: 1 });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Map<string, Point> | null>(null);
  const [draft, setDraft] = useState<DraftWire | null>(null);
  const [detached, setDetached] = useState<string | null>(null);
  const [search, setSearch] = useState<{ at: Point; pending: Pending } | null>(null);
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);
  const [showGlsl, setShowGlsl] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [shaderError, setShaderError] = useState<string | null>(null);
  const [, setHistoryTick] = useState(0);

  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const paneApi = useRef<ReturnType<typeof createPane> | null>(null);
  const flowId = useMemo(() => `sg${Math.random().toString(36).slice(2, 8)}`, []);
  /** The file text last read or written, to tell our own writes from changes made elsewhere. */
  const fileText = useRef(formatShaderGraph(graph));
  /** Saves in flight: until they land, the project still serves the text before them. */
  const saving = useRef(0);

  // A change to the file from outside the panel (another editor, an undo of a rename…) replaces the graph.
  const onDisk = readShaderGraph(project, path);
  const diskText = formatShaderGraph(onDisk.graph);
  if (diskText !== fileText.current && !dragging && saving.current === 0) {
    fileText.current = diskText;
    queueMicrotask(() => {
      setGraph(onDisk.graph);
      setParseProblems(onDisk.problems);
    });
  }

  const compiled: CompiledShaderGraph = useMemo(() => compileShaderGraph(graph), [graph]);
  const connectedInputs = useMemo(() => new Set(graph.edges.map((e) => e.to)), [graph]);

  const boxes = useMemo(() => {
    const m = new Map<string, NodeBox>();
    for (const n of graph.nodes) m.set(n.id, nodeBox(n, graph, (port) => connectedInputs.has(portRef(n.id, port)), compiled.dynamicTypes[n.id]));
    return m;
  }, [graph, compiled, connectedInputs]);

  const position = (n: GraphNode): Point => {
    const d = dragging?.get(n.id);
    return d ?? { x: n.position[0], y: n.position[1] };
  };

  const canvasNodes: CanvasNode[] = graph.nodes.map((n) => {
    const b = boxes.get(n.id)!;
    const p = position(n);
    const ports = (side: "input" | "output") => b.rows.filter((r) => r.kind === side).map((r) => ({ id: (r as { port: PortDef }).port.id, ...portOffset(b, side, (r as { port: PortDef }).port.id)! }));
    return { id: n.id, x: p.x, y: p.y, width: b.width, height: b.height, selected: selection.has(n.id), inputs: ports("input"), outputs: ports("output") };
  });

  // xyflow reads the latest state through these.
  const live = useRef({ graph, view, nodes: canvasNodes });
  live.current = { graph, view, nodes: canvasNodes };

  // --- editing ---------------------------------------------------------------------------------------

  const save = (next: ShaderGraph) => {
    const text = formatShaderGraph(next);
    fileText.current = text;
    saving.current++;
    writeShaderGraph(project, path, next)
      .catch((err) => (status.value = errorStatus(`Couldn't save ${fileName(path)}`, err)))
      .finally(() => {
        saving.current--;
        docVersion.value++;
      });
  };

  /** Apply an edit: remember the graph before it for undo, show it, and save it. */
  const commit = (next: ShaderGraph) => {
    const before = live.current.graph;
    if (next === before) return;
    if (readOnly) {
      status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to edit shader graphs.` };
      return;
    }
    recordEdit(path, before);
    live.current.graph = next;
    setGraph(next);
    setHistoryTick((t) => t + 1);
    save(next);
  };

  const history = graphHistory(path);
  const undo = () => {
    const prev = history.undo.pop();
    if (!prev || readOnly) return;
    history.redo.push(live.current.graph);
    live.current.graph = prev;
    setGraph(prev);
    setHistoryTick((t) => t + 1);
    save(prev);
  };
  const redo = () => {
    const next = history.redo.pop();
    if (!next || readOnly) return;
    history.undo.push(live.current.graph);
    live.current.graph = next;
    setGraph(next);
    setHistoryTick((t) => t + 1);
    save(next);
  };

  // --- canvas ----------------------------------------------------------------------------------------

  const setView = (v: View) => {
    views.set(path, v);
    live.current.view = v;
    setViewState(v);
  };

  const frameAll = (nodes = live.current.nodes) => {
    const el = pane.current;
    if (!el || nodes.length === 0) return;
    const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
    const x1 = Math.max(...nodes.map((n) => n.x + n.width)), y1 = Math.max(...nodes.map((n) => n.y + n.height));
    const w = el.clientWidth, h = el.clientHeight;
    const zoom = Math.min(1, (w - 80) / Math.max(1, x1 - x0), (h - 80) / Math.max(1, y1 - y0));
    const v = { zoom: Math.max(0.2, zoom), x: 0, y: 0 };
    v.x = w / 2 - ((x0 + x1) / 2) * v.zoom;
    v.y = h / 2 - ((y0 + y1) / 2) * v.zoom;
    paneApi.current?.setView(v);
    setView(v);
  };

  useLayoutEffect(() => {
    const el = pane.current!;
    paneApi.current = createPane(el, {
      view: live.current.view,
      onView: setView,
      onContextMenu: (e) => {
        if ((e.target as Element).closest(".sg-node")) return;
        e.preventDefault();
        openSearch({ x: e.clientX - el.getBoundingClientRect().left, y: e.clientY - el.getBoundingClientRect().top }, null);
      },
    });
    if (!views.has(path)) frameAll();
    return () => paneApi.current?.destroy();
  }, []);

  const panBy = (dx: number, dy: number) => paneApi.current?.panBy(dx, dy) ?? Promise.resolve(false);

  const openSearch = (at: Point, pending: Pending) => {
    if (readOnly) return;
    setSearch({ at, pending });
  };

  const paneCenter = (): Point => ({ x: (pane.current?.clientWidth ?? 400) / 2, y: (pane.current?.clientHeight ?? 300) / 2 });

  const connectOptions = (onConnect: (from: string, to: string) => void, onSpace: (at: Point) => void, onEnd: () => void = () => undefined) => ({
    flowId,
    pane: pane.current!,
    nodes: () => live.current.nodes,
    view: () => live.current.view,
    panBy,
    canConnect: (from: string, to: string) => !whyNotConnect(live.current.graph, from, to),
    onDraft: setDraft,
    onConnect,
    onDropInSpace: onSpace,
    onEnd,
  });

  const onPortDown = (e: MouseEvent, node: GraphNode, port: PortDef, side: "input" | "output") => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    root.current?.focus();
    const ref = portRef(node.id, port.id);
    const src = side === "input" ? sourceOf(graph, ref) : null;
    if (src) {
      // Dragging a connected input picks its wire up from the input end.
      const s = splitPortRef(src);
      const srcEl = pane.current!.querySelector(`[data-id="${flowId}-${s.node}-${s.port}-source"]`);
      if (!srcEl) return;
      setDetached(ref);
      startConnection(
        e,
        srcEl,
        s.node,
        s.port,
        "output",
        connectOptions(
          (from, to) => commit(connect(disconnect(live.current.graph, ref), from, to)),
          () => commit(disconnect(live.current.graph, ref)),
          () => setDetached(null),
        ),
      );
      return;
    }
    const type = side === "output" ? compiled.portTypes[ref] ?? (port.type === "dynamic" ? "float" : port.type) : port.type;
    startConnection(e, e.currentTarget as Element, node.id, port.id, side, connectOptions((from, to) => commit(connect(live.current.graph, from, to)), (at) => openSearch(at, { side, ref, type })));
  };

  const onNodeDown = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    root.current?.focus({ preventScroll: true });
    setSelectedEdge(null);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
    } else if (!selection.has(id)) setSelection(new Set([id]));
  };

  const onPaneDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest(".sg-node, .sg-search, .sg-wire-hit")) return;
    root.current?.focus({ preventScroll: true });
    setSearch(null);
    setSelectedEdge(null);
    const rect = pane.current!.getBoundingClientRect();
    const a = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(selection) : new Set<string>();
    if (!additive) setSelection(base);
    const el = pane.current!;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const b = { x: m.clientX - rect.left, y: m.clientY - rect.top };
      setBox({ a, b });
      const g0 = toGraph({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, live.current.view);
      const g1 = toGraph({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, live.current.view);
      const next = new Set(base);
      for (const n of live.current.nodes) if (n.x < g1.x && n.x + n.width > g0.x && n.y < g1.y && n.y + n.height > g0.y) next.add(n.id);
      setSelection(next);
    };
    const up = () => {
      setBox(null);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const deleteSelection = () => {
    if (selectedEdge) {
      commit(disconnect(graph, selectedEdge));
      setSelectedEdge(null);
    } else if (selection.size) {
      commit(removeNodes(graph, selection));
      setSelection(new Set());
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isFieldTarget(e.target)) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && key === "z" && !e.altKey) e.shiftKey ? redo() : undo();
    else if (mod && key === "y") redo();
    else if (mod && key === "d") {
      const made = duplicateNodes(graph, selection);
      commit(made.graph);
      setSelection(new Set(made.ids));
    } else if (mod && key === "a") setSelection(new Set(graph.nodes.map((n) => n.id)));
    else if (!mod && (key === "delete" || key === "backspace")) deleteSelection();
    else if (!mod && key === " ") openSearch(paneCenter(), null);
    else if (!mod && key === "f") frameAll();
    else if (key === "escape") {
      setSearch(null);
      setSelection(new Set());
      setSelectedEdge(null);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const addFromSearch = (type: string, settings: Record<string, string> | undefined, at: Point, pending: Pending) => {
    const p = toGraph(at, view);
    const made = addNode(graph, type, [p.x, p.y - HEADER], settings);
    let next = made.graph;
    if (pending?.side === "output") {
      const input = firstInputFor(type, pending.type === "dynamic" ? "float" : pending.type, next);
      if (input) next = connect(next, pending.ref, portRef(made.id, input));
    } else if (pending?.side === "input") {
      const output = firstOutputFor(type, pending.type, next, settings);
      if (output) {
        // Place the new node to the left of the input it feeds.
        next = moveNodes(next, new Map([[made.id, [p.x - (nodeBox(next.nodes.at(-1)!, next, () => false).width + 20), p.y - HEADER] as [number, number]]]));
        next = connect(next, portRef(made.id, output), pending.ref);
      }
    }
    commit(next);
    setSelection(new Set([made.id]));
    closeSearch();
  };

  /** Close the node search, keeping the keyboard on the graph. */
  const closeSearch = () => {
    setSearch(null);
    root.current?.focus({ preventScroll: true });
  };

  // --- preview ---------------------------------------------------------------------------------------

  const previewHost = useRef<HTMLDivElement>(null);
  const preview = useRef<MaterialPreview | null>(null);
  const [mesh, setMesh] = useState<PreviewMesh>("sphere");
  useEffect(() => {
    const p = new MaterialPreview(previewHost.current!);
    p.onShaderError = setShaderError;
    preview.current = p;
    Object.assign(window, { shaderGraphPreview: p });
    return () => {
      p.dispose();
      preview.current = null;
    };
  }, []);
  // Rebuild the preview's material when anything but node positions changes.
  const codeKey = JSON.stringify({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: 0 })) });
  useEffect(() => {
    preview.current?.setGraph(graph);
  }, [codeKey]);
  useEffect(() => preview.current?.setMesh(mesh), [mesh]);

  // --- drawing ---------------------------------------------------------------------------------------

  const nodeById = new Map(canvasNodes.map((n) => [n.id, n]));
  const portPoint = (ref: string, side: "input" | "output"): Point | null => {
    const { node, port } = splitPortRef(ref);
    const n = nodeById.get(node);
    const p = n && (side === "input" ? n.inputs : n.outputs).find((q) => q.id === port);
    return n && p ? { x: n.x + p.x, y: n.y + p.y } : null;
  };

  const images = project.files.filter((f) => assetKind(f) === "image");
  const problems = [...parseProblems, ...compiled.problems];

  return (
    <div class={`shader-graph${maximized ? " maximized" : ""}`} ref={root} tabIndex={0} onKeyDown={onKeyDown} aria-label="Shader Graph">
      <div class="sg-toolbar">
        <span class="sg-name" title={path}>
          {fileName(path)}
        </span>
        <label>
          Target{" "}
          <select aria-label="Target" disabled={readOnly} value={graph.target} onChange={(e) => commit(setGraphOptions(graph, { target: (e.currentTarget as HTMLSelectElement).value as ShaderGraph["target"] }))}>
            <option value="lit">Lit</option>
            <option value="unlit">Unlit</option>
          </select>
        </label>
        <label>
          Surface{" "}
          <select aria-label="Surface" disabled={readOnly} value={graph.surface} onChange={(e) => commit(setGraphOptions(graph, { surface: (e.currentTarget as HTMLSelectElement).value as ShaderGraph["surface"] }))}>
            <option value="opaque">Opaque</option>
            <option value="transparent">Transparent</option>
          </select>
        </label>
        <label>
          <input type="checkbox" aria-label="Double Sided" disabled={readOnly} checked={graph.doubleSided} onChange={(e) => commit(setGraphOptions(graph, { doubleSided: (e.currentTarget as HTMLInputElement).checked }))} /> Double Sided
        </label>
        <span class="sg-spacer" />
        <button title="Undo (Ctrl+Z)" disabled={readOnly || history.undo.length === 0} onClick={undo}>
          Undo
        </button>
        <button title="Redo (Ctrl+Shift+Z)" disabled={readOnly || history.redo.length === 0} onClick={redo}>
          Redo
        </button>
        <button title="Add a node (Space, or right-click the canvas)" disabled={readOnly} onClick={() => openSearch(paneCenter(), null)}>
          Add Node
        </button>
        <button title="Show every node (F)" onClick={() => frameAll()}>
          Frame
        </button>
        <button class={showGlsl ? "active" : ""} aria-pressed={showGlsl} title="Show the GLSL this graph compiles to" onClick={() => setShowGlsl(!showGlsl)}>
          GLSL
        </button>
        <button title="Create a material that draws with this graph" disabled={readOnly} onClick={() => void createMaterialForGraph(path)}>
          New Material
        </button>
        <button aria-pressed={maximized} title={maximized ? "Back into the layout" : "Fill the window"} onClick={() => setMaximized(!maximized)}>
          {maximized ? "Restore" : "Maximize"}
        </button>
      </div>
      <div class="sg-body">
        <aside class="sg-side">
          <Blackboard
            graph={graph}
            images={images}
            readOnly={readOnly}
            commit={commit}
            placeNode={(name) => {
              const made = addNode(graph, "property", [toGraph(paneCenter(), view).x - 80, toGraph(paneCenter(), view).y], { property: name });
              commit(made.graph);
              setSelection(new Set([made.id]));
            }}
          />
          <div class="sg-preview-card">
            <div class="sg-preview-head">
              <span>Preview</span>
              <select aria-label="Preview mesh" value={mesh} onChange={(e) => setMesh((e.currentTarget as HTMLSelectElement).value as PreviewMesh)}>
                {(["sphere", "cube", "capsule", "plane"] as const).map((m) => (
                  <option key={m} value={m}>
                    {m[0].toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div class="sg-preview" ref={previewHost} aria-label="Shader preview" title="Drag to turn" />
          </div>
        </aside>
        <div class="sg-pane" ref={pane} onPointerDown={onPaneDown} onContextMenu={(e) => e.preventDefault()}>
          <div class="sg-viewport" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            <svg class="sg-wires">
              {graph.edges.map((e) => {
                if (e.to === detached) return null;
                const a = portPoint(e.from, "output"), b = portPoint(e.to, "input");
                if (!a || !b) return null;
                const d = wirePath(a, b);
                const t = compiled.portTypes[e.from] ?? "float";
                return (
                  <g key={e.to} class={`sg-wire ${cssType(t)}${selectedEdge === e.to ? " selected" : ""}`} data-edge={`${e.from}>${e.to}`}>
                    <path class="sg-wire-hit" d={d} onPointerDown={(ev) => { ev.stopPropagation(); root.current?.focus(); setSelection(new Set()); setSelectedEdge(e.to); }} />
                    <path class="sg-wire-line" d={d} />
                  </g>
                );
              })}
              {draft && <path class={`sg-draft${draft.valid ? " valid" : ""}`} d={wirePath(draft.from, draft.to)} />}
            </svg>
            {graph.nodes.map((n) => (
              <NodeView
                key={n.id}
                node={n}
                graph={graph}
                box={boxes.get(n.id)!}
                at={position(n)}
                selected={selection.has(n.id)}
                problems={compiled.nodeProblems[n.id]}
                dynamic={compiled.dynamicTypes[n.id] ?? "float"}
                portTypes={compiled.portTypes}
                connected={connectedInputs}
                flowId={flowId}
                images={images}
                readOnly={readOnly}
                onDown={onNodeDown}
                onPortDown={onPortDown}
                commit={commit}
                drag={{
                  pane: () => pane.current!,
                  nodes: () => live.current.nodes,
                  view: () => live.current.view,
                  panBy,
                  onMove: (m) => setDragging(new Map(m)),
                  onEnd: (m) => {
                    setDragging(null);
                    if (!readOnly) commit(moveNodes(live.current.graph, new Map([...m].map(([id, p]) => [id, [p.x, p.y] as [number, number]]))));
                  },
                }}
              />
            ))}
          </div>
          {box && <div class="sg-box" style={{ left: px(Math.min(box.a.x, box.b.x)), top: px(Math.min(box.a.y, box.b.y)), width: px(Math.abs(box.b.x - box.a.x)), height: px(Math.abs(box.b.y - box.a.y)) }} />}
          {search && <NodeSearch graph={graph} at={search.at} pending={search.pending} onPick={(type, settings) => addFromSearch(type, settings, search.at, search.pending)} onClose={closeSearch} />}
          {(problems.length > 0 || shaderError) && (
            <ul class="sg-problems" aria-label="Shader graph problems">
              {shaderError && <li class="error">WebGL couldn't compile the generated shader: {shaderError}</li>}
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {readOnly && <p class="sg-readonly">This project is read-only.</p>}
        </div>
        {showGlsl && <pre class="sg-glsl" aria-label="Generated GLSL">{shaderGraphListing(compiled)}</pre>}
      </div>
    </div>
  );
}

// --- nodes -------------------------------------------------------------------------------------------

interface DragHooks {
  pane(): HTMLElement;
  nodes(): readonly CanvasNode[];
  view(): View;
  panBy(dx: number, dy: number): Promise<boolean>;
  onMove(m: Map<string, Point>): void;
  onEnd(m: Map<string, Point>): void;
}

function NodeView(props: {
  node: GraphNode;
  graph: ShaderGraph;
  box: NodeBox;
  at: Point;
  selected: boolean;
  problems?: string[];
  dynamic: ValueType;
  portTypes: Record<string, ValueType>;
  connected: ReadonlySet<string>;
  flowId: string;
  images: string[];
  readOnly: boolean;
  onDown(e: PointerEvent, id: string): void;
  onPortDown(e: MouseEvent, node: GraphNode, port: PortDef, side: "input" | "output"): void;
  commit(g: ShaderGraph): void;
  drag: DragHooks;
}) {
  const { node, graph, box, at, dynamic } = props;
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef(props.drag);
  drag.current = props.drag;
  useEffect(() => {
    if (props.readOnly) return;
    const d = createNodeDrag(el.current!, node.id, {
      pane: drag.current.pane(),
      nodes: () => drag.current.nodes(),
      view: () => drag.current.view(),
      panBy: (x, y) => drag.current.panBy(x, y),
      onMove: (m) => drag.current.onMove(m),
      onEnd: (m) => drag.current.onEnd(m),
    });
    return () => d.destroy();
  }, [node.id, props.readOnly]);
  const def = nodeDef(node.type);
  const title = nodeTitle(node);
  return (
    <div
      ref={el}
      class={`sg-node ${NO_PAN}${props.selected ? " selected" : ""}${props.problems?.length ? " has-problem" : ""}${node.type === "output" ? " output" : ""}`}
      style={{ left: px(at.x), top: px(at.y), width: px(box.width), height: px(box.height) }}
      data-node={node.id}
      aria-label={`${title} node`}
      title={props.problems?.join("\n")}
      onPointerDown={(e) => props.onDown(e, node.id)}
    >
      <div class={`sg-node-header cat-${(def?.category ?? "Input").toLowerCase()}`} style={{ height: px(HEADER) }}>
        {title}
      </div>
      {box.rows.map((r, i) => {
        const top = HEADER + i * ROW;
        if (r.kind === "output") {
          const t = props.portTypes[portRef(node.id, r.port.id)] ?? "float";
          return (
            <div key={`o-${r.port.id}`} class="sg-row out" style={{ top: px(top), height: px(ROW) }}>
              <span class="sg-label">{r.port.label}</span>
              <span {...handleProps(props.flowId, node.id, r.port.id, "output")} class={`${handleProps(props.flowId, node.id, r.port.id, "output").class} sg-port ${cssType(t)}`} title={`${r.port.label} (${t})`} onMouseDown={(e) => props.onPortDown(e, node, r.port, "output")} />
            </div>
          );
        }
        if (r.kind === "input") {
          const ref = portRef(node.id, r.port.id);
          const connected = props.connected.has(ref);
          const t = r.port.type === "dynamic" ? dynamic : r.port.type;
          return (
            <div key={`i-${r.port.id}`} class={`sg-row in${connected ? " connected" : ""}`} style={{ top: px(top), height: px(ROW) }}>
              <span {...handleProps(props.flowId, node.id, r.port.id, "input")} class={`${handleProps(props.flowId, node.id, r.port.id, "input").class} sg-port ${cssType(t)}${connected ? " filled" : ""}`} title={`${r.port.label} (${t})`} onMouseDown={(e) => props.onPortDown(e, node, r.port, "input")} />
              <span class="sg-label">{r.port.label}</span>
              {!connected && <InlineValue node={node} port={r.port} dynamic={dynamic} readOnly={props.readOnly} onValue={(v) => props.commit(setInput(graph, node.id, r.port.id, v))} />}
            </div>
          );
        }
        return (
          <div key={`s-${r.setting.id}`} class="sg-row setting" style={{ top: px(top), height: px(ROW) }}>
            <SettingField node={node} setting={r.setting} graph={graph} images={props.images} readOnly={props.readOnly} onValue={(v) => props.commit(setSetting(graph, node.id, r.setting.id, v))} />
          </div>
        );
      })}
    </div>
  );
}

const numberValue = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
const toHex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
const rgbToHex = (v: readonly number[]) => `#${toHex2(v[0] ?? 1)}${toHex2(v[1] ?? 1)}${toHex2(v[2] ?? 1)}`;
const hexToRgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** An unconnected input's value: number fields, a colour picker for colour inputs, or the built-in it reads. */
function InlineValue(props: { node: GraphNode; port: PortDef; dynamic: ValueType; readOnly: boolean; onValue(v: InputValue): void }) {
  const { node, port, dynamic } = props;
  const label = `${nodeTitle(node)} ${port.label}`;
  if (port.bind) return <span class="sg-bind">{port.bind === "uv" ? "UV0" : port.bind.replace(/([A-Z])/g, " $1").toLowerCase()}</span>;
  if (port.type === "texture") return null;
  const value = node.inputs?.[port.id] ?? port.default ?? 0;
  if (port.color) {
    const rgb = Array.isArray(value) ? value : [value, value, value];
    return <input type="color" class={`sg-color ${NO_DRAG}`} aria-label={label} disabled={props.readOnly} value={rgbToHex(rgb)} onChange={(e) => props.onValue(hexToRgb((e.currentTarget as HTMLInputElement).value))} />;
  }
  const n = inlineFields(port, false, dynamic);
  const values = Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] ?? 0 : value));
  return (
    <span class="sg-fields">
      {values.map((v, i) => (
        <input
          key={i}
          type="number"
          step={0.1}
          class={`${NO_DRAG} ${NO_WHEEL}`}
          aria-label={n > 1 ? `${label} ${"XYZW"[i]}` : label}
          disabled={props.readOnly}
          value={+v.toFixed(4)}
          onChange={(e) => {
            const x = numberValue(e);
            if (!Number.isFinite(x)) return;
            if (n === 1) props.onValue(x);
            else props.onValue(values.map((old, j) => (j === i ? x : old)));
          }}
        />
      ))}
    </span>
  );
}

function SettingField(props: { node: GraphNode; setting: SettingDef; graph: ShaderGraph; images: string[]; readOnly: boolean; onValue(v: string): void }) {
  const { node, setting, graph } = props;
  const value = settingValue(node, setting);
  const label = `${nodeTitle(node)} ${setting.label}`;
  const select = (options: { value: string; label: string }[]) => (
    <select class={`${NO_DRAG} ${NO_WHEEL}`} aria-label={label} disabled={props.readOnly} value={value} onChange={(e) => props.onValue((e.currentTarget as HTMLSelectElement).value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  let field;
  if (setting.kind === "select") field = select((setting.options ?? []).map((o) => ({ value: o, label: o[0].toUpperCase() + o.slice(1) })));
  else if (setting.kind === "property") field = select([{ value: "", label: "(pick a property)" }, ...graph.properties.map((p) => ({ value: p.name, label: p.name }))]);
  else if (setting.kind === "texture")
    field = select([{ value: "", label: "White" }, ...props.images.map((f) => ({ value: `asset:${f}`, label: fileName(f) })), ...(value && !props.images.includes(value.replace(/^asset:/, "")) ? [{ value, label: `${value} (missing)` }] : [])]);
  else if (setting.kind === "color") field = <input type="color" class={NO_DRAG} aria-label={label} disabled={props.readOnly} value={value.slice(0, 7)} onChange={(e) => props.onValue((e.currentTarget as HTMLInputElement).value)} />;
  else field = <input type="text" class={NO_DRAG} aria-label={label} disabled={props.readOnly} value={value} onChange={(e) => props.onValue((e.currentTarget as HTMLInputElement).value)} />;
  return (
    <>
      <span class="sg-label">{setting.label}</span>
      {field}
    </>
  );
}

// --- node search -------------------------------------------------------------------------------------

interface SearchItem {
  key: string;
  type: string;
  title: string;
  category: string;
  words: string;
  settings?: Record<string, string>;
}

function NodeSearch(props: { graph: ShaderGraph; at: Point; pending: Pending; onPick(type: string, settings?: Record<string, string>): void; onClose(): void }) {
  const { graph, pending } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const all: SearchItem[] = useMemo(() => {
    const items: SearchItem[] = graph.properties.map((p) => ({ key: `property:${p.name}`, type: "property", title: p.name, category: "Properties", words: `${p.name} property ${p.type}`.toLowerCase(), settings: { property: p.name } }));
    for (const d of [...NODES].sort((a, b) => categoryRank(a.category) - categoryRank(b.category))) {
      if (d.type === "output" || d.type === "property") continue;
      items.push({ key: d.type, type: d.type, title: d.title, category: d.category, words: `${d.title} ${d.category} ${d.keywords ?? ""} ${d.type}`.toLowerCase() });
    }
    return items;
  }, [graph]);
  const fits = (item: SearchItem) => {
    if (!pending) return true;
    if (pending.side === "output") return firstInputFor(item.type, pending.type === "dynamic" ? "float" : pending.type, graph) !== null;
    return firstOutputFor(item.type, pending.type, graph, item.settings) !== null;
  };
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((i) => fits(i) && words.every((w) => i.words.includes(w)));
  const pick = (i: SearchItem | undefined) => i && props.onPick(i.type, i.settings);
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") setActive((a) => Math.min(shown.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") pick(shown[active]);
    else if (e.key === "Escape") props.onClose();
    else return;
    e.preventDefault();
  };
  let lastCategory = "";
  return (
    <div class={`sg-search ${NO_PAN} ${NO_WHEEL}`} style={{ left: px(props.at.x), top: px(props.at.y) }} role="dialog" aria-label="Add node" onPointerDown={(e) => e.stopPropagation()}>
      <input ref={input} type="search" placeholder="Search nodes" aria-label="Search nodes" value={query} onInput={(e) => (setQuery((e.currentTarget as HTMLInputElement).value), setActive(0))} onKeyDown={onKey} />
      <ul role="listbox">
        {shown.map((item, i) => {
          const head = item.category !== lastCategory;
          lastCategory = item.category;
          return (
            <>
              {head && <li class="sg-search-cat" role="presentation">{item.category}</li>}
              <li key={item.key} role="option" aria-selected={i === active} class={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => pick(item)}>
                {item.title}
              </li>
            </>
          );
        })}
        {shown.length === 0 && <li class="sg-search-none">No nodes match</li>}
      </ul>
    </div>
  );
}

// --- blackboard --------------------------------------------------------------------------------------

const PROPERTY_LABELS: Record<GraphPropertyType, string> = { float: "Float", vector2: "Vector 2", vector3: "Vector 3", vector4: "Vector 4", color: "Color", texture: "Texture" };

function Blackboard(props: { graph: ShaderGraph; images: string[]; readOnly: boolean; commit(g: ShaderGraph): void; placeNode(name: string): void }) {
  const { graph, readOnly, commit } = props;
  return (
    <div class="sg-blackboard" aria-label="Properties">
      <div class="sg-blackboard-head">
        <span>Properties</span>
        <select
          aria-label="Add property"
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
      {graph.properties.length === 0 && <p class="sg-hint">Properties are values each material sets. Add one, then place it in the graph.</p>}
      {graph.properties.map((p, i) => (
        <div key={p.name} class="sg-property" aria-label={`Property ${p.name}`}>
          <div class="sg-property-row">
            <input
              type="text"
              aria-label="Property name"
              disabled={readOnly}
              value={p.name}
              onChange={(e) => {
                const name = (e.currentTarget as HTMLInputElement).value;
                const why = whyNotPropertyName(graph, p.name, name);
                if (why) {
                  status.value = { kind: "error", text: `Can't rename ${p.name}: ${why}.` };
                  (e.currentTarget as HTMLInputElement).value = p.name;
                } else commit(renameProperty(graph, p.name, name));
              }}
            />
            <select aria-label={`${p.name} type`} disabled={readOnly} value={p.type} onChange={(e) => commit(setPropertyType(graph, p.name, (e.currentTarget as HTMLSelectElement).value as GraphPropertyType))}>
              {GRAPH_PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROPERTY_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div class="sg-property-row">
            <PropertyValue name={p.name} type={p.type} value={p.value} images={props.images} disabled={readOnly} onValue={(v) => commit(setPropertyValue(graph, p.name, v))} />
          </div>
          <div class="sg-property-row sg-property-actions">
            <button title="Place a node that reads this property" disabled={readOnly} onClick={() => props.placeNode(p.name)}>
              Place
            </button>
            <button title="Move up" aria-label={`Move ${p.name} up`} disabled={readOnly || i === 0} onClick={() => commit(moveProperty(graph, p.name, -1))}>
              ↑
            </button>
            <button title="Move down" aria-label={`Move ${p.name} down`} disabled={readOnly || i === graph.properties.length - 1} onClick={() => commit(moveProperty(graph, p.name, 1))}>
              ↓
            </button>
            <button class="danger" title="Remove the property and its nodes" aria-label={`Remove ${p.name}`} disabled={readOnly} onClick={() => commit(removeProperty(graph, p.name))}>
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A property value editor, shared by the Blackboard and the Material inspector. */
export function PropertyValue(props: { name: string; type: GraphPropertyType; value: GraphValue; images: string[]; disabled: boolean; onValue(v: GraphValue): void }) {
  const { name, type, value } = props;
  if (type === "texture") {
    const v = typeof value === "string" ? value : "";
    return (
      <select aria-label={`${name} value`} disabled={props.disabled} value={v} onChange={(e) => props.onValue((e.currentTarget as HTMLSelectElement).value)}>
        <option value="">White</option>
        {props.images.map((f) => (
          <option key={f} value={`asset:${f}`}>
            {f}
          </option>
        ))}
        {v && !props.images.includes(v.replace(/^asset:/, "")) && <option value={v}>{v} (missing)</option>}
      </select>
    );
  }
  if (type === "color") {
    const hex = typeof value === "string" ? value : "#ffffff";
    const a = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
    const withAlpha = (rgb: string, alpha: number) => (alpha >= 1 ? rgb : `${rgb}${toHex2(alpha)}`);
    return (
      <span class="sg-property-color">
        <input type="color" aria-label={`${name} value`} disabled={props.disabled} value={hex.slice(0, 7)} onChange={(e) => props.onValue(withAlpha((e.currentTarget as HTMLInputElement).value, a))} />
        <input type="number" min={0} max={1} step={0.05} aria-label={`${name} alpha`} disabled={props.disabled} value={+a.toFixed(3)} onChange={(e) => {
          const x = numberValue(e);
          if (Number.isFinite(x)) props.onValue(withAlpha(hex.slice(0, 7), Math.min(1, Math.max(0, x))));
        }} />
      </span>
    );
  }
  const n = propertySize(type);
  const values = n === 1 ? [typeof value === "number" ? value : 0] : Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] ?? 0 : 0));
  return (
    <span class="sg-fields">
      {values.map((v, i) => (
        <input key={i} type="number" step={0.1} aria-label={n > 1 ? `${name} ${"XYZW"[i]}` : `${name} value`} disabled={props.disabled} value={+v.toFixed(4)} onChange={(e) => {
          const x = numberValue(e);
          if (!Number.isFinite(x)) return;
          props.onValue(n === 1 ? x : values.map((old, j) => (j === i ? x : old)));
        }} />
      ))}
    </span>
  );
}
