import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MaterialPreview, NodePreviewRenderer, type PreviewMesh } from "../../engine/editor";
import { compileShaderGraph, nodePreviewGraph, shaderGraphListing, type CompiledShaderGraph } from "../../engine/render/shaderGraph/compile";
import { NODES, nodeDef, type PortDef, type SettingDef, type ValueType } from "../../engine/render/shaderGraph/nodes";
import { formatShaderGraph, GRAPH_PROPERTY_TYPES, isPortName, portRef, propertySize, splitPortRef, type CustomFunction, type FunctionPort, type GraphGroup, type GraphNode, type GraphPropertyType, type GraphValue, type InputValue, type ShaderGraph } from "../../engine/scene/shaderGraph";
import { assetKind, fileName } from "../assetBrowser";
import { errorStatus } from "../messages";
import type { EditorProject } from "../projects";
import {
  addNode,
  addNote,
  addProperty,
  addSubGraphOutput,
  copyNodes,
  defaultFunction,
  freePortName,
  groupNodes,
  pasteNodes,
  removeNote,
  removeSubGraphOutput,
  renameSubGraphOutput,
  setFunction,
  setGroupTitle,
  setPreview,
  setSubGraphOutputType,
  ungroup,
  updateNote,
  whyNotPortName,
  type GraphClipboard,
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
import { HEADER, PREVIEW, ROW, inlineFields, nodeBox, nodeTitle, portOffset, settingValue, type NodeBox } from "../shaderGraph/nodeLayout";
import { NO_DRAG, NO_PAN, NO_WHEEL, NoteView, NodeSearchPopup, Minimap, SelectionBox, createNodeDrag, handleProps, isFieldTarget, px, startBoxSelect, startConnection, startPointerDrag, toGraph, useGraphCanvas, wirePath, writeGraphClipboard, type CanvasNode, type DraftWire, type Point, type SearchItem, type View } from "../graph";
import { createMaterialForGraph, graphHistory, openShaderGraph, readShaderGraph, recordEdit, redoEdit, undoEdit, writeShaderGraph, createShaderGraph, openShaderGraphAsset } from "../shaderGraphAssets";
import { currentProject, docVersion, status } from "../state";
import { PropertyValue, numberValue, toHex2 } from "./ShaderPropertyValue";
import "../graph/graph.css";
import "./shaderGraph.css";

/** Nodes copied with Ctrl+C or cut with Ctrl+X, pasted into any graph (ADR 0048). */
let clipboard: GraphClipboard | null = null;

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

const cssType = (t: ValueType | "dynamic") => `t-${t === "dynamic" ? "float" : t}`;

function GraphEditor(props: { project: EditorProject; path: string }) {
  const { project, path } = props;
  const readOnly = !project.canSave;
  docVersion.value; // re-read the file when it changes on disk or elsewhere in the editor

  const [graph, setGraph] = useState<ShaderGraph>(() => readShaderGraph(project, path).graph);
  const [parseProblems, setParseProblems] = useState<string[]>(() => readShaderGraph(project, path).problems);
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

  const canvas = useGraphCanvas({
    viewKey: path,
    nodes: canvasNodes,
    onContextMenu: (e, at) => {
      if ((e.target as Element).closest(".sg-node")) return;
      e.preventDefault();
      openSearch(at, null);
    },
  });
  const { pane, paneApi, view, paneSize, panBy, paneCenter, frameAll } = canvas;

  // xyflow reads the latest state through these.
  const live = useRef({ graph, nodes: canvasNodes });
  live.current = { graph, nodes: canvasNodes };

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
    if (readOnly) return;
    const prev = undoEdit(path, live.current.graph);
    if (!prev) return;
    live.current.graph = prev;
    setGraph(prev);
    setHistoryTick((t) => t + 1);
    save(prev);
  };
  const redo = () => {
    if (readOnly) return;
    const next = redoEdit(path, live.current.graph);
    if (!next) return;
    live.current.graph = next;
    setGraph(next);
    setHistoryTick((t) => t + 1);
    save(next);
  };

  // --- canvas ----------------------------------------------------------------------------------------

  const openSearch = (at: Point, pending: Pending) => {
    if (readOnly) return;
    setSearch({ at, pending });
  };

  const connectOptions = (onConnect: (from: string, to: string) => void, onSpace: (at: Point) => void, onEnd: () => void = () => undefined) => ({
    flowId,
    pane: pane.current!,
    nodes: () => live.current.nodes,
    view: () => canvas.viewRef.current,
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
    if (e.button !== 0 || (e.target as Element).closest(".sg-node, .sg-search, .sg-wire-hit, .sg-note, .sg-group-head, .sg-minimap")) return;
    root.current?.focus({ preventScroll: true });
    setSearch(null);
    setSelectedEdge(null);
    startBoxSelect(e, { pane: pane.current!, view: () => canvas.viewRef.current, nodes: () => live.current.nodes, selection, onSelection: setSelection, onBox: setBox });
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

  const pasteHere = () => {
    if (!clipboard || readOnly) return;
    const at = toGraph(canvas.pointer.current ?? paneCenter(), canvas.viewRef.current);
    const made = pasteNodes(graph, clipboard, [at.x, at.y]);
    commit(made.graph);
    setSelection(new Set(made.ids));
  };

  const groupSelection = () => {
    if (selection.size === 0) return;
    commit(groupNodes(graph, selection).graph);
  };

  const addNoteHere = () => {
    const at = toGraph(paneCenter(), canvas.viewRef.current);
    commit(addNote(graph, [at.x - 100, at.y - 50]).graph);
  };

  /** Drag a group by its title: its nodes move together, as one undo step. */
  const startGroupDrag = (e: PointerEvent, group: GraphGroup) => {
    if (e.button !== 0 || readOnly || isFieldTarget(e.target)) return;
    const base = new Map(graph.nodes.filter((n) => group.nodes.includes(n.id)).map((n) => [n.id, { x: n.position[0], y: n.position[1] }]));
    const moved = (dx: number, dy: number) => new Map([...base].map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
    startPointerDrag(e, {
      zoom: () => canvas.viewRef.current.zoom,
      onMove: (dx, dy) => setDragging(moved(dx, dy)),
      onEnd: (dx, dy) => {
        setDragging(null);
        commit(moveNodes(live.current.graph, new Map([...moved(dx, dy)].map(([id, p]) => [id, [p.x, p.y] as [number, number]]))));
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isFieldTarget(e.target)) return;
    const key = (e.key ?? "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && key === "z" && !e.altKey) e.shiftKey ? redo() : undo();
    else if (mod && key === "y") redo();
    else if (mod && key === "d") {
      const made = duplicateNodes(graph, selection);
      commit(made.graph);
      setSelection(new Set(made.ids));
    } else if (mod && key === "a") setSelection(new Set(graph.nodes.map((n) => n.id)));
    else if (mod && (key === "c" || key === "x")) {
      const clip = copyNodes(graph, selection);
      if (clip) {
        clipboard = clip;
        writeGraphClipboard(clip);
        if (key === "x") {
          commit(removeNodes(graph, selection));
          setSelection(new Set());
        }
      }
    } else if (mod && key === "v") pasteHere();
    else if (mod && key === "g") groupSelection();
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
    const p = toGraph(at, canvas.viewRef.current);
    const made = addNode(graph, type, [p.x, p.y - HEADER], settings);
    let next = made.graph;
    if (type === "customFunction") next = setFunction(next, made.id, defaultFunction());
    if (pending?.side === "output") {
      const input = firstInputFor(type, pending.type === "dynamic" ? "float" : pending.type, next, settings);
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

  // Node previews (ADR 0048): one offscreen renderer draws each node's preview about ten times a second.
  const previewGraphs = useMemo(() => {
    const m = new Map<string, ShaderGraph>();
    for (const n of graph.nodes) {
      const g = n.preview === false ? null : nodePreviewGraph(graph, n.id);
      if (g) m.set(n.id, g);
    }
    return m;
  }, [codeKey]);
  const previewGraphsRef = useRef(previewGraphs);
  previewGraphsRef.current = previewGraphs;
  useEffect(() => {
    const renderer = new NodePreviewRenderer(PREVIEW - 8);
    const draw = () => {
      if (document.hidden || !pane.current) return;
      renderer.begin();
      for (const canvas of pane.current.querySelectorAll<HTMLCanvasElement>("canvas[data-preview]")) {
        const g = previewGraphsRef.current.get(canvas.dataset.preview!);
        if (g) canvas.classList.toggle("failed", !renderer.draw(g, canvas));
      }
      renderer.end();
    };
    draw();
    const timer = setInterval(draw, 100);
    return () => {
      clearInterval(timer);
      renderer.dispose();
    };
  }, []);

  // --- drawing ---------------------------------------------------------------------------------------

  const nodeById = new Map(canvasNodes.map((n) => [n.id, n]));
  const portPoint = (ref: string, side: "input" | "output"): Point | null => {
    const { node, port } = splitPortRef(ref);
    const n = nodeById.get(node);
    const p = n && (side === "input" ? n.inputs : n.outputs).find((q) => q.id === port);
    return n && p ? { x: n.x + p.x, y: n.y + p.y } : null;
  };

  const images = project.files.filter((f) => assetKind(f) === "image");
  const subgraphs = project.files.filter((f) => assetKind(f) === "shadersubgraph" && f !== path);
  const problems = [...parseProblems, ...compiled.problems];
  const sub = !!graph.subgraph;
  const selectedNode = selection.size === 1 ? graph.nodes.find((n) => selection.has(n.id)) : undefined;
  const groupRect = (g: GraphGroup) => {
    const members = canvasNodes.filter((n) => g.nodes.includes(n.id));
    if (members.length === 0) return null;
    const pad = 16, head = 28;
    const x0 = Math.min(...members.map((n) => n.x)) - pad, y0 = Math.min(...members.map((n) => n.y)) - pad - head;
    const x1 = Math.max(...members.map((n) => n.x + n.width)) + pad, y1 = Math.max(...members.map((n) => n.y + n.height)) + pad;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  return (
    <div class={`shader-graph${maximized ? " maximized" : ""}`} ref={root} tabIndex={0} onKeyDown={onKeyDown} aria-label="Shader Graph">
      <div class="sg-toolbar">
        <span class="sg-name" title={path}>
          {fileName(path)}
        </span>
        {sub && <span class="sg-kind">Sub Graph</span>}
        {!sub && (
          <>
        <label>
          Target{" "}
          <select aria-label="Target" disabled={readOnly} value={graph.target} onChange={(e) => commit(setGraphOptions(graph, { target: (e.currentTarget as HTMLSelectElement).value as ShaderGraph["target"] }))}>
            <option value="lit">Lit</option>
            <option value="physical">Physical</option>
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
          </>
        )}
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
        <button title="Put the selected nodes in a group (Ctrl+G)" disabled={readOnly || selection.size === 0} onClick={groupSelection}>
          Group
        </button>
        <button title="Add a sticky note" disabled={readOnly} onClick={addNoteHere}>
          Note
        </button>
        <button title="Show every node (F)" onClick={() => frameAll()}>
          Frame
        </button>
        <button class={showGlsl ? "active" : ""} aria-pressed={showGlsl} title="Show the GLSL this graph compiles to" onClick={() => setShowGlsl(!showGlsl)}>
          GLSL
        </button>
        {!sub && (
          <button title="Create a material that draws with this graph" disabled={readOnly} onClick={() => void createMaterialForGraph(path)}>
            New Material
          </button>
        )}
        <button aria-pressed={maximized} title={maximized ? "Back into the layout" : "Fill the window"} onClick={() => setMaximized(!maximized)}>
          {maximized ? "Restore" : "Maximize"}
        </button>
      </div>
      <div class="sg-body">
        <aside class="sg-side">
          <Blackboard
            sub={sub}
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
          {sub && <SubGraphOutputs graph={graph} readOnly={readOnly} commit={commit} />}
          {selectedNode?.type === "customFunction" && <FunctionEditor key={selectedNode.id} node={selectedNode} graph={graph} readOnly={readOnly} commit={commit} />}
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
        <div
          class="sg-pane"
          ref={pane}
          onPointerDown={onPaneDown}
          onPointerMove={canvas.onPointerMove}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div class="sg-viewport" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            {graph.groups?.map((g) => {
              const r = groupRect(g);
              if (!r) return null;
              return (
                <div key={g.id} class="sg-group" style={{ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) }} aria-label={`Group ${g.title}`}>
                  <div class={`sg-group-head ${NO_PAN}`} onPointerDown={(e) => startGroupDrag(e, g)}>
                    <input type="text" class={NO_DRAG} aria-label="Group title" disabled={readOnly} value={g.title} onChange={(e) => commit(setGroupTitle(graph, g.id, (e.currentTarget as HTMLInputElement).value))} />
                    <button title="Ungroup (the nodes stay)" aria-label={`Ungroup ${g.title}`} disabled={readOnly} onClick={() => commit(ungroup(graph, g.id))}>
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
            {graph.notes?.map((n) => (
              <NoteView key={n.id} note={n} zoom={view.zoom} readOnly={readOnly} onChange={(patch) => commit(updateNote(live.current.graph, n.id, patch))} onRemove={() => commit(removeNote(live.current.graph, n.id))} />
            ))}
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
                subgraphs={subgraphs}
                readOnly={readOnly}
                onDown={onNodeDown}
                onPortDown={onPortDown}
                commit={commit}
                drag={{
                  pane: () => pane.current!,
                  nodes: () => live.current.nodes,
                  view: () => canvas.viewRef.current,
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
          {box && <SelectionBox box={box} />}
          <Minimap nodes={canvasNodes} view={view} size={paneSize} pane={paneApi} />
          {search && <NodeSearch graph={graph} subgraphs={subgraphs} at={search.at} pending={search.pending} onPick={(type, settings) => addFromSearch(type, settings, search.at, search.pending)} onClose={closeSearch} />}
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
  subgraphs: string[];
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
        <span class="sg-node-title">{title}</span>
        {node.type !== "output" && node.type !== "property" && (box.previewTop !== null || node.preview === false) && (
          <button class={`sg-preview-toggle ${NO_DRAG}`} title={node.preview === false ? "Show the preview" : "Hide the preview"} aria-label={`${node.preview === false ? "Show" : "Hide"} ${title} preview`} disabled={props.readOnly} onClick={() => props.commit(setPreview(graph, node.id, node.preview === false))}>
            {node.preview === false ? "▸" : "▾"}
          </button>
        )}
      </div>
      {box.previewTop !== null && <canvas class="sg-node-preview" data-preview={node.id} width={PREVIEW - 8} height={PREVIEW - 8} style={{ top: px(box.previewTop), left: px((box.width - (PREVIEW - 8)) / 2) }} aria-label={`${title} preview`} />}
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
            <SettingField node={node} setting={r.setting} graph={graph} images={props.images} subgraphs={props.subgraphs} readOnly={props.readOnly} onValue={(v) => props.commit(setSetting(graph, node.id, r.setting.id, v))} />
          </div>
        );
      })}
    </div>
  );
}

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

function SettingField(props: { node: GraphNode; setting: SettingDef; graph: ShaderGraph; images: string[]; subgraphs: string[]; readOnly: boolean; onValue(v: string): void }) {
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
  else if (setting.kind === "subgraph")
    field = select([{ value: "", label: "(pick a sub-graph)" }, ...props.subgraphs.map((f) => ({ value: `asset:${f}`, label: fileName(f) })), ...(value && !props.subgraphs.includes(value.replace(/^asset:/, "")) ? [{ value, label: `${value} (missing)` }] : [])]);
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

interface NodeItem extends SearchItem {
  type: string;
  settings?: Record<string, string>;
}

function NodeSearch(props: { graph: ShaderGraph; subgraphs: string[]; at: Point; pending: Pending; onPick(type: string, settings?: Record<string, string>): void; onClose(): void }) {
  const { graph, pending } = props;
  const all: NodeItem[] = useMemo(() => {
    const items: NodeItem[] = graph.properties.map((p) => ({ key: `property:${p.name}`, type: "property", label: p.name, category: graph.subgraph ? "Inputs" : "Properties", keywords: `${p.name} property ${p.type}`, settings: { property: p.name } }));
    for (const f of props.subgraphs) {
      const name = fileName(f).replace(/\.shadersubgraph\.json$/i, "");
      items.push({ key: `subgraph:${f}`, type: "subgraph", label: name, category: "Sub Graphs", keywords: `${name} sub graph subgraph`, settings: { subgraph: `asset:${f}` } });
    }
    for (const d of [...NODES].sort((a, b) => categoryRank(a.category) - categoryRank(b.category))) {
      if (d.type === "output" || d.type === "property" || d.type === "subgraph") continue;
      items.push({ key: d.type, type: d.type, label: d.title, category: d.category, keywords: `${d.title} ${d.category} ${d.keywords ?? ""} ${d.type}` });
    }
    return items;
  }, [graph, props.subgraphs]);
  const fits = (item: NodeItem) => {
    if (!pending) return true;
    if (pending.side === "output") return firstInputFor(item.type, pending.type === "dynamic" ? "float" : pending.type, graph, item.settings) !== null;
    return firstOutputFor(item.type, pending.type, graph, item.settings) !== null;
  };
  const items = useMemo(() => all.filter(fits), [all, pending]);
  return <NodeSearchPopup items={items} at={props.at} onPick={(i) => props.onPick(i.type, i.settings)} onClose={props.onClose} />;
}

// --- blackboard --------------------------------------------------------------------------------------

const PROPERTY_LABELS: Record<GraphPropertyType, string> = { float: "Float", vector2: "Vector 2", vector3: "Vector 3", vector4: "Vector 4", color: "Color", texture: "Texture" };

function Blackboard(props: { sub: boolean; graph: ShaderGraph; images: string[]; readOnly: boolean; commit(g: ShaderGraph): void; placeNode(name: string): void }) {
  const { graph, readOnly, commit } = props;
  return (
    <div class="sg-blackboard" aria-label="Properties">
      <div class="sg-blackboard-head">
        <span>{props.sub ? "Inputs" : "Properties"}</span>
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
      {graph.properties.length === 0 && <p class="sg-hint">{props.sub ? "Inputs are the Sub Graph node's inputs. Add one, then place it in the graph." : "Properties are values each material sets. Add one, then place it in the graph."}</p>}
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
// --- sub-graph outputs and custom functions (ADR 0048) -------------------------------------------------

const PORT_TYPES: FunctionPort["type"][] = ["float", "vec2", "vec3", "vec4", "texture"];

/** A list of named, typed ports: a sub-graph's outputs or a custom function's inputs or outputs. */
function PortList(props: {
  title: string;
  ports: FunctionPort[];
  textures: boolean;
  readOnly: boolean;
  onAdd(): void;
  onRename(from: string, to: string): void;
  onType(name: string, type: FunctionPort["type"]): void;
  onRemove(name: string): void;
}) {
  return (
    <div class="sg-ports" aria-label={props.title}>
      <div class="sg-ports-head">
        <span>{props.title}</span>
        <button aria-label={`Add to ${props.title}`} title="Add a port" disabled={props.readOnly} onClick={props.onAdd}>
          +
        </button>
      </div>
      {props.ports.map((p) => (
        <div key={p.name} class="sg-property-row">
          <input
            type="text"
            aria-label={`${props.title} ${p.name} name`}
            disabled={props.readOnly}
            value={p.name}
            onChange={(e) => {
              const name = (e.currentTarget as HTMLInputElement).value;
              const why = whyNotPortName(name, props.ports.map((q) => q.name).filter((n) => n !== p.name));
              if (why) {
                status.value = { kind: "error", text: `Can't rename ${p.name}: ${why}.` };
                (e.currentTarget as HTMLInputElement).value = p.name;
              } else props.onRename(p.name, name);
            }}
          />
          <select aria-label={`${props.title} ${p.name} type`} disabled={props.readOnly} value={p.type} onChange={(e) => props.onType(p.name, (e.currentTarget as HTMLSelectElement).value as FunctionPort["type"])}>
            {PORT_TYPES.filter((t) => props.textures || t !== "texture").map((t) => (
              <option key={t} value={t}>
                {t === "texture" ? "Texture" : t}
              </option>
            ))}
          </select>
          <button class="danger" aria-label={`Remove ${p.name}`} title="Remove" disabled={props.readOnly} onClick={() => props.onRemove(p.name)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** A sub-graph's outputs: the Sub Graph node's outputs, and its output node's ports. */
function SubGraphOutputs(props: { graph: ShaderGraph; readOnly: boolean; commit(g: ShaderGraph): void }) {
  const { graph, commit } = props;
  return (
    <div class="sg-side-card">
      <PortList
        title="Outputs"
        ports={graph.subgraph!.outputs}
        textures
        readOnly={props.readOnly}
        onAdd={() => commit(addSubGraphOutput(graph))}
        onRename={(a, b) => commit(renameSubGraphOutput(graph, a, b))}
        onType={(n, t) => commit(setSubGraphOutputType(graph, n, t))}
        onRemove={(n) => commit(removeSubGraphOutput(graph, n))}
      />
    </div>
  );
}

/** The selected Custom Function node's name, ports and GLSL body. */
function FunctionEditor(props: { node: GraphNode; graph: ShaderGraph; readOnly: boolean; commit(g: ShaderGraph): void }) {
  const { node, graph, commit } = props;
  const f: CustomFunction = node.function ?? defaultFunction();
  const set = (next: CustomFunction, renamed?: Record<string, string>) => commit(setFunction(graph, node.id, next, renamed));
  const side = (key: "inputs" | "outputs", title: string) => (
    <PortList
      title={title}
      ports={f[key]}
      textures={key === "inputs"}
      readOnly={props.readOnly}
      onAdd={() => set({ ...f, [key]: [...f[key], { name: freePortName([...f.inputs, ...f.outputs].map((p) => p.name), key === "inputs" ? "In" : "Out"), type: "float" }] })}
      onRename={(a, b) => set({ ...f, [key]: f[key].map((p) => (p.name === a ? { ...p, name: b } : p)) }, { [a]: b })}
      onType={(n, t) => set({ ...f, [key]: f[key].map((p) => (p.name === n ? { ...p, type: t } : p)) })}
      onRemove={(n) => set({ ...f, [key]: f[key].filter((p) => p.name !== n) })}
    />
  );
  return (
    <div class="sg-side-card sg-function" aria-label="Custom Function">
      <div class="sg-blackboard-head">
        <span>Custom Function</span>
      </div>
      <label class="sg-property-row">
        <span>Name</span>
        <input
          type="text"
          aria-label="Function name"
          disabled={props.readOnly}
          value={f.name}
          onChange={(e) => {
            const name = (e.currentTarget as HTMLInputElement).value;
            if (isPortName(name)) set({ ...f, name });
            else {
              status.value = { kind: "error", text: `"${name}" isn't a GLSL function name (letters, digits and _, not starting with a digit).` };
              (e.currentTarget as HTMLInputElement).value = f.name;
            }
          }}
        />
      </label>
      {side("inputs", "Inputs")}
      {side("outputs", "Outputs")}
      <textarea class="sg-function-body" aria-label="Function body" spellcheck={false} disabled={props.readOnly} value={f.body} onChange={(e) => set({ ...f, body: (e.currentTarget as HTMLTextAreaElement).value })} />
      <p class="sg-hint">GLSL ES 3.0. Assign every output; inputs and outputs are named as above. uMycoTime is the time in seconds.</p>
      <label class="sg-property-row sg-wgsl-label">
        <span>WGSL body</span>
      </label>
      <textarea
        class="sg-function-body sg-function-wgsl"
        aria-label="WGSL body"
        spellcheck={false}
        disabled={props.readOnly}
        placeholder="Out = In;"
        value={f.wgsl ?? ""}
        onChange={(e) => set({ ...f, wgsl: (e.currentTarget as HTMLTextAreaElement).value })}
      />
      {!f.wgsl?.trim() && <p class="sg-hint">Needed on WebGPU (Babylon backend); without it the node outputs its defaults.</p>}
    </div>
  );
}
